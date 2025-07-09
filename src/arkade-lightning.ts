import { poll } from './utils/polling';
import { BoltzSwapProvider } from './boltz-swap-provider';
import { SwapError } from './errors';
import { RestArkProvider, VHTLC, addConditionWitness, createVirtualTx } from '@arkade-os/sdk';
import { ripemd160 } from '@noble/hashes/legacy';
import { sha256 } from '@noble/hashes/sha2';
import { base64, hex } from '@scure/base';
import type {
  BoltzSwapStatusResponse,
  ArkadeLightningConfig,
  CreateInvoiceResult,
  SendPaymentArgs,
  DecodedInvoice,
  PaymentResult,
  SwapData,
  Wallet,
} from './types';
import { randomBytes } from '@noble/hashes/utils';

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
    if (!config.swapProvider) throw new Error('SwapProvider is required.');
    if (!config.arkProvider) throw new Error('ArkProvider is required.');

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
    const { preimage, swapInfo } = createInvoiceResult;
    return await this.swapProvider.waitAndClaim(swapInfo, preimage, this.claimVHTLC);
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
    if (!refundPubkey) throw new SwapError('Failed to get refund public key from wallet');

    const swap = await this.swapProvider.createSubmarineSwap(args.invoice, refundPubkey);

    if (!swap.address || !swap.expectedAmount) {
      throw new SwapError('Invalid swap response from Boltz', {
        swapData: swap as any,
      });
    }

    await this.wallet.sendBitcoin(swap.address, swap.expectedAmount);

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

  private async waitForSwapSettlement(swapId: string): Promise<BoltzSwapStatusResponse> {
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
    const amount = spendableVtxos.reduce((sum, vtxo) => sum + vtxo.value, 0);

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
          ...spendableVtxos[0],
          tapLeafScript: vhtlcScript.claim(),
          scripts: vhtlcScript.encode(),
        },
      ],
      [
        {
          address: await this.wallet.getAddress(),
          amount: BigInt(amount),
        },
      ]
    );

    // sign and "broadcast" the virtual transaction
    const signedTx = await vhtlcIdentity.sign(tx);
    const txid = await this.arkProvider.submitVirtualTx(base64.encode(signedTx.toPSBT()));

    console.log('Successfully claimed VHTLC! Transaction ID:', txid);
    return amount;
  }
}
