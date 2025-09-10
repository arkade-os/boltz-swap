import {
  InvoiceExpiredError,
  InvoiceFailedToPayError,
  SwapError,
  SwapExpiredError,
  TransactionFailedError,
  TransactionLockupFailedError,
  TransactionRefundedError,
} from './errors';
import {
  ArkAddress,
  ArkProvider,
  IndexerProvider,
  buildOffchainTx,
  ConditionWitness,
  CSVMultisigTapscript,
  setArkPsbtField,
  TapLeafScript,
  VHTLC,
  Identity,
} from '@arkade-os/sdk';
import { sha256 } from '@noble/hashes/sha2';
import { base64, hex } from '@scure/base';
import type {
  ArkadeLightningConfig,
  CreateLightningInvoiceResponse,
  SendLightningPaymentRequest,
  SendLightningPaymentResponse,
  PendingReverseSwap,
  PendingSubmarineSwap,
  CreateLightningInvoiceRequest,
  Wallet,
  LimitsResponse,
  FeesResponse,
} from './types';
import { isWalletWithNestedIdentity } from './types';
import { randomBytes } from '@noble/hashes/utils';
import {
  BoltzSwapProvider,
  CreateSubmarineSwapRequest,
  CreateReverseSwapRequest,
  BoltzSwapStatus,
} from './boltz-swap-provider';
import { StorageProvider } from './storage-provider';
import { Transaction } from '@scure/btc-signer';
import { TransactionInput } from '@scure/btc-signer/psbt';
import { ripemd160 } from '@noble/hashes/legacy';
import { decodeInvoice, getInvoicePaymentHash } from './utils/decoding';

// Utility functions to handle both wallet types
function getIdentity(wallet: Wallet): Identity {
  // Use type guard to check if wallet has nested identity
  if (isWalletWithNestedIdentity(wallet)) {
    return wallet.identity;
  }
  // Otherwise it's a ServiceWorkerWallet with identity methods spread
  return wallet as Identity;
}

function getXOnlyPublicKey(wallet: Wallet): Uint8Array {
  return getIdentity(wallet).xOnlyPublicKey();
}

function getSignerSession(wallet: Wallet): any {
  const identity = getIdentity(wallet);
  const signerSession = identity?.signerSession;

  // If signerSession is a function (factory), call it to get the actual session
  if (typeof signerSession === 'function') {
    return signerSession();
  }

  // Otherwise return it directly (could be the session object or undefined)
  return signerSession;
}

async function signTransaction(wallet: Wallet, tx: Transaction, inputIndexes?: number[]): Promise<Transaction> {
  return getIdentity(wallet).sign(tx, inputIndexes);
}

export class ArkadeLightning {
  private readonly wallet: Wallet;
  private readonly arkProvider: ArkProvider;
  private readonly swapProvider: BoltzSwapProvider;
  private readonly storageProvider: StorageProvider | null;
  private readonly indexerProvider: IndexerProvider;

  constructor(config: ArkadeLightningConfig) {
    if (!config.wallet) throw new Error('Wallet is required.');
    if (!config.swapProvider) throw new Error('Swap provider is required.');

    this.wallet = config.wallet;
    // Prioritize wallet providers, fallback to config providers for backward compatibility
    const arkProvider = (config.wallet as any).arkProvider ?? config.arkProvider;
    if (!arkProvider) throw new Error('Ark provider is required either in wallet or config.');
    this.arkProvider = arkProvider;

    const indexerProvider = (config.wallet as any).indexerProvider ?? config.indexerProvider;
    if (!indexerProvider) throw new Error('Indexer provider is required either in wallet or config.');
    this.indexerProvider = indexerProvider;

    this.swapProvider = config.swapProvider;
    this.storageProvider = config.storageProvider ?? null;
  }

  // receive from lightning = reverse submarine swap
  //
  // 1. create invoice by creating a reverse swap
  // 2. monitor incoming payment by waiting for the hold invoice to be paid
  // 3. claim the VHTLC by creating a virtual transaction that spends the VHTLC output
  // 4. return the preimage and the swap info

