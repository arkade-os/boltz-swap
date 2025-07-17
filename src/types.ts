import { RestArkProvider, RestIndexerProvider } from '@arkade-os/sdk';
import {
  CreateReverseSwapResponse,
  CreateSubmarineSwapResponse,
  SwapStatusResponse,
  BoltzSwapProvider,
} from './boltz-swap-provider';

// TODO: replace with better data structure
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
  sendBitcoin(address: string, amount: number): Promise<string>;
  sign(tx: any, indexes?: number[]): Promise<any>;
  broadcastTx(tx: any): Promise<{ txid: string }>;
  signerSession(): any;
}

export type Network = 'mainnet' | 'testnet' | 'regtest';

export interface CreateInvoiceResult {
  preimage: string;
  status?: 'pending' | 'claimable' | 'completed' | 'failed';
  swapInfo: CreateReverseSwapResponse;
}
export interface PayInvoiceArgs {
  invoice: string;
  maxFeeSats?: number;
}

export interface PayInvoiceResult {
  status?: 'pending' | 'claimable' | 'completed' | 'failed';
  swapInfo: CreateSubmarineSwapResponse;
}

export interface PaymentResult {
  preimage: string;
  txid: string;
}

export interface PendingSwaps {
  reverseSwaps: CreateInvoiceResult[];
  submarineSwaps: PayInvoiceResult[];
}

export type SwapData = CreateSubmarineSwapResponse | CreateReverseSwapResponse | SwapStatusResponse;

export type SwapStatus = 'pending' | 'claimable' | 'completed' | 'failed';

export interface RefundHandler {
  onRefundNeeded: (swapData: CreateSubmarineSwapResponse) => Promise<void>;
}

export interface ArkadeLightningConfig {
  wallet: Wallet;
  indexerProvider: RestIndexerProvider;
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

export interface DecodedInvoice {
  expiry: number;
  amountSats: number;
  description: string;
  paymentHash: string;
}

export interface IncomingPaymentSubscription {
  on(event: 'pending', listener: () => void): this;
  on(event: 'claimable', listener: () => void): this;
  on(event: 'completed', listener: () => void): this;
  on(event: 'failed', listener: (error: Error) => void): this;
  unsubscribe(): void;
}
