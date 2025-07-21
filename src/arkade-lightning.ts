import { poll } from './utils/polling';
import { SwapError } from './errors';
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
  CreateInvoiceResult,
  DecodedInvoice,
  PayInvoiceArgs,
  PaymentResult,
  PendingReverseSwap,
  PendingSubmarineSwap,
  PendingSwaps,
  SwapStatus,
  Wallet,
} from './types';
import { randomBytes } from '@noble/hashes/utils';
import {
  SwapStatusResponse,
  BoltzSwapProvider,
  CreateSubmarineSwapRequest,
  CreateReverseSwapParams,
} from './boltz-swap-provider';
import { IncomingPaymentSubscription } from '.';
import EventEmitter from 'events';
import bolt11 from 'light-bolt11-decoder';
import { StorageProvider } from './storage-provider';
import { Transaction } from '@scure/btc-signer';
import { hash160 } from '@scure/btc-signer/utils';
import { TransactionInput } from '@scure/btc-signer/psbt';

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
  private readonly storageProvider: StorageProvider;
  private readonly indexerProvider: RestIndexerProvider;
  private readonly config: Required<ArkadeLightningConfig>;

  private constructor(config: ArkadeLightningConfig, storageProvider: StorageProvider) {
    this.wallet = config.wallet;
    this.arkProvider = config.arkProvider;
    this.swapProvider = config.swapProvider;
    this.storageProvider = storageProvider;
    this.indexerProvider = config.indexerProvider;
    this.config = {
      ...config,
      refundHandler: config.refundHandler ?? { onRefundNeeded: async () => {} },
      timeoutConfig: { ...DEFAULT_TIMEOUT_CONFIG, ...config.timeoutConfig },
      feeConfig: { ...DEFAULT_FEE_CONFIG, ...config.feeConfig },
      retryConfig: { ...DEFAULT_RETRY_CONFIG, ...config.retryConfig },
    } as Required<ArkadeLightningConfig>;
  }

  static async create(config: ArkadeLightningConfig): Promise<ArkadeLightning> {
    if (!config.wallet) throw new Error('Wallet is required.');
    if (!config.arkProvider) throw new Error('Ark provider is required.');
    if (!config.swapProvider) throw new Error('Swap provider is required.');
    if (!config.indexerProvider) throw new Error('Indexer provider is required.');
    const storageProvider = await StorageProvider.create();
    return new ArkadeLightning(config, storageProvider);
  }

  // receive from lightning = reverse submarine swap
  //
  // 1. create invoice by creating a reverse swap
  // 2. monitor incoming payment by waiting for the hold invoice to be paid
  // 3. claim the VHTLC by creating a virtual transaction that spends the VHTLC output
  // 4. return the preimage and the swap info

  async createLightningInvoice(args: { amountSats: number; description?: string }): Promise<CreateInvoiceResult> {
    return new Promise((resolve, reject) => {
      this.createReverseSwap(args)
        .then((swapResponse) => {
          const subscription = this.monitorIncomingPayment(swapResponse);
          subscription.on('failed', () => reject(new SwapError('Swap failed')));
          subscription.on('created', () => this.storageProvider.savePendingReverseSwap(swapResponse));
          subscription.on('pending', () => this.claimVHTLC(swapResponse));
          subscription.on('settled', () => {
            this.storageProvider.deletePendingReverseSwap(swapResponse.response.id);
            resolve({
              swapInfo: swapResponse.response,
              preimage: swapResponse.preimage,
            });
          });
        })
        .catch(reject);
    });
  }

  // create reverse submarine swap
  async createReverseSwap(args: { amountSats: number; description?: string }): Promise<PendingReverseSwap> {
    // create random preimage and its hash
    const preimage = randomBytes(32);
    const preimageHash = hex.encode(sha256(preimage));
    if (!preimageHash) throw new SwapError('Failed to get preimage hash');

    const createReverseSwapParams: CreateReverseSwapParams = {
      invoiceAmount: args.amountSats,
      claimPublicKey: await this.wallet.getPublicKey(),
      preimageHash,
    };

    // make reverse swap request
    const swapResponse = await this.swapProvider.createReverseSwap(createReverseSwapParams);

    return {
      preimage: hex.encode(preimage),
      request: createReverseSwapParams,
      response: swapResponse,
      status: 'pending',
    } as PendingReverseSwap;
  }

  // monitor incoming payment by waiting for the hold invoice to be paid
  monitorIncomingPayment(pendingSwap: PendingReverseSwap) {
    const emitter = new EventEmitter();
    const swapInfo = pendingSwap.response;

    // callback function to handle swap status updates
    const onUpdate = (type: SwapStatus, data?: any) => {
      switch (type) {
        case 'failed':
          emitter.emit('failed', data);
          break;
        case 'created':
          emitter.emit('created');
          break;
        case 'pending':
          this.claimVHTLC(pendingSwap);
          break;
        case 'settled':
          emitter.emit('settled');
          break;
        default:
          console.warn(`Unhandled swap status: ${type}`);
      }
    };

    // monitor the swap status
    this.swapProvider.monitorSwap(swapInfo.id, onUpdate);

    return {
      on(event: SwapStatus, listener: (...args: any[]) => void) {
        emitter.on(event, listener);
        return this;
      },
      unsubscribe() {
        emitter.removeAllListeners();
      },
    } as IncomingPaymentSubscription;
  }

  // claim the VHTLC by creating a virtual transaction that spends the VHTLC output
  async claimVHTLC(pendingSwap: PendingReverseSwap) {
    const { preimage, response: swapInfo } = pendingSwap;
    const aspInfo = await this.arkProvider.getInfo();
    const address = await this.wallet.getAddress();

    // validate we are using a x-only receiver public key
    let receiverXOnlyPublicKey = hex.decode(await this.wallet.getPublicKey());
    if (receiverXOnlyPublicKey.length == 33) {
      receiverXOnlyPublicKey = receiverXOnlyPublicKey.slice(1);
    } else if (receiverXOnlyPublicKey.length !== 32) {
      throw new Error(`Invalid receiver public key length: ${receiverXOnlyPublicKey.length}`);
    }

    // build expected VHTLC script
    const vhtlcScript = await this.createVHTLC({
      network: aspInfo.network,
      preimage: hex.decode(preimage),
      receiverPubkey: await this.wallet.getPublicKey(),
      senderPubkey: swapInfo.refundPublicKey,
      serverPubkey: aspInfo.signerPubkey,
      swapInfo,
    });

    // get spendable VTXOs from the lockup address
    const scripts = [hex.encode(vhtlcScript.pkScript)];
    const spendableVtxos = await this.indexerProvider.getVtxos({ scripts, spendableOnly: true });
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
        setArkPsbtField(signedTx, 0, ConditionWitness, [hex.decode(preimage)]);
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
    if (!this.validFinalArkTx(finalArkTx)) {
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

  /**
   * Sends a Lightning payment.
   * 1. decode the invoice to get the amount and destination
   * 2. create submarine swap with the decoded invoice
   * 3. send the swap address and expected amount to the wallet to create a transaction
   * 4. wait for the swap settlement and return the preimage and txid
   * @param args - The arguments for sending a Lightning payment.
   * @returns The result of the payment.
   */
  async sendLightningPayment(args: PayInvoiceArgs): Promise<PaymentResult> {
    const refundPublicKey = await this.wallet.getPublicKey();
    if (!refundPublicKey) throw new SwapError('Failed to get refund public key from wallet');

    const invoice = args.invoice;
    if (!invoice) throw new SwapError('Invoice is required');

    const swapRequest: CreateSubmarineSwapRequest = { invoice, refundPublicKey };

    const swapResponse = await this.swapProvider.createSubmarineSwap(swapRequest);

    // validate max fee if provided
    if (args.maxFeeSats) {
      const invoiceAmount = this.decodeInvoice(args.invoice).amountSats;
      const fees = swapResponse.expectedAmount - invoiceAmount;
      if (fees > args.maxFeeSats) {
        throw new SwapError(`Swap fees ${fees} exceed max allowed ${args.maxFeeSats}`);
      }
    }

    const swapData: PendingSubmarineSwap = {
      status: 'pending',
      request: swapRequest,
      response: swapResponse,
    };

    // save swap info to storage
    await this.storageProvider.savePendingSubmarineSwap(swapData);

    // send funds to the swap address
    const txid = await this.wallet.sendBitcoin(swapResponse.address, swapResponse.expectedAmount);

    const finalStatus = await this.waitForSwapSettlement(swapData);

    if (finalStatus.transaction?.preimage) {
      await this.storageProvider.deletePendingSubmarineSwap(swapResponse.id);
      return {
        preimage: finalStatus.transaction.preimage,
        txid,
      };
    }

    throw new SwapError('Swap settlement did not return a preimage', {
      isRefundable: true,
      swapData: { ...swapData, status: 'failed' },
    });
  }

  /**
   * Waits for the swap settlement.
   * @param swapData - The swap data to wait for.
   * @returns The status of the swap settlement.
   */
  async waitForSwapSettlement(swapData: PendingSubmarineSwap): Promise<SwapStatusResponse> {
    const status = await poll(
      () => this.swapProvider.getSwapStatus(swapData.response.id),
      (status) => status.status === 'transaction.claimed',
      this.config.retryConfig.delayMs ?? 2000,
      this.config.retryConfig.maxAttempts ?? 5
    ).catch((err) => {
      this.config.refundHandler.onRefundNeeded(swapData);
      throw new SwapError(`Swap settlement failed: ${(err as Error).message}`, {
        isRefundable: true,
        swapData: { ...swapData, status: 'failed' },
      });
    });

    if (status.status === 'transaction.claimed') {
      this.storageProvider.deletePendingSubmarineSwap(swapData.response.id);
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
  private validFinalArkTx = (finalArkTx: string, _pubkey?: Uint8Array, _tapLeaves?: TapLeafScript[]): boolean => {
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
  private async createVHTLC({
    network,
    preimage,
    receiverPubkey,
    refundLocktime,
    senderPubkey,
    serverPubkey,
    swapInfo,
  }: {
    network: string;
    preimage: Uint8Array;
    swapInfo: CreateInvoiceResult['swapInfo'];
    receiverPubkey: string;
    refundLocktime?: number;
    senderPubkey: string;
    serverPubkey: string;
  }): Promise<VHTLC.Script> {
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
      preimageHash: hash160(preimage),
      sender: senderXOnlyPublicKey,
      receiver: receiverXOnlyPublicKey,
      server: serverXOnlyPublicKey,
      refundLocktime: BigInt(refundLocktime ?? swapInfo.timeoutBlockHeights.refund),
      unilateralClaimDelay: {
        type: 'blocks',
        value: BigInt(swapInfo.timeoutBlockHeights.unilateralClaim),
      },
      unilateralRefundDelay: {
        type: 'blocks',
        value: BigInt(swapInfo.timeoutBlockHeights.unilateralRefund),
      },
      unilateralRefundWithoutReceiverDelay: {
        type: 'blocks',
        value: BigInt(swapInfo.timeoutBlockHeights.unilateralRefundWithoutReceiver),
      },
    });

    if (!vhtlcScript) {
      throw new Error('Failed to create VHTLC script');
    }

    // validate vhtlc script
    const hrp = network === 'bitcoin' ? 'ark' : 'tark';
    const vhtlcAddress = vhtlcScript.address(hrp, serverXOnlyPublicKey).encode();
    if (vhtlcAddress !== swapInfo.lockupAddress) {
      throw new Error('Boltz is trying to scam us');
    }

    return vhtlcScript;
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
      reverseSwaps: await this.getPendingReverseSwapss(),
      submarineSwaps: await this.getPendingSubmarineSwaps(),
    };
  }

  /**
   * Retrieves all pending submarine swaps from the storage provider.
   * This method filters the pending swaps to return only those with a status of 'pending'.
   * It is useful for checking the status of all pending submarine swaps in the system.
   * @returns PendingSubmarineSwap[]
   */
  async getPendingSubmarineSwaps(): Promise<PendingSubmarineSwap[]> {
    const swaps = await this.storageProvider.getPendingSubmarineSwaps();
    return swaps.filter((swap) => swap.status === 'pending');
  }

  /**
   * Retrieves all pending reverse swaps from the storage provider.
   * This method filters the pending swaps to return only those with a status of 'pending'.
   * It is useful for checking the status of all pending reverse swaps in the system.
   * @returns PendingReverseSwap[]
   */
  async getPendingReverseSwapss(): Promise<PendingReverseSwap[]> {
    const swaps = await this.storageProvider.getPendingReverseSwaps();
    return swaps.filter((swap) => swap.status === 'pending');
  }
}
