import { RestArkProvider, RestIndexerProvider } from '@arkade-os/sdk';
import {
  CreateReverseSwapResponse,
  CreateSubmarineSwapResponse,
  BoltzSwapProvider,
  CreateReverseSwapParams,
  CreateSubmarineSwapRequest,
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
  status?: SwapStatus;
  swapInfo: CreateReverseSwapResponse;
}
export interface PayInvoiceArgs {
  invoice: string;
  maxFeeSats?: number;
}

export interface PayInvoiceResult {
  status?: SwapStatus;
  swapInfo: CreateSubmarineSwapResponse;
}

export interface PaymentResult {
  preimage: string;
  txid: string;
}

export interface PendingReverseSwap {
  preimage: string;
  request: CreateReverseSwapParams;
  response: CreateReverseSwapResponse;
  status: SwapStatus;
}

export interface PendingSubmarineSwap {
  request: CreateSubmarineSwapRequest;
  response: CreateSubmarineSwapResponse;
  status: SwapStatus;
}

export interface PendingSwaps {
  reverseSwaps: PendingReverseSwap[];
  submarineSwaps: PendingSubmarineSwap[];
}

export type SwapStatus = 'pending' | 'created' | 'refundable' | 'refunded' | 'settled' | 'failed';

export interface RefundHandler {
  onRefundNeeded: (swapData: PendingSubmarineSwap) => Promise<void>;
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
  on(event: 'created', listener: () => void): this;
  on(event: 'settled', listener: () => void): this;
  on(event: 'failed', listener: (error: Error) => void): this;
  unsubscribe(): void;
}
