import { RestArkProvider } from '@arkade-os/sdk';
import { BoltzSwapProvider, ReverseSwapPostResponse } from './boltz-swap-provider';

// TODO: replace with better data strcuture
export interface Vtxo {
  txid: string;
  vout: number;
  sats: number;
  script: string;
  tx: {
    hex: string;
    version: number;
    locktime: number;
  };
}

export interface Wallet {
  getAddress(): Promise<string>;
  getPublicKey(): Promise<string>;
  getVtxos(): Promise<Vtxo[]>;
  sendBitcoin(address: string, amount: number): Promise<void>;
  sign(tx: any, indexes?: number[]): Promise<any>;
  broadcastTx(tx: any): Promise<{ txid: string }>;
  signerSession(): any;
}

export type Network = 'mainnet' | 'testnet' | 'regtest';

export interface BoltzSwapProviderConfig {
  apiUrl?: string;
  network: Network;
}

export interface CreateInvoiceResult {
  preimage: string;
  swapInfo: ReverseSwapPostResponse;
}

export interface DecodedInvoice {
  amountSats: number;
  description: string;
  destination: string;
  paymentHash: string;
  expiry: number;
}

export interface PaymentResult {
  preimage: string;
  txid: string;
}

export interface IncomingPaymentSubscription {
  on(event: 'pending', listener: () => void): this;
  on(event: 'confirmed', listener: (details: { txid: string; amountSats: number }) => void): this;
  on(event: 'failed', listener: (error: Error) => void): this;
  unsubscribe(): void;
}

export interface SendPaymentArgs {
  invoice: string;
  sourceVtxos?: Vtxo[];
  maxFeeSats?: number;
}

export type SwapStatus =
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'refundable'
  | 'transaction.claimed'
  | 'invoice.settled'
  | 'swap.successful';

export interface CreateSwapResponse {
  id: string;
  address: string;
  refundPublicKey: string;
  expectedAmount: number;
  bip21: string;
  redeemScript: string;
  timeoutBlockHeight: number;
}

export interface BoltzSwapStatusResponse {
  status: SwapStatus;
  failureReason?: string;
  transaction?: {
    hex: string;
    id: string;
    preimage?: string;
  };
}

export interface SwapData extends CreateSwapResponse, BoltzSwapStatusResponse {}

export interface RefundHandler {
  onRefundNeeded: (swapData: SwapData) => Promise<void>;
}

export interface ArkadeLightningConfig {
  wallet: Wallet;
  swapProvider: BoltzSwapProvider;
  arkProvider: RestArkProvider;
  refundHandler?: RefundHandler;
  timeoutConfig?: Partial<TimeoutConfig>;
  feeConfig?: Partial<FeeConfig>;
  retryConfig?: Partial<RetryConfig>;
}

export interface TimeoutConfig {
  swapExpiryBlocks: number;
  invoiceExpirySeconds: number;
  claimDelayBlocks: number;
}

export interface FeeConfig {
  maxMinerFeeSats: number;
  maxSwapFeeSats: number;
}

export interface RetryConfig {
  maxAttempts: number;
  delayMs: number;
}
