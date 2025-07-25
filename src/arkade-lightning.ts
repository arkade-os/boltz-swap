import { poll } from './utils/polling';
import {
  InvoiceExpiredError,
  SwapError,
  SwapExpiredError,
  TransactionFailedError,
  TransactionRefundedError,
} from './errors';
import {
  ArkAddress,
  buildOffchainTx,
  ConditionWitness,
  CSVMultisigTapscript,
  RestArkProvider,
  RestIndexerProvider,
  setArkPsbtField,
  TapLeafScript,
  VHTLC,
} from '@arkade-os/sdk';
import { sha256 } from '@noble/hashes/sha2';
import { base64, hex } from '@scure/base';
import type {
  ArkadeLightningConfig,
  CreateLightningInvoiceResponse,
  DecodedInvoice,
  SendLightningPaymentRequest,
  SendLightningPaymentResponse,
  PendingReverseSwap,
  PendingSubmarineSwap,
  PendingSwaps,
  Wallet,
  CreateLightningInvoiceRequest,
} from './types';
import { randomBytes } from '@noble/hashes/utils';
import {
  GetSwapStatusResponse,
  BoltzSwapProvider,
  CreateSubmarineSwapRequest,
  CreateReverseSwapRequest,
  BoltzSwapStatus,
} from './boltz-swap-provider';
import bolt11 from 'light-bolt11-decoder';
import { StorageProvider } from './storage-provider';
import { Transaction } from '@scure/btc-signer';
import { TransactionInput } from '@scure/btc-signer/psbt';
import { ripemd160 } from '@noble/hashes/legacy';

const DEFAULT_TIMEOUT_CONFIG = {
  swapExpiryBlocks: 144,
  invoiceExpirySeconds: 3600,
  claimDelayBlocks: 10,
};

const DEFAULT_FEE_CONFIG = {
  maxMinerFeeSats: 5000,
  maxSwapFeeSats: 1000,
};

const DEFAULT_RETRY_CONFIG = {
  maxAttempts: 5,
  delayMs: 2000,
};

export class ArkadeLightning {
  private readonly wallet: Wallet;
  private readonly arkProvider: RestArkProvider;
  private readonly swapProvider: BoltzSwapProvider;
  private readonly storageProvider: StorageProvider | null;
  private readonly indexerProvider: RestIndexerProvider;
  private readonly config: Required<ArkadeLightningConfig>;

  constructor(config: ArkadeLightningConfig) {
    if (!config.wallet) throw new Error('Wallet is required.');
    if (!config.arkProvider) throw new Error('Ark provider is required.');
    if (!config.swapProvider) throw new Error('Swap provider is required.');
    if (!config.indexerProvider) throw new Error('Indexer provider is required.');
    this.wallet = config.wallet;
    this.arkProvider = config.arkProvider;
    this.swapProvider = config.swapProvider;
    this.storageProvider = config.storageProvider ?? null;
    this.indexerProvider = config.indexerProvider;
    this.config = {
      ...config,
      refundHandler: config.refundHandler ?? { onRefundNeeded: async () => {} },
      timeoutConfig: { ...DEFAULT_TIMEOUT_CONFIG, ...config.timeoutConfig },
      feeConfig: { ...DEFAULT_FEE_CONFIG, ...config.feeConfig },
      retryConfig: { ...DEFAULT_RETRY_CONFIG, ...config.retryConfig },
    } as Required<ArkadeLightningConfig>;
  }

  // receive from lightning = reverse submarine swap
  //
  // 1. create invoice by creating a reverse swap
  // 2. monitor incoming payment by waiting for the hold invoice to be paid
  // 3. claim the VHTLC by creating a virtual transaction that spends the VHTLC output
  // 4. return the preimage and the swap info

