import { Identity, IWallet, RestArkProvider, RestIndexerProvider } from '@arkade-os/sdk';
import { StorageProvider } from './storage-provider';
import {
  CreateReverseSwapResponse,
  CreateSubmarineSwapResponse,
  BoltzSwapProvider,
  CreateReverseSwapRequest,
  CreateSubmarineSwapRequest,
  BoltzSwapStatus,
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

export type Wallet = IWallet & Identity;

export type Network = 'bitcoin' | 'mutinynet' | 'regtest' | 'testnet';

export interface CreateLightningInvoiceRequest {
  amount: number;
  description?: string;
}
export interface CreateLightningInvoiceResponse {
  expiry: number;
  invoice: string;
  paymentHash: string;
  pendingSwap: PendingReverseSwap;
  preimage: string;
}
export interface SendLightningPaymentRequest {
  invoice: string;
  maxFeeSats?: number;
}

export interface SendLightningPaymentResponse {
  amount: number;
  preimage: string;
  txid: string;
}

export interface PendingReverseSwap {
  createdAt: number;
  preimage: string;
  status: BoltzSwapStatus;
  request: CreateReverseSwapRequest;
  response: CreateReverseSwapResponse;
}

export interface PendingSubmarineSwap {
  createdAt: number;
  status: BoltzSwapStatus;
  request: CreateSubmarineSwapRequest;
  response: CreateSubmarineSwapResponse;
}

export interface RefundHandler {
  onRefundNeeded: (swapData: PendingSubmarineSwap) => Promise<void>;
}

export interface ArkadeLightningConfig {
  wallet: Wallet;
  arkProvider: RestArkProvider;
  swapProvider: BoltzSwapProvider;
  indexerProvider: RestIndexerProvider;
  feeConfig?: Partial<FeeConfig>;
  refundHandler?: RefundHandler;
  storageProvider?: StorageProvider | null;
  timeoutConfig?: Partial<TimeoutConfig>;
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

export interface LimitsResponse {
  min: number;
  max: number;
}
