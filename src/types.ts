import { Identity, IWallet, ArkProvider, IndexerProvider } from '@arkade-os/sdk';
import { StorageProvider } from './storage-provider';
import { Storage } from './storage';
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

// Support both wallet interfaces:
// 1. Wallet with optional nested identity and providers
// 2. ServiceWorkerWallet with identity methods spread directly (legacy)
export type WalletWithNestedIdentity = IWallet & {
  arkProvider?: ArkProvider;
  indexerProvider?: IndexerProvider;
  identity: Identity;
};

export type ServiceWorkerWallet = IWallet & Identity;

export type Wallet = WalletWithNestedIdentity | ServiceWorkerWallet;

// Type guards for better ergonomics and type narrowing
export const isWalletWithNestedIdentity = (w: Wallet): w is WalletWithNestedIdentity =>
  !!(w as any).identity && typeof (w as any).identity?.xOnlyPublicKey === 'function';

export const isServiceWorkerWallet = (w: Wallet): w is ServiceWorkerWallet =>
  typeof (w as any).xOnlyPublicKey === 'function' && !(w as any).identity;

export type Network = 'bitcoin' | 'mutinynet' | 'regtest' | 'testnet';

export interface CreateLightningInvoiceRequest {
  amount: number;
  description?: string;
}
export interface CreateLightningInvoiceResponse {
  amount: number;
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
  type: 'reverse';
  createdAt: number;
  preimage: string;
  status: BoltzSwapStatus;
  request: CreateReverseSwapRequest;
  response: CreateReverseSwapResponse;
}

export interface PendingSubmarineSwap {
  type: 'submarine';
  createdAt: number;
  preimage?: string;
  status: BoltzSwapStatus;
  request: CreateSubmarineSwapRequest;
  response: CreateSubmarineSwapResponse;
}

export interface RefundHandler {
  onRefundNeeded: (swapData: PendingSubmarineSwap) => Promise<void>;
}

export interface ArkadeLightningConfig {
  wallet: Wallet;
  arkProvider?: ArkProvider;
  swapProvider: BoltzSwapProvider;
  indexerProvider?: IndexerProvider;
  feeConfig?: Partial<FeeConfig>;
  refundHandler?: RefundHandler;
  storage?: Storage;
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