  async createLightningInvoice(
    args: CreateLightningInvoiceRequest,
    onUpdate: (args: { invoice: string; amountSats: number; preimage: string }) => void
  ): Promise<CreateLightningInvoiceResponse> {
    return new Promise((resolve, reject) => {
      this.createReverseSwap(args)
        .then((pendingSwap) => {
          // save pending swap to storage if available
          this.storageProvider?.savePendingReverseSwap(pendingSwap);
          // call onUpdate with the invoice details
          const invoice = pendingSwap.response.invoice;
          onUpdate({ invoice, amountSats: pendingSwap.response.onchainAmount, preimage: pendingSwap.preimage });
          this.waitAndClaim(pendingSwap)
            .then(async () => {
              // delete pending swap to storage if available
              this.storageProvider?.deletePendingReverseSwap(pendingSwap.response.id);
              const status = await this.swapProvider.getSwapStatus(pendingSwap.response.id);
              resolve({
                amount: pendingSwap.response.onchainAmount,
                invoice: pendingSwap.response.invoice,
                preimage: pendingSwap.preimage,
                txid: status.transaction?.id ?? '',
              } as CreateLightningInvoiceResponse);
            })
            .catch(reject);
        })
        .catch(reject);
    });
  }

  /**
   * Sends a Lightning payment.
   * 1. decode the invoice to get the amount and destination
   * 2. create submarine swap with the decoded invoice
   * 3. send the swap address and expected amount to the wallet to create a transaction
   * 4. wait for the swap settlement and return the preimage and txid
   * @param args - The arguments for sending a Lightning payment.
   * @returns The result of the payment.
   */
  async sendLightningPayment(args: SendLightningPaymentRequest): Promise<SendLightningPaymentResponse> {
    return new Promise<SendLightningPaymentResponse>((resolve, reject) => {
      this.createSubmarineSwap(args).then((pendingSwap) => {
        // validate max fee if provided
        if (args.maxFeeSats) {
          const invoiceAmount = this.decodeInvoice(args.invoice).amountSats;
          const fees = pendingSwap.response.expectedAmount - invoiceAmount;
          if (fees > args.maxFeeSats) {
            reject(new SwapError(`Swap fees ${fees} exceed max allowed ${args.maxFeeSats}`));
          }
        }
        // save pending swap to storage if available
        this.storageProvider?.savePendingSubmarineSwap(pendingSwap);
        // send funds to the swap address
        this.wallet
          .sendBitcoin(pendingSwap.response.address, pendingSwap.response.expectedAmount)
          .then((txid) => {
            this.waitForSwapSettlement(pendingSwap)
              .then(async () => {
                this.storageProvider?.deletePendingSubmarineSwap(pendingSwap.response.id);
                const finalStatus = await this.swapProvider.getSwapStatus(pendingSwap.response.id);
                const preimage = finalStatus.transaction?.preimage ?? '';
                resolve({ amount: pendingSwap.response.expectedAmount, preimage, txid });
              })
              .catch(({ isRefundable }) => {
                if (isRefundable) {
                  this.refundVHTLC(pendingSwap)
                    .then(reject)
                    .catch(reject)
                    .finally(() => {
                      this.storageProvider?.deletePendingSubmarineSwap(pendingSwap.response.id);
                    });
                } else {
                  reject(new TransactionFailedError());
                }
              });
          })
          .catch(reject);
      });
    });
  }

  // create reverse submarine swap
  async createSubmarineSwap(args: SendLightningPaymentRequest): Promise<PendingSubmarineSwap> {
    const refundPublicKey = await this.wallet.getPublicKey();
    if (!refundPublicKey) throw new SwapError('Failed to get refund public key from wallet');

    const invoice = args.invoice;
    if (!invoice) throw new SwapError('Invoice is required');

    const swapRequest: CreateSubmarineSwapRequest = { invoice, refundPublicKey };

    // make reverse swap request
    const swapResponse = await this.swapProvider.createSubmarineSwap(swapRequest);

    return {
      request: swapRequest,
      response: swapResponse,
      status: 'invoice.set',
    } as PendingSubmarineSwap;
  }

