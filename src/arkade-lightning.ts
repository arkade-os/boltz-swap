import { poll } from './utils/polling';
import { BoltzSwapProvider } from './providers/boltz/provider';
import { SwapError } from './errors';
import { RestArkProvider, VHTLC, addConditionWitness, createVirtualTx } from '@arkade-os/sdk';
import { ripemd160 } from '@noble/hashes/legacy';
import { sha256 } from '@noble/hashes/sha2';
import { base64, hex } from '@scure/base';
import type {
  ArkadeLightningConfig,
  CreateInvoiceResult,
  DecodedInvoice,
  PayInvoiceArgs,
  PaymentResult,
  SwapStatus,
  Wallet,
} from './types';
import { randomBytes } from '@noble/hashes/utils';
import { SubmarineSwapPostResponse, SwapStatusResponse } from './providers/boltz/types';
import { IncomingPaymentSubscription } from '.';
import EventEmitter from 'events';
import bolt11 from 'light-bolt11-decoder';

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
  private readonly config: Required<ArkadeLightningConfig>;

  constructor(config: ArkadeLightningConfig) {
    if (!config.wallet) throw new Error('Wallet is required.');
    if (!config.swapProvider) throw new Error('Swap provider is required.');
    if (!config.arkProvider) throw new Error('Ark provider is required.');

    this.wallet = config.wallet;
    this.arkProvider = config.arkProvider;
    this.swapProvider = config.swapProvider;
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
    // create random preimage and its hash
    const preimage = randomBytes(32);
    const preimageHash = hex.encode(sha256(preimage));
    if (!preimageHash) throw 'Failed to get preimage hash';

    // make reverse swap request
    const swapInfo = await this.swapProvider.createReverseSwap(
      args.amountSats,
      await this.wallet.getPublicKey(),
      preimageHash
    );

    return { swapInfo, preimage: hex.encode(preimage) };
  }

  async monitorIncomingPayment(createInvoiceResult: CreateInvoiceResult) {
    const emitter = new EventEmitter();
    const { swapInfo } = createInvoiceResult;

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

  async claimVHTLC(createInvoiceResult: CreateInvoiceResult) {
    const { preimage, swapInfo } = createInvoiceResult;

    let receiverXOnlyPublicKey = hex.decode(await this.wallet.getPublicKey());
    if (receiverXOnlyPublicKey.length == 33) {
      receiverXOnlyPublicKey = receiverXOnlyPublicKey.slice(1);
    } else if (receiverXOnlyPublicKey.length !== 32) {
      throw new Error(`Invalid receiver public key length: ${receiverXOnlyPublicKey.length}`);
    }

    let senderXOnlyPublicKey = hex.decode(swapInfo.refundPublicKey);
    if (senderXOnlyPublicKey.length == 33) {
      senderXOnlyPublicKey = senderXOnlyPublicKey.slice(1);
    } else if (senderXOnlyPublicKey.length !== 32) {
      throw new Error(`Invalid sender public key length: ${senderXOnlyPublicKey.length}`);
    }

    let serverXOnlyPublicKey = hex.decode((await this.arkProvider.getInfo()).pubkey);
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
      refundLocktime: BigInt(80 * 600),
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

    // validate vhtlc script
    const hrp = this.swapProvider.getNetwork() === 'mainnet' ? 'ark' : 'tark';
    const vhtlcAddress = vhtlcScript.address(hrp, serverXOnlyPublicKey).encode();
    if (vhtlcAddress !== swapInfo.lockupAddress) throw new Error('Boltz is trying to scam us');

    // get spendable VTXOs from the lockup address
    const { spendableVtxos } = await this.arkProvider.getVirtualCoins(vhtlcAddress);
    if (spendableVtxos.length === 0) throw new Error('No spendable virtual coins found');
    if (spendableVtxos.length !== 1) throw new Error('Something went wrong, expected exactly one spendable VTXO');
    const vtxo = spendableVtxos[0];

    const vhtlcIdentity = {
      sign: async (tx: any, inputIndexes?: number[]) => {
        const cpy = tx.clone();
        addConditionWitness(0, cpy, [hex.decode(preimage)]);
        return this.wallet.sign(cpy, inputIndexes);
      },
      xOnlyPublicKey: receiverXOnlyPublicKey,
      signerSession: this.wallet.signerSession,
    };

    // create the virtual transaction to claim the VHTLC
    const tx = createVirtualTx(
      [
        {
          ...vtxo,
          tapLeafScript: vhtlcScript.claim(),
          scripts: vhtlcScript.encode(),
        },
      ],
      [
        {
          address: await this.wallet.getAddress(),
          amount: BigInt(vtxo.value),
        },
      ]
    );

    // sign and "broadcast" the virtual transaction
    const signedTx = await vhtlcIdentity.sign(tx);
    const txid = await this.arkProvider.submitVirtualTx(base64.encode(signedTx.toPSBT()));

    console.log('Successfully claimed VHTLC! Transaction ID:', txid);
    return { amount: vtxo.value, txid: txid };
  }

  // pay to lightning = submarine swap
  //
  // 1. decode the invoice to get the amount and destination
  // 2. create submarine swap with the decoded invoice
  // 3. send the swap address and expected amount to the wallet to create a transaction
  // 4. wait for the swap settlement and return the preimage and txid

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

  async sendLightningPayment(args: PayInvoiceArgs): Promise<PaymentResult> {
    const refundPubkey = await this.wallet.getPublicKey();
    if (!refundPubkey) throw new SwapError('Failed to get refund public key from wallet');

    const swapInfo = await this.swapProvider.createSubmarineSwap(args.invoice, refundPubkey);

    if (!swapInfo.address || !swapInfo.expectedAmount) {
      throw new SwapError('Invalid swap response from Boltz', {
        swapData: swapInfo,
      });
    }

    const txid = await this.wallet.sendBitcoin(swapInfo.address, swapInfo.expectedAmount);

    const finalStatus = await this.waitForSwapSettlement(swapInfo);

    if (finalStatus.transaction?.preimage) {
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

  private async waitForSwapSettlement(swapInfo: SubmarineSwapPostResponse): Promise<SwapStatusResponse> {
    return poll(
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
  }
}
