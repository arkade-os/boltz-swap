import {
    ArkProvider,
    IndexerProvider,
    ServiceWorkerWallet,
    Wallet,
} from "@arkade-os/sdk";
import {
    CreateReverseSwapResponse,
    CreateSubmarineSwapResponse,
    BoltzSwapProvider,
    CreateReverseSwapRequest,
    CreateSubmarineSwapRequest,
    BoltzSwapStatus,
} from "./boltz-swap-provider";

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

export type Network = "bitcoin" | "mutinynet" | "regtest" | "signet";

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
    id: string;
    type: "reverse";
    createdAt: number;
    preimage: string;
    status: BoltzSwapStatus;
    request: CreateReverseSwapRequest;
    response: CreateReverseSwapResponse;
}

export interface PendingSubmarineSwap {
    id: string;
    type: "submarine";
    createdAt: number;
    preimage?: string;
    refundable?: boolean;
    status: BoltzSwapStatus;
    request: CreateSubmarineSwapRequest;
    response: CreateSubmarineSwapResponse;
}

export interface RefundHandler {
    onRefundNeeded: (swapData: PendingSubmarineSwap) => Promise<void>;
}

export interface ArkadeLightningConfig {
    wallet: Wallet | ServiceWorkerWallet;
    arkProvider?: ArkProvider;
    swapProvider: BoltzSwapProvider;
    indexerProvider?: IndexerProvider;
    feeConfig?: Partial<FeeConfig>;
    refundHandler?: RefundHandler;
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
    on(event: "pending", listener: () => void): this;
    on(event: "created", listener: () => void): this;
    on(event: "settled", listener: () => void): this;
    on(event: "failed", listener: (error: Error) => void): this;
    unsubscribe(): void;
}

export interface LimitsResponse {
    min: number;
    max: number;
}

/**
 * Fee info returned by Boltz.
 * - percentage: value (e.g., 0.01 = 0.01%)
 * - minerFees: values in satoshis
 */
export interface FeesResponse {
    submarine: {
        percentage: number;
        minerFees: number;
    };
    reverse: {
        percentage: number;
        minerFees: {
            lockup: number;
            claim: number;
        };
    };
}