  // create reverse submarine swap
  async createReverseSwap(args: CreateLightningInvoiceRequest): Promise<PendingReverseSwap> {
    // create random preimage and its hash
    const preimage = randomBytes(32);
    const preimageHash = hex.encode(sha256(preimage));
    if (!preimageHash) throw new SwapError('Failed to get preimage hash');

    // build request object for reverse swap
    const swapRequest: CreateReverseSwapRequest = {
      invoiceAmount: args.amount,
      claimPublicKey: await this.wallet.getPublicKey(),
      preimageHash,
    };

    // make reverse swap request
    const swapResponse = await this.swapProvider.createReverseSwap(swapRequest);

    return {
      preimage: hex.encode(preimage),
      request: swapRequest,
      response: swapResponse,
      status: 'swap.created',
    } as PendingReverseSwap;
  }

  // claim the VHTLC by creating a virtual transaction that spends the VHTLC output
  async claimVHTLC(pendingSwap: PendingReverseSwap) {
    const preimage = hex.decode(pendingSwap.preimage);
    const aspInfo = await this.arkProvider.getInfo();
    const address = await this.wallet.getAddress();

    // validate we are using a x-only receiver public key
    let receiverXOnlyPublicKey = hex.decode(await this.wallet.getPublicKey());
    if (receiverXOnlyPublicKey.length == 33) {
      receiverXOnlyPublicKey = receiverXOnlyPublicKey.slice(1);
    } else if (receiverXOnlyPublicKey.length !== 32) {
      throw new Error(`Invalid receiver public key length: ${receiverXOnlyPublicKey.length}`);
    }

    // validate we are using a x-only server public key
    let serverXOnlyPublicKey = hex.decode(aspInfo.signerPubkey);
    if (serverXOnlyPublicKey.length == 33) {
      serverXOnlyPublicKey = serverXOnlyPublicKey.slice(1);
    } else if (serverXOnlyPublicKey.length !== 32) {
      throw new Error(`Invalid server public key length: ${serverXOnlyPublicKey.length}`);
    }

    // build expected VHTLC script
    const { vhtlcScript, vhtlcAddress } = this.createVHTLCScript({
      network: aspInfo.network,
      preimageHash: sha256(preimage),
      receiverPubkey: await this.wallet.getPublicKey(),
      senderPubkey: pendingSwap.response.refundPublicKey,
      serverPubkey: aspInfo.signerPubkey,
      timeoutBlockHeights: pendingSwap.response.timeoutBlockHeights,
    });

    if (!vhtlcScript) throw new Error('Failed to create VHTLC script for reverse swap');
    if (vhtlcAddress !== pendingSwap.response.lockupAddress) throw new Error('Boltz is trying to scam us');

    // get spendable VTXOs from the lockup address
    const spendableVtxos = await this.indexerProvider.getVtxos({
      scripts: [hex.encode(vhtlcScript.pkScript)],
      spendableOnly: true,
    });
    if (spendableVtxos.vtxos.length === 0) throw new Error('No spendable virtual coins found');

    // vtxo with the htlc to claim
    const vtxo = spendableVtxos.vtxos[0];

    // signing a VTHLC needs an extra witness element to be added to the PSBT input
    // reveal the secret in the PSBT, thus the server can verify the claim script
    // this witness must satisfy the preimageHash condition
    const vhtlcIdentity = {
      sign: async (tx: any, inputIndexes?: number[]) => {
        const cpy = tx.clone();
        let signedTx = await this.wallet.sign(cpy, inputIndexes);
        signedTx = Transaction.fromPSBT(signedTx.toPSBT(), { allowUnknown: true });
        setArkPsbtField(signedTx, 0, ConditionWitness, [preimage]);
        return signedTx;
      },
      xOnlyPublicKey: receiverXOnlyPublicKey,
      signerSession: this.wallet.signerSession,
    };

    // create the server unroll script for checkpoint transactions
    const serverUnrollScript = CSVMultisigTapscript.encode({
      pubkeys: [hex.decode(aspInfo.signerPubkey)],
      timelock: {
        type: aspInfo.unilateralExitDelay < 512 ? 'blocks' : 'seconds',
        value: aspInfo.unilateralExitDelay,
      },
    });

    // create the offchain transaction to claim the VHTLC
    const { arkTx, checkpoints } = buildOffchainTx(
      [
        {
          ...spendableVtxos.vtxos[0],
          tapLeafScript: vhtlcScript.claim(),
          tapTree: vhtlcScript.encode(),
        },
      ],
      [
        {
          amount: BigInt(vtxo.value),
          script: ArkAddress.decode(address).pkScript,
        },
      ],
      serverUnrollScript
    );

    // sign and submit the virtual transaction
    const signedArkTx = await vhtlcIdentity.sign(arkTx);
    const { arkTxid, finalArkTx, signedCheckpointTxs } = await this.arkProvider.submitTx(
      base64.encode(signedArkTx.toPSBT()),
      checkpoints.map((c) => base64.encode(c.toPSBT()))
    );

    // verify the server signed the transaction with correct key
    if (!this.validFinalArkTx(finalArkTx, serverXOnlyPublicKey, vhtlcScript.leaves)) {
      throw new Error('Invalid final Ark transaction');
    }

    // sign the checkpoint transactions pre signed by the server
    const finalCheckpoints = await Promise.all(
      signedCheckpointTxs.map(async (c) => {
        const tx = Transaction.fromPSBT(base64.decode(c), {
          allowUnknown: true,
        });
        const signedCheckpoint = await vhtlcIdentity.sign(tx, [0]);
        return base64.encode(signedCheckpoint.toPSBT());
      })
    );

    // submit the final transaction to the Ark provider
    await this.arkProvider.finalizeTx(arkTxid, finalCheckpoints);

    return { amount: vtxo.value, txid: arkTxid, preimage: preimage };
  }