  async createLightningInvoice(args: CreateLightningInvoiceRequest): Promise<CreateLightningInvoiceResponse> {
    return new Promise((resolve, reject) => {
      this.createReverseSwap(args)
        .then((pendingSwap) => {
          const decodedInvoice = decodeInvoice(pendingSwap.response.invoice);
          //
          resolve({
            amount: pendingSwap.response.onchainAmount,
            expiry: decodedInvoice.expiry,
            invoice: pendingSwap.response.invoice,
            paymentHash: decodedInvoice.paymentHash,
            pendingSwap,
            preimage: pendingSwap.preimage,
          } as CreateLightningInvoiceResponse);
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
        if (args.maxFeeSats != null) {
          const invoiceAmount = decodeInvoice(args.invoice).amountSats ?? 0;
          const fees = pendingSwap.response.expectedAmount - invoiceAmount;
          if (invoiceAmount > 0 && fees > args.maxFeeSats) {
            reject(new SwapError({ message: `Swap fees ${fees} exceed max allowed ${args.maxFeeSats}` }));
          }
        }
        // save pending swap to storage if available
        this.storageProvider?.savePendingSubmarineSwap(pendingSwap);
        // send funds to the swap address
        this.wallet
          .sendBitcoin({ address: pendingSwap.response.address, amount: pendingSwap.response.expectedAmount })
          .then((txid) => {
            this.waitForSwapSettlement(pendingSwap)
              .then(async ({ preimage }) => {
                resolve({ amount: pendingSwap.response.expectedAmount, preimage, txid });
              })
              .catch(({ isRefundable }) => {
                if (isRefundable) {
                  this.refundVHTLC(pendingSwap)
                    .then(reject)
                    .catch(reject)
                    .finally(async () => {
                      if (this.storageProvider) {
                        const finalStatus = await this.swapProvider.getSwapStatus(pendingSwap.response.id);
                        this.storageProvider.savePendingSubmarineSwap({ ...pendingSwap, status: finalStatus.status });
                      }
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

  // create submarine swap
  async createSubmarineSwap(args: SendLightningPaymentRequest): Promise<PendingSubmarineSwap> {
    const refundPublicKey = hex.encode(getXOnlyPublicKey(this.wallet));
    if (!refundPublicKey) throw new SwapError({ message: 'Failed to get refund public key from wallet' });

    const invoice = args.invoice;
    if (!invoice) throw new SwapError({ message: 'Invoice is required' });

    const swapRequest: CreateSubmarineSwapRequest = {
      invoice,
      refundPublicKey,
    };

    // make submarine swap request
    const swapResponse = await this.swapProvider.createSubmarineSwap(swapRequest);

    // create pending swap object
    const pendingSwap: PendingSubmarineSwap = {
      type: 'submarine',
      createdAt: Math.floor(Date.now() / 1000),
      request: swapRequest,
      response: swapResponse,
      status: 'invoice.set',
    };

    // save pending swap to storage if available
    this.storageProvider?.savePendingSubmarineSwap(pendingSwap);

    return pendingSwap;
  }

  // create reverse submarine swap
  async createReverseSwap(args: CreateLightningInvoiceRequest): Promise<PendingReverseSwap> {
    // validate amount
    if (args.amount <= 0) throw new SwapError({ message: 'Amount must be greater than 0' });

    const claimPublicKey = hex.encode(getXOnlyPublicKey(this.wallet));
    if (!claimPublicKey) throw new SwapError({ message: 'Failed to get claim public key from wallet' });

    // create random preimage and its hash
    const preimage = randomBytes(32);
    const preimageHash = hex.encode(sha256(preimage));
    if (!preimageHash) throw new SwapError({ message: 'Failed to get preimage hash' });

    // build request object for reverse swap
    const swapRequest: CreateReverseSwapRequest = {
      invoiceAmount: args.amount,
      claimPublicKey,
      preimageHash,
    };

    // make reverse swap request
    const swapResponse = await this.swapProvider.createReverseSwap(swapRequest);

    const pendingSwap: PendingReverseSwap = {
      type: 'reverse',
      createdAt: Math.floor(Date.now() / 1000),
      preimage: hex.encode(preimage),
      request: swapRequest,
      response: swapResponse,
      status: 'swap.created',
    };

    // save pending swap to storage if available
    this.storageProvider?.savePendingReverseSwap(pendingSwap);

    return pendingSwap;
  }

  // claim the VHTLC by creating a virtual transaction that spends the VHTLC output
  async claimVHTLC(pendingSwap: PendingReverseSwap) {
    const preimage = hex.decode(pendingSwap.preimage);
    const aspInfo = await this.arkProvider.getInfo();
    const address = await this.wallet.getAddress();

    // validate we are using a x-only receiver public key
    let receiverXOnlyPublicKey = getXOnlyPublicKey(this.wallet);
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
      receiverPubkey: hex.encode(receiverXOnlyPublicKey),
      senderPubkey: pendingSwap.response.refundPublicKey,
      serverPubkey: hex.encode(serverXOnlyPublicKey),
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
        let signedTx = await signTransaction(this.wallet, cpy, inputIndexes);
        signedTx = Transaction.fromPSBT(signedTx.toPSBT(), { allowUnknown: true });
        setArkPsbtField(signedTx, 0, ConditionWitness, [preimage]);
        return signedTx;
      },
      xOnlyPublicKey: receiverXOnlyPublicKey,
      signerSession: getSignerSession(this.wallet),
    };

    // create the server unroll script for checkpoint transactions
    const serverUnrollScript = CSVMultisigTapscript.encode({
      pubkeys: [serverXOnlyPublicKey],
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

    // update the pending swap on storage if available
    if (this.storageProvider) {
      const finalStatus = await this.swapProvider.getSwapStatus(pendingSwap.response.id);
      this.storageProvider.savePendingReverseSwap({ ...pendingSwap, status: finalStatus.status });
    }
  }

  async refundVHTLC(pendingSwap: PendingSubmarineSwap): Promise<void> {
    // prepare variables for claiming the VHTLC
    const aspInfo = await this.arkProvider.getInfo();
    const address = await this.wallet.getAddress();
    if (!address) throw new Error('Failed to get ark address from service worker wallet');

    // validate we are using a x-only receiver public key
    let receiverXOnlyPublicKey = getXOnlyPublicKey(this.wallet);
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
      preimageHash: hex.decode(getInvoicePaymentHash(pendingSwap.request.invoice)),
      receiverPubkey: pendingSwap.response.claimPublicKey,
      senderPubkey: hex.encode(getXOnlyPublicKey(this.wallet)),
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
        let signedTx = await signTransaction(this.wallet, cpy, inputIndexes);
        return Transaction.fromPSBT(signedTx.toPSBT(), { allowUnknown: true });
      },
      xOnlyPublicKey: receiverXOnlyPublicKey,
      signerSession: getSignerSession(this.wallet),
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
          amount: BigInt(spendableVtxos.vtxos[0].value),
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

    // update the pending swap on storage if available
    if (this.storageProvider) {
      const finalStatus = await this.swapProvider.getSwapStatus(pendingSwap.response.id);
      this.storageProvider.savePendingSubmarineSwap({ ...pendingSwap, status: finalStatus.status });
    }
  }

  async waitAndClaim(pendingSwap: PendingReverseSwap): Promise<{ txid: string }> {
    return new Promise<{ txid: string }>((resolve, reject) => {
      // https://api.docs.boltz.exchange/lifecycle.html#swap-states
      const onStatusUpdate = async (status: BoltzSwapStatus) => {
        switch (status) {
          case 'transaction.mempool':
          case 'transaction.confirmed':
            this.storageProvider?.savePendingReverseSwap({ ...pendingSwap, status });
            this.claimVHTLC(pendingSwap).catch(reject);
            break;
          case 'invoice.settled': {
            this.storageProvider?.savePendingReverseSwap({ ...pendingSwap, status });
            const swapStatus = await this.swapProvider.getSwapStatus(pendingSwap.response.id);
            resolve({ txid: swapStatus.transaction?.id ?? '' });
            break;
          }
          case 'invoice.expired':
            this.storageProvider?.savePendingReverseSwap({ ...pendingSwap, status });
            reject(new InvoiceExpiredError({ isRefundable: true, pendingSwap }));
            break;
          case 'swap.expired':
            this.storageProvider?.savePendingReverseSwap({ ...pendingSwap, status });
            reject(new SwapExpiredError({ isRefundable: true, pendingSwap }));
            break;
          case 'transaction.failed':
            this.storageProvider?.savePendingReverseSwap({ ...pendingSwap, status });
            reject(new TransactionFailedError());
            break;
          case 'transaction.refunded':
            this.storageProvider?.savePendingReverseSwap({ ...pendingSwap, status });
            reject(new TransactionRefundedError());
            break;
          default:
            this.storageProvider?.savePendingReverseSwap({ ...pendingSwap, status });
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
  async waitForSwapSettlement(pendingSwap: PendingSubmarineSwap): Promise<{ preimage: string }> {
    return new Promise<{ preimage: string }>((resolve, reject) => {
      let isResolved = false;

      // https://api.docs.boltz.exchange/lifecycle.html#swap-states
      const onStatusUpdate = async (status: BoltzSwapStatus) => {
        if (isResolved) return; // Prevent multiple resolutions

        switch (status) {
          case 'swap.expired':
            isResolved = true;
            this.storageProvider?.savePendingSubmarineSwap({ ...pendingSwap, status });
            reject(new SwapExpiredError({ isRefundable: true, pendingSwap }));
            break;
          case 'invoice.failedToPay':
            isResolved = true;
            this.storageProvider?.savePendingSubmarineSwap({ ...pendingSwap, status });
            reject(new InvoiceFailedToPayError({ isRefundable: true, pendingSwap }));
            break;
          case 'transaction.lockupFailed':
            isResolved = true;
            this.storageProvider?.savePendingSubmarineSwap({ ...pendingSwap, status });
            reject(new TransactionLockupFailedError({ isRefundable: true, pendingSwap }));
            break;
          case 'transaction.claimed': {
            isResolved = true;
            const { preimage } = await this.swapProvider.getSwapPreimage(pendingSwap.response.id);
            this.storageProvider?.savePendingSubmarineSwap({ ...pendingSwap, preimage, status });
            resolve({ preimage });
            break;
          }
          default:
            this.storageProvider?.savePendingSubmarineSwap({ ...pendingSwap, status });
            break;
        }
      };

      // Start monitoring - the WebSocket will auto-close on terminal states
      this.swapProvider.monitorSwap(pendingSwap.response.id, onStatusUpdate).catch((error) => {
        if (!isResolved) {
          isResolved = true;
          reject(error);
        }
      });
    });
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
  createVHTLCScript({
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

  /**
   * Retrieves fees for swaps (in sats and percentage).
   */
  async getFees(): Promise<FeesResponse> {
    return this.swapProvider.getFees();
  }

  /**
   * Retrieves max and min limits for swaps (in sats).
   */
  async getLimits(): Promise<LimitsResponse> {
    return this.swapProvider.getLimits();
  }

  /**
   * Retrieves all pending submarine swaps from the storage provider.
   * This method filters the pending swaps to return only those with a status of 'invoice.set'.
   * It is useful for checking the status of all pending submarine swaps in the system.
   * @returns PendingSubmarineSwap[] or null if no storage provider is set.
   * If no swaps are found, it returns an empty array.
   */
  getPendingSubmarineSwaps(): PendingSubmarineSwap[] | null {
    if (!this.storageProvider) return null;
    const swaps = this.storageProvider.getPendingSubmarineSwaps();
    if (!swaps) return [];
    return swaps.filter((swap) => swap.status === 'invoice.set');
  }

  /**
   * Retrieves all pending reverse swaps from the storage provider.
   * This method filters the pending swaps to return only those with a status of 'swap.created'.
   * It is useful for checking the status of all pending reverse swaps in the system.
   * @returns PendingReverseSwap[] or null if no storage provider is set.
   * If no swaps are found, it returns an empty array.
   */
  getPendingReverseSwaps(): PendingReverseSwap[] | null {
    if (!this.storageProvider) return null;
    const swaps = this.storageProvider.getPendingReverseSwaps();
    if (!swaps) return [];
    return swaps.filter((swap) => swap.status === 'swap.created');
  }

  /**
   * Retrieves swap history from the storage provider.
   * @returns PendingReverseSwap[] or null if no storage provider is set.
   * If no swaps are found, it returns an empty array.
   */
  getSwapHistory(): (PendingReverseSwap | PendingSubmarineSwap)[] | null {
    if (!this.storageProvider) return null;
    const swaps = this.storageProvider.getSwapHistory();
    if (!swaps) return [];
    return swaps.sort((a, b) => b.createdAt - a.createdAt);
  }
}
