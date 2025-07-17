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
  VHTLC,
} from '@arkade-os/sdk';
import { ripemd160 } from '@noble/hashes/legacy';
import { sha256 } from '@noble/hashes/sha2';
import { base64, hex } from '@scure/base';
import type {
  ArkadeLightningConfig,
  CreateInvoiceResult,
  DecodedInvoice,
  PayInvoiceArgs,
  PayInvoiceResult,
  PaymentResult,
  PendingSwaps,
  SwapStatus,
  Wallet,
} from './types';
import { randomBytes } from '@noble/hashes/utils';
import { CreateSubmarineSwapResponse, SwapStatusResponse, BoltzSwapProvider } from './boltz-swap-provider';
import { IncomingPaymentSubscription } from '.';
import EventEmitter from 'events';
import bolt11 from 'light-bolt11-decoder';
import { StorageManager } from './storage';
import { Transaction } from '@scure/btc-signer';

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
  private readonly storageProvider: StorageManager;
  private readonly indexerProvider: RestIndexerProvider;
  private readonly config: Required<ArkadeLightningConfig>;

  constructor(config: ArkadeLightningConfig) {
    if (!config.wallet) throw new Error('Wallet is required.');
    if (!config.swapProvider) throw new Error('Swap provider is required.');
    if (!config.arkProvider) throw new Error('Ark provider is required.');

    this.wallet = config.wallet;
    this.arkProvider = config.arkProvider;
    this.swapProvider = config.swapProvider;
    this.storageProvider = new StorageManager();
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

  async createLightningInvoice(args: { amountSats: number; description?: string }): Promise<CreateInvoiceResult> {
    return new Promise((resolve, reject) => {
      this.createReverseSwap(args)
        .then((result) => {
          const subscription = this.monitorIncomingPayment(result);
          subscription.on('failed', () => reject(new Error('Swap failed')));
          subscription.on('pending', () => this.storageProvider.saveReverseSwap(result));
          subscription.on('claimable', () => this.claimVHTLC(result));
          subscription.on('completed', () => {
            this.storageProvider.deleteReverseSwap(result);
            resolve(result);
          });
        })
        .catch(reject);
    });
  }

  // monitor incoming payment by waiting for the hold invoice to be paid
  monitorIncomingPayment(createInvoiceResult: CreateInvoiceResult) {
    const emitter = new EventEmitter();
    const { swapInfo } = createInvoiceResult;

    // callback function to handle swap status updates
    const onUpdate = (type: SwapStatus, data?: any) => {
      switch (type) {
        case 'failed':
          emitter.emit('failed', data);
          break;
        case 'pending':
          emitter.emit('pending');
          break;
        case 'claimable':
          this.claimVHTLC(createInvoiceResult);
          break;
        case 'completed':
          emitter.emit('completed');
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
  private async claimVHTLC(createInvoiceResult: CreateInvoiceResult) {
    const { preimage, swapInfo } = createInvoiceResult;
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

  // Check if the final Ark transaction is valid
  private validFinalArkTx(_finalArkTx: string): boolean {
    // TODO: Implement your validation logic here
    return true;
  }

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
      preimageHash: ripemd160(sha256(preimage)),
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

  // create reverse submarine swap
  private async createReverseSwap(args: { amountSats: number; description?: string }): Promise<CreateInvoiceResult> {
    // create random preimage and its hash
    const preimage = randomBytes(32);
    const preimageHash = hex.encode(sha256(preimage));
    if (!preimageHash) throw new SwapError('Failed to get preimage hash');

    // make reverse swap request
    const swapInfo = await this.swapProvider.createReverseSwap(
      args.amountSats,
      await this.wallet.getPublicKey(),
      preimageHash
    );

    // return the swap info and the preimage
    return { swapInfo, preimage: hex.encode(preimage) };
  }

  // pay to lightning = submarine swap
  //
  // 1. decode the invoice to get the amount and destination
  // 2. create submarine swap with the decoded invoice
  // 3. send the swap address and expected amount to the wallet to create a transaction
  // 4. wait for the swap settlement and return the preimage and txid

  async sendLightningPayment(args: PayInvoiceArgs): Promise<PaymentResult> {
    const refundPubkey = await this.wallet.getPublicKey();
    if (!refundPubkey) throw new SwapError('Failed to get refund public key from wallet');

    const swapInfo = await this.swapProvider.createSubmarineSwap(args.invoice, refundPubkey);

    if (!swapInfo.address || !swapInfo.expectedAmount) {
      throw new SwapError('Invalid swap response from swap provider', {
        swapData: swapInfo,
      });
    }

    // validate max fee if provided
    if (args.maxFeeSats) {
      const invoiceAmount = this.decodeInvoice(args.invoice).amountSats;
      const fees = swapInfo.expectedAmount - invoiceAmount;
      if (fees > args.maxFeeSats) {
        throw new SwapError(`Swap fees ${fees} exceed max allowed ${args.maxFeeSats}`);
      }
    }

    // save swap info to storage
    await this.storageProvider.saveSubmarineSwap({ status: 'pending', swapInfo });

    // send funds to the swap address
    const txid = await this.wallet.sendBitcoin(swapInfo.address, swapInfo.expectedAmount);

    const finalStatus = await this.waitForSwapSettlement(swapInfo);

    if (finalStatus.transaction?.preimage) {
      await this.storageProvider.deleteSubmarineSwap({ swapInfo });
      return {
        preimage: finalStatus.transaction.preimage,
        txid,
      };
    }

    throw new SwapError('Swap settlement did not return a preimage', {
      isRefundable: true,
      swapData: { ...swapInfo, ...finalStatus },
    });
  }

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

  private async waitForSwapSettlement(swapInfo: CreateSubmarineSwapResponse): Promise<SwapStatusResponse> {
    const status = await poll(
      () => this.swapProvider.getSwapStatus(swapInfo.id),
      (status) => status.status === 'transaction.claimed',
      this.config.retryConfig.delayMs ?? 2000,
      this.config.retryConfig.maxAttempts ?? 5
    ).catch((err) => {
      this.config.refundHandler.onRefundNeeded(swapInfo);
      throw new SwapError(`Swap settlement failed: ${(err as Error).message}`, {
        isRefundable: true,
        swapData: swapInfo,
      });
    });

    if (status.status === 'transaction.claimed') {
      this.storageProvider.deleteSubmarineSwap({ swapInfo });
    }

    return status;
  }

  // utils
  async getPendingSwaps(): Promise<PendingSwaps> {
    return {
      reverseSwaps: await this.getPendingReverseSwaps(),
      submarineSwaps: await this.getPendingSubmarineSwaps(),
    };
  }

  async getPendingSubmarineSwaps(): Promise<PayInvoiceResult[]> {
    const swaps = await this.storageProvider.getSubmarineSwaps();
    return swaps.filter((swap) => swap.status === 'pending');
  }

  async getPendingReverseSwaps(): Promise<CreateInvoiceResult[]> {
    const swaps = await this.storageProvider.getReverseSwaps();
    return swaps.filter((swap) => swap.status === 'pending');
  }
}