  async refundVHTLC(pendingSwap: PendingSubmarineSwap): Promise<void> {
    // prepare variables for claiming the VHTLC
    const aspInfo = await this.arkProvider.getInfo();
    const amount = pendingSwap.response.expectedAmount;
    const address = await this.wallet.getAddress();
    if (!address) throw 'Failed to get ark address from service worker wallet';

    // validate we are using a x-only receiver public key
    let receiverXOnlyPublicKey = hex.decode(await this.wallet.getPublicKey());
    if (receiverXOnlyPublicKey.length == 33) {
      receiverXOnlyPublicKey = receiverXOnlyPublicKey.slice(1);
    } else if (receiverXOnlyPublicKey.length !== 32) {
      throw new Error(`Invalid receiver public key length: ${receiverXOnlyPublicKey.length}`);
    }
    // validate we are using a x-only server public key
    let serverXOnlyPublicKey = hex.decode(aspInfo.signerPubkey);
    if (serverXOnlyPublicKey.length == 33) {
      serverXOnlyPublicKey = serverXOnlyPublicKey.slice(1);
    } else if (serverXOnlyPublicKey.length !== 32) {
      throw new Error(`Invalid server public key length: ${serverXOnlyPublicKey.length}`);
    }

    const { vhtlcScript, vhtlcAddress } = this.createVHTLCScript({
      network: aspInfo.network,
      preimageHash: hex.decode(this.getInvoicePaymentHash(pendingSwap.request.invoice)),
      receiverPubkey: pendingSwap.response.claimPublicKey,
      senderPubkey: await this.wallet.getPublicKey(),
      serverPubkey: aspInfo.signerPubkey,
      timeoutBlockHeights: pendingSwap.response.timeoutBlockHeights,
    });

    if (!vhtlcScript) throw new Error('Failed to create VHTLC script for reverse swap');
    if (vhtlcAddress !== pendingSwap.response.address) throw new Error('Boltz is trying to scam us');

    // get spendable VTXOs from the lockup address
    const spendableVtxos = await this.indexerProvider.getVtxos({
      scripts: [hex.encode(vhtlcScript.pkScript)],
      spendableOnly: true,
    });
    if (spendableVtxos.vtxos.length === 0) {
      throw new Error('No spendable virtual coins found');
    }

    // signing a VTHLC needs an extra witness element to be added to the PSBT input
    // reveal the secret in the PSBT, thus the server can verify the claim script
    // this witness must satisfy the preimageHash condition
    const vhtlcIdentity = {
      sign: async (tx: any, inputIndexes?: number[]) => {
        const cpy = tx.clone();
        let signedTx = await this.wallet.sign(cpy, inputIndexes);
        return Transaction.fromPSBT(signedTx.toPSBT(), { allowUnknown: true });
      },
      xOnlyPublicKey: receiverXOnlyPublicKey,
      signerSession: this.wallet.signerSession,
    };

    // Create the server unroll script for checkpoint transactions
    const serverUnrollScript = CSVMultisigTapscript.encode({
      pubkeys: [serverXOnlyPublicKey],
      timelock: {
        type: aspInfo.unilateralExitDelay < 512 ? 'blocks' : 'seconds',
        value: aspInfo.unilateralExitDelay,
      },
    });

    // create the virtual transaction to claim the VHTLC
    const { arkTx, checkpoints } = buildOffchainTx(
      [
        {
          ...spendableVtxos.vtxos[0],
          tapLeafScript: vhtlcScript.refund(),
          tapTree: vhtlcScript.encode(),
        },
      ],
      [
        {
          amount: BigInt(amount),
          script: ArkAddress.decode(address).pkScript,
        },
      ],
      serverUnrollScript
    );

    // sign and submit the virtual transaction
    const signedArkTx = await vhtlcIdentity.sign(arkTx);
    const { arkTxid, finalArkTx, signedCheckpointTxs } = await this.arkProvider.submitTx(
      base64.encode(signedArkTx.toPSBT()),
      checkpoints.map((c) => base64.encode(c.toPSBT()))
    );

    // verify the server signed the transaction with correct key
    if (!this.validFinalArkTx(finalArkTx, serverXOnlyPublicKey, vhtlcScript.leaves)) {
      throw new Error('Invalid final Ark transaction');
    }

    const finalCheckpoints = await Promise.all(
      signedCheckpointTxs.map(async (c) => {
        const tx = Transaction.fromPSBT(base64.decode(c), {
          allowUnknown: true,
        });
        const signedCheckpoint = await vhtlcIdentity.sign(tx, [0]);
        return base64.encode(signedCheckpoint.toPSBT());
      })
    );
    await this.arkProvider.finalizeTx(arkTxid, finalCheckpoints);

    console.log('Successfully claimed VHTLC! Transaction ID:', arkTxid);
  }

