import { Transaction } from '@scure/btc-signer';
import EventEmitter from 'events';
import { BoltzSwapProvider } from './boltz-swap-provider';
import type {
  ArkadeLightningConfig,
  CreateInvoiceResult,
  DecodedInvoice,
  IncomingPaymentSubscription,
  PaymentResult,
  SendPaymentArgs,
  SwapData,
  Wallet,
  BoltzSwapStatusResponse,
} from './types';
import { InsufficientFundsError, SwapError } from './errors';
import { getBitcoinNetwork } from './utils/htlc';
import { poll } from './utils/polling';

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
  private readonly swapProvider: BoltzSwapProvider;
  private readonly config: Required<ArkadeLightningConfig>;

  constructor(config: ArkadeLightningConfig) {
    if (!config.wallet || !config.swapProvider) {
      throw new Error('Wallet and SwapProvider are required.');
    }
    this.wallet = config.wallet;
    this.swapProvider = config.swapProvider;
    this.config = {
      ...config,
      refundHandler: config.refundHandler ?? { onRefundNeeded: async () => {} },
      timeoutConfig: { ...DEFAULT_TIMEOUT_CONFIG, ...config.timeoutConfig },
      feeConfig: { ...DEFAULT_FEE_CONFIG, ...config.feeConfig },
      retryConfig: { ...DEFAULT_RETRY_CONFIG, ...config.retryConfig },
    } as Required<ArkadeLightningConfig>;
  }

  async createLightningInvoice(args: {
    amountSats: number;
    description?: string;
  }): Promise<CreateInvoiceResult> {
    console.log(args);
    throw new Error(
      'Receiving via reverse submarine swap is not implemented in this version.'
    );
  }

  monitorIncomingPayment(): IncomingPaymentSubscription {
    const emitter = new EventEmitter();
    return {
      on(event: 'pending' | 'confirmed' | 'failed', listener: (...args: any[]) => void) {
        emitter.on(event, listener);
        return this;
      },
      unsubscribe() {
        emitter.removeAllListeners();
      },
    } as IncomingPaymentSubscription;
  }

  async decodeInvoice(invoice: string): Promise<DecodedInvoice> {
    // In a real implementation, use a proper BOLT11 decoder.
    console.warn('Invoice decoding is mocked.');
    const amountMatch = invoice.match(/ln(bc|tb)(\d+)/);
    const amount = amountMatch ? parseInt(amountMatch[2], 10) : 0;
    return {
      amountSats: amount,
      description: 'Mocked description',
      destination: '02mockdestinationpubkey',
      paymentHash: 'mockpaymenthash',
      expiry: 3600,
    };
  }

  async sendLightningPayment(args: SendPaymentArgs): Promise<PaymentResult> {
    const refundPubkey = await this.wallet.getPublicKey();
    const swap = await this.swapProvider.createSubmarineSwap(
      args.invoice,
      refundPubkey
    );

    if (!swap.address || !swap.expectedAmount) {
      throw new SwapError('Invalid swap response from Boltz', {
        swapData: swap as any,
      });
    }

    const tx = new Transaction();
    const utxos = args.sourceVtxos || (await this.wallet.getVtxos());
    const network = getBitcoinNetwork(this.swapProvider.getNetwork());
    const selectedUtxo = utxos[0]; // Simplified: use the first UTXO
    if (!selectedUtxo || selectedUtxo.sats < swap.expectedAmount) {
      throw new InsufficientFundsError('Not enough funds for the swap.');
    }

    tx.addInput({
      txid: selectedUtxo.txid,
      index: selectedUtxo.vout,
      nonWitnessUtxo: selectedUtxo.tx.hex,
    });

    tx.addOutputAddress(swap.address, BigInt(swap.expectedAmount), network);

    const signedTx = await this.wallet.signTx(tx);
    const broadcastResult = await this.wallet.broadcastTx(signedTx);

    const finalStatus = await this.waitForSwapSettlement(swap.id);

    if (finalStatus.transaction?.preimage) {
      return {
        preimage: finalStatus.transaction.preimage,
        txid: broadcastResult.txid,
      };
    }

    throw new SwapError('Swap settlement did not return a preimage', {
      isRefundable: true,
      swapData: { ...swap, ...finalStatus },
    });
  }

  private async waitForSwapSettlement(
    swapId: string
  ): Promise<BoltzSwapStatusResponse> {
    return poll(
      () => this.swapProvider.getSwapStatus(swapId),
      (status) => status.status === 'transaction.claimed',
      this.config.retryConfig.delayMs ?? 2000,
      this.config.retryConfig.maxAttempts ?? 5
    ).catch((err) => {
      const lastStatus = (err as any).lastStatus as BoltzSwapStatusResponse;
      const swapData = { id: swapId, ...lastStatus };
      this.config.refundHandler.onRefundNeeded(swapData as SwapData);
      throw new SwapError(`Swap settlement failed: ${(err as Error).message}`, {
        isRefundable: true,
        swapData: swapData as SwapData,
      });
    });
  }

  async getPendingSwaps(): Promise<SwapData[]> {
    console.warn('getPendingSwaps is not implemented.');
    return [];
  }

  async claimRefund(swapData: SwapData): Promise<{ txid: string }> {
    console.warn('Refund claiming not fully implemented.', swapData);
    throw new Error('Not implemented');
  }
}