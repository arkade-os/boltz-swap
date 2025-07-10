import { RestArkProvider } from '@arkade-os/sdk';
import { BoltzSwapProvider } from './providers/boltz/provider';
import { ReverseSwapPostResponse, SubmarineSwapPostResponse, SwapStatusResponse } from './providers/boltz/types';

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
  sendBitcoin(address: string, amount: number): Promise<string>;
  sign(tx: any, indexes?: number[]): Promise<any>;
  broadcastTx(tx: any): Promise<{ txid: string }>;
  signerSession(): any;
}

export type Network = 'mainnet' | 'testnet' | 'regtest';

export interface CreateInvoiceResult {
  preimage: string;
  swapInfo: ReverseSwapPostResponse;
}
export interface PayInvoiceArgs {
  invoice: string;
  sourceVtxos?: Vtxo[];
  maxFeeSats?: number;
}

export interface PayInvoiceResult {
  swapInfo: SubmarineSwapPostResponse;
}

export interface PaymentResult {
  preimage: string;
  txid: string;
}

export type SwapData = SubmarineSwapPostResponse | ReverseSwapPostResponse | SwapStatusResponse;

export type SwapStatus =
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'refundable'
  | 'transaction.claimed'
  | 'invoice.settled'
  | 'swap.successful';

export interface RefundHandler {
  onRefundNeeded: (swapData: SubmarineSwapPostResponse) => Promise<void>;
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