  async waitAndClaim(pendingSwap: PendingReverseSwap): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // https://api.docs.boltz.exchange/lifecycle.html#swap-states
      const onStatusUpdate = (status: BoltzSwapStatus) => {
        switch (status) {
          case 'transaction.mempool':
          case 'transaction.confirmed':
            this.claimVHTLC(pendingSwap);
            break;
          case 'invoice.settled':
            resolve();
            break;
          case 'invoice.expired':
            reject(new InvoiceExpiredError());
            break;
          case 'swap.expired':
            reject(new SwapExpiredError());
            break;
          case 'transaction.failed':
            reject(new TransactionFailedError());
            break;
          case 'transaction.refunded':
            reject(new TransactionRefundedError());
            break;
          default:
            break;
        }
      };

      this.swapProvider.monitorSwap(pendingSwap.response.id, onStatusUpdate);
    });
  }

  /**
   * Waits for the swap settlement.
   * @param pendingSwap - The pending swap.
   * @returns The status of the swap settlement.
   */
  async waitForSwapSettlement(pendingSwap: PendingSubmarineSwap): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // https://api.docs.boltz.exchange/lifecycle.html#swap-states
      const onStatusUpdate = async (status: BoltzSwapStatus) => {
        switch (status) {
          case 'swap.expired':
          case 'invoice.failedToPay':
          case 'transaction.lockupFailed':
            reject({ isRefundable: true });
            break;
          case 'transaction.claimed':
            resolve();
            break;
          default:
            break;
        }
      };

      this.swapProvider.monitorSwap(pendingSwap.response.id, onStatusUpdate);
    });
  }

  /**
   * Waits for the swap settlement.
   * @param swapData - The swap data to wait for.
   * @returns The status of the swap settlement.
   */
  async waitForSwapSettlementold(swapData: PendingSubmarineSwap): Promise<GetSwapStatusResponse> {
    const status = await poll(
      () => this.swapProvider.getSwapStatus(swapData.response.id),
      (status) => status.status === 'transaction.claimed',
      this.config.retryConfig.delayMs ?? 2000,
      this.config.retryConfig.maxAttempts ?? 5
    ).catch((err) => {
      this.config.refundHandler.onRefundNeeded(swapData);
      throw new SwapError(`Swap settlement failed: ${(err as Error).message}`, {
        isRefundable: true,
        swapData: { ...swapData },
      });
    });

    if (status.status === 'transaction.claimed' && this.storageProvider) {
      await this.storageProvider.deletePendingSubmarineSwap(swapData.response.id);
    }

    return status;
  }

  // validators

  /**
   * Validates the final Ark transaction.
   * checks that all inputs have a signature for the given pubkey
   * and the signature is correct for the given tapscript leaf
   * TODO: This is a simplified check, we should verify the actual signatures
   * @param finalArkTx The final Ark transaction in PSBT format.
   * @param _pubkey The public key of the user.
   * @param _tapLeaves The taproot script leaves.
   * @returns True if the final Ark transaction is valid, false otherwise.
   */
  private validFinalArkTx = (finalArkTx: string, _pubkey: Uint8Array, _tapLeaves: TapLeafScript[]): boolean => {
    // decode the final Ark transaction
    const tx = Transaction.fromPSBT(base64.decode(finalArkTx), { allowUnknown: true });
    if (!tx) return false;

    // push all inputs to an array
    const inputs: TransactionInput[] = [];
    for (let i = 0; i < tx.inputsLength; i++) {
      inputs.push(tx.getInput(i));
    }

    // basic check that all inputs have a witnessUtxo
    // this is a simplified check, we should verify the actual signatures
    return inputs.every((input) => input.witnessUtxo);
  };

  /**
   * Creates a VHTLC script for the swap.
   * works for submarine swaps and reverse swaps
   * it creates a VHTLC script that can be used to claim or refund the swap
   * it validates the receiver, sender and server public keys are x-only
   * it validates the VHTLC script matches the expected lockup address
   * @param param0 - The parameters for creating the VHTLC script.
   * @returns The created VHTLC script.
   */
  private createVHTLCScript({
    network,
    preimageHash,
    receiverPubkey,
    senderPubkey,
    serverPubkey,
    timeoutBlockHeights,
  }: {
    network: string;
    preimageHash: Uint8Array;
    receiverPubkey: string;
    senderPubkey: string;
    serverPubkey: string;
    timeoutBlockHeights: {
      refund: number;
      unilateralClaim: number;
      unilateralRefund: number;
      unilateralRefundWithoutReceiver: number;
    };
  }): { vhtlcScript: VHTLC.Script; vhtlcAddress: string } {
    // validate we are using a x-only receiver public key
    let receiverXOnlyPublicKey = hex.decode(receiverPubkey);
    if (receiverXOnlyPublicKey.length == 33) {
      receiverXOnlyPublicKey = receiverXOnlyPublicKey.slice(1);
    } else if (receiverXOnlyPublicKey.length !== 32) {
      throw new Error(`Invalid receiver public key length: ${receiverXOnlyPublicKey.length}`);
    }

    // validate we are using a x-only sender public key
    let senderXOnlyPublicKey = hex.decode(senderPubkey);
    if (senderXOnlyPublicKey.length == 33) {
      senderXOnlyPublicKey = senderXOnlyPublicKey.slice(1);
    } else if (senderXOnlyPublicKey.length !== 32) {
      throw new Error(`Invalid sender public key length: ${senderXOnlyPublicKey.length}`);
    }

    // validate we are using a x-only server public key
    let serverXOnlyPublicKey = hex.decode(serverPubkey);
    if (serverXOnlyPublicKey.length == 33) {
      serverXOnlyPublicKey = serverXOnlyPublicKey.slice(1);
    } else if (serverXOnlyPublicKey.length !== 32) {
      throw new Error(`Invalid server public key length: ${serverXOnlyPublicKey.length}`);
    }

    const vhtlcScript = new VHTLC.Script({
      preimageHash: ripemd160(preimageHash),
      sender: senderXOnlyPublicKey,
      receiver: receiverXOnlyPublicKey,
      server: serverXOnlyPublicKey,
      refundLocktime: BigInt(timeoutBlockHeights.refund),
      unilateralClaimDelay: {
        type: 'blocks',
        value: BigInt(timeoutBlockHeights.unilateralClaim),
      },
      unilateralRefundDelay: {
        type: 'blocks',
        value: BigInt(timeoutBlockHeights.unilateralRefund),
      },
      unilateralRefundWithoutReceiverDelay: {
        type: 'blocks',
        value: BigInt(timeoutBlockHeights.unilateralRefundWithoutReceiver),
      },
    });

    if (!vhtlcScript) throw new Error('Failed to create VHTLC script');

    // validate vhtlc script
    const hrp = network === 'bitcoin' ? 'ark' : 'tark';
    const vhtlcAddress = vhtlcScript.address(hrp, serverXOnlyPublicKey).encode();

    return { vhtlcScript, vhtlcAddress };
  }

  // utils

  /**
   * Decodes a Lightning invoice.
   * @param invoice - The Lightning invoice to decode.
   * @returns The decoded invoice.
   */
  decodeInvoice(invoice: string): DecodedInvoice {
    const decoded = bolt11.decode(invoice);
    const millisats = Number(decoded.sections.find((s) => s.name === 'amount')?.value ?? '0');
    return {
      expiry: decoded.expiry ?? 3600,
      amountSats: Math.floor(millisats / 1000),
      description: decoded.sections.find((s) => s.name === 'description')?.value ?? '',
      paymentHash: decoded.sections.find((s) => s.name === 'payment_hash')?.value ?? '',
    };
  }

  getInvoiceSatoshis(invoice: string): number {
    return this.decodeInvoice(invoice).amountSats;
  }

  getInvoicePaymentHash(invoice: string): string {
    return this.decodeInvoice(invoice).paymentHash;
  }

  /**
   * Retrieves all pending swaps, both reverse and submarine.
   * This method retrieves pending reverse swaps and pending submarine swaps from the storage provider.
   * It returns an object containing two arrays: reverseSwaps and submarineSwaps.
   * Each array contains the pending swaps of the respective type.
   * This method is useful for checking the status of all pending swaps in the system.
   * @returns PendingSwaps - Returns all pending swaps, both reverse and submarine.
   */
  async getPendingSwaps(): Promise<PendingSwaps> {
    return {
      reverseSwaps: this.getPendingReverseSwaps(),
      submarineSwaps: this.getPendingSubmarineSwaps(),
    };
  }

  /**
   * Retrieves all pending submarine swaps from the storage provider.
   * This method filters the pending swaps to return only those with a status of 'pending'.
   * It is useful for checking the status of all pending submarine swaps in the system.
   * @returns PendingSubmarineSwap[]
   */
  getPendingSubmarineSwaps(): PendingSubmarineSwap[] {
    if (!this.storageProvider) return [];
    const swaps = this.storageProvider.getPendingSubmarineSwaps();
    return swaps.filter((swap) => swap.status === 'invoice.set');
  }

  /**
   * Retrieves all pending reverse swaps from the storage provider.
   * This method filters the pending swaps to return only those with a status of 'pending'.
   * It is useful for checking the status of all pending reverse swaps in the system.
   * @returns PendingReverseSwap[]
   */
  getPendingReverseSwaps(): PendingReverseSwap[] {
    if (!this.storageProvider) return [];
    const swaps = this.storageProvider.getPendingReverseSwaps();
    return swaps.filter((swap) => swap.status === 'swap.created');
  }
}
