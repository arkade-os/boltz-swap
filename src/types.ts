import {
    ArkProvider,
    IndexerProvider,
    NetworkName,
    ServiceWorkerWallet,
    Wallet,
    IContractManager,
} from "@arkade-os/sdk";
import {
    CreateReverseSwapResponse,
    CreateSubmarineSwapResponse,
    BoltzSwapProvider,
    CreateReverseSwapRequest,
    CreateSubmarineSwapRequest,
    BoltzSwapStatus,
} from "./boltz-swap-provider";
import { SwapManagerConfig } from "./swap-manager";
import { SwapRepository } from "./repositories/swap-repository";

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

export type Network = NetworkName;

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
    /** Original preimage hash from Boltz (available for restored swaps) */
    preimageHash?: string;
    refunded?: boolean;
    refundable?: boolean;
    status: BoltzSwapStatus;
    request: CreateSubmarineSwapRequest;
    response: CreateSubmarineSwapResponse;
}

export interface RefundHandler {
    onRefundNeeded: (swapData: PendingSubmarineSwap) => Promise<void>;
}

export interface ArkadeLightningConfig {
    serviceWorker: ServiceWorker;
    wallet: Wallet | ServiceWorkerWallet;
    arkProvider?: ArkProvider;
    swapProvider: BoltzSwapProvider;
    indexerProvider?: IndexerProvider;
    feeConfig?: Partial<FeeConfig>;
    refundHandler?: RefundHandler;
    timeoutConfig?: Partial<TimeoutConfig>;
    retryConfig?: Partial<RetryConfig>;
    /**
     * Enable background swap monitoring and autonomous actions.
     * - `false` or `undefined`: SwapManager disabled
     * - `true`: SwapManager enabled with default configuration
     * - `SwapManagerConfig` object: SwapManager enabled with custom configuration
     */
    swapManager?: boolean | (SwapManagerConfig & { autoStart?: boolean });
    contractManager?: IContractManager;
    /**
     * Optional swap repository to use for persisting swap data.
     * - `undefined`: fallback to default IndexedDbSwapRepository
     * - `SwapRepository` object: SwapRepository enabled with custom configuration
     */
    swapRepository?: SwapRepository;
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
