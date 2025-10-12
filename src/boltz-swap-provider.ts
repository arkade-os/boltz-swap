import { NetworkError, SchemaError, SwapError } from "./errors";
import {
    FeesResponse,
    LimitsResponse,
    Network,
    PendingReverseSwap,
    PendingSubmarineSwap,
} from "./types";

export interface SwapProviderConfig {
    apiUrl?: string;
    network: Network;
}

// Boltz swap status types

export type BoltzSwapStatus =
    | "invoice.expired"
    | "invoice.failedToPay"
    | "invoice.paid"
    | "invoice.pending"
    | "invoice.set"
    | "invoice.settled"
    | "swap.created"
    | "swap.expired"
    | "transaction.claim.pending"
    | "transaction.claimed"
    | "transaction.confirmed"
    | "transaction.failed"
    | "transaction.lockupFailed"
    | "transaction.mempool"
    | "transaction.refunded";

export const isSubmarineFailedStatus = (status: BoltzSwapStatus): boolean => {
    return [
        "invoice.failedToPay",
        "transaction.lockupFailed",
        "swap.expired",
    ].includes(status);
};

export const isSubmarineFinalStatus = (status: BoltzSwapStatus): boolean => {
    return [
        "invoice.failedToPay",
        "transaction.claimed",
        "swap.expired",
    ].includes(status);
};

export const isSubmarinePendingStatus = (status: BoltzSwapStatus): boolean => {
    return [
        "swap.created",
        "transaction.mempool",
        "transaction.confirmed",
        "invoice.set",
        "invoice.pending",
        "invoice.paid",
        "transaction.claim.pending",
    ].includes(status);
};

export const isSubmarineSuccessStatus = (status: BoltzSwapStatus): boolean => {
    return status === "transaction.claimed";
};

export const isReverseFailedStatus = (status: BoltzSwapStatus): boolean => {
    return [
        "invoice.expired",
        "transaction.failed",
        "transaction.refunded",
        "swap.expired",
    ].includes(status);
};

export const isReverseFinalStatus = (status: BoltzSwapStatus): boolean => {
    return [
        "transaction.refunded",
        "transaction.failed",
        "invoice.settled", // normal status for completed swaps
        "swap.expired",
    ].includes(status);
};

export const isReversePendingStatus = (status: BoltzSwapStatus): boolean => {
    return [
        "swap.created",
        "transaction.mempool",
        "transaction.confirmed",
    ].includes(status);
};

export const isReverseSuccessStatus = (status: BoltzSwapStatus): boolean => {
    return status === "invoice.settled";
};

// type guards

export const isPendingReverseSwap = (
    swap: PendingSubmarineSwap | PendingReverseSwap
): swap is PendingReverseSwap => {
    return swap.type === "reverse";
};

export const isPendingSubmarineSwap = (
    swap: PendingSubmarineSwap | PendingReverseSwap
): swap is PendingSubmarineSwap => {
    return swap.type === "submarine";
};

// refundable submarine swaps are those that have failed and can be refunded

export const isSubmarineRefundableStatus = (
    status: BoltzSwapStatus
): boolean => {
    return [
        "invoice.failedToPay",
        "transaction.lockupFailed",
        "swap.expired",
    ].includes(status);
};

export const isSubmarineSwapRefundable = (
    swap: PendingSubmarineSwap | PendingReverseSwap
): swap is PendingSubmarineSwap => {
    return (
        isSubmarineRefundableStatus(swap.status) &&
        isPendingSubmarineSwap(swap) &&
        swap.refundable !== false
    );
};

// API call types and validators

export type GetReverseSwapTxIdResponse = {
    id: string;
    timeoutBlockHeight: number;
};

export const isGetReverseSwapTxIdResponse = (
    data: any
): data is GetReverseSwapTxIdResponse => {
    return (
        data &&
        typeof data === "object" &&
        typeof data.id === "string" &&
        typeof data.timeoutBlockHeight === "number"
    );
};

export type GetSwapStatusResponse = {
    status: BoltzSwapStatus;
    zeroConfRejected?: boolean;
    transaction?: {
        id: string;
        hex?: string;
        eta?: number;
        preimage?: string;
    };
};

export const isGetSwapStatusResponse = (
    data: any
): data is GetSwapStatusResponse => {
    return (
        data &&
        typeof data === "object" &&
        typeof data.status === "string" &&
        (data.zeroConfRejected === undefined ||
            typeof data.zeroConfRejected === "boolean") &&
        (data.transaction === undefined ||
            (data.transaction &&
                typeof data.transaction === "object" &&
                typeof data.transaction.id === "string" &&
                (data.transaction.eta === undefined ||
                    typeof data.transaction.eta === "number") &&
                (data.transaction.hex === undefined ||
                    typeof data.transaction.hex === "string") &&
                (data.transaction.preimage === undefined ||
                    typeof data.transaction.preimage === "string")))
    );
};

type GetSubmarinePairsResponse = {
    ARK: {
        BTC: {
            hash: string;
            rate: number;
            limits: {
                maximal: number;
                minimal: number;
                maximalZeroConf: number;
            };
            fees: {
                percentage: number;
                minerFees: number;
            };
        };
    };
};

const isGetSubmarinePairsResponse = (
    data: any
): data is GetSubmarinePairsResponse => {
    return (
        data &&
        typeof data === "object" &&
        data.ARK &&
        typeof data.ARK === "object" &&
        data.ARK.BTC &&
        typeof data.ARK.BTC === "object" &&
        typeof data.ARK.BTC.hash === "string" &&
        typeof data.ARK.BTC.rate === "number" &&
        data.ARK.BTC.limits &&
        typeof data.ARK.BTC.limits === "object" &&
        typeof data.ARK.BTC.limits.maximal === "number" &&
        typeof data.ARK.BTC.limits.minimal === "number" &&
        typeof data.ARK.BTC.limits.maximalZeroConf === "number" &&
        data.ARK.BTC.fees &&
        typeof data.ARK.BTC.fees === "object" &&
        typeof data.ARK.BTC.fees.percentage === "number" &&
        typeof data.ARK.BTC.fees.minerFees === "number"
    );
};

type GetReversePairsResponse = {
    BTC: {
        ARK: {
            hash: string;
            rate: number;
            limits: {
                maximal: number;
                minimal: number;
            };
            fees: {
                percentage: number;
                minerFees: {
                    claim: number;
                    lockup: number;
                };
            };
        };
    };
};

const isGetReversePairsResponse = (
    data: any
): data is GetReversePairsResponse => {
    return (
        data &&
        typeof data === "object" &&
        data.BTC &&
        typeof data.BTC === "object" &&
        data.BTC.ARK &&
        typeof data.BTC.ARK === "object" &&
        data.BTC.ARK.hash &&
        typeof data.BTC.ARK.hash === "string" &&
        typeof data.BTC.ARK.rate === "number" &&
        data.BTC.ARK.limits &&
        typeof data.BTC.ARK.limits === "object" &&
        typeof data.BTC.ARK.limits.maximal === "number" &&
        typeof data.BTC.ARK.limits.minimal === "number" &&
        data.BTC.ARK.fees &&
        typeof data.BTC.ARK.fees === "object" &&
        typeof data.BTC.ARK.fees.percentage === "number" &&
        typeof data.BTC.ARK.fees.minerFees === "object" &&
        typeof data.BTC.ARK.fees.minerFees.claim === "number" &&
        typeof data.BTC.ARK.fees.minerFees.lockup === "number"
    );
};

export type CreateSubmarineSwapRequest = {
    invoice: string;
    refundPublicKey: string;
};

export type CreateSubmarineSwapResponse = {
    id: string;
    address: string;
    expectedAmount: number;
    claimPublicKey: string;
    acceptZeroConf: boolean;
    timeoutBlockHeights: {
        refund: number;
        unilateralClaim: number;
        unilateralRefund: number;
        unilateralRefundWithoutReceiver: number;
    };
};

export const isCreateSubmarineSwapResponse = (
    data: any
): data is CreateSubmarineSwapResponse => {
    return (
        data &&
        typeof data === "object" &&
        typeof data.id === "string" &&
        typeof data.address === "string" &&
        typeof data.expectedAmount === "number" &&
        typeof data.claimPublicKey === "string" &&
        typeof data.acceptZeroConf === "boolean" &&
        data.timeoutBlockHeights &&
        typeof data.timeoutBlockHeights === "object" &&
        typeof data.timeoutBlockHeights.unilateralClaim === "number" &&
        typeof data.timeoutBlockHeights.unilateralRefund === "number" &&
        typeof data.timeoutBlockHeights.unilateralRefundWithoutReceiver ===
            "number"
    );
};

export type GetSwapPreimageResponse = {
    preimage: string;
};

export const isGetSwapPreimageResponse = (
    data: any
): data is GetSwapPreimageResponse => {
    return (
        data && typeof data === "object" && typeof data.preimage === "string"
    );
};

export type CreateReverseSwapRequest = {
    claimPublicKey: string;
    invoiceAmount: number;
    preimageHash: string;
    /** Optional description forwarded to Boltz as the invoice description. May be omitted or subject to provider-side limits. */
    description?: string;
};

export type CreateReverseSwapResponse = {
    id: string;
    invoice: string;
    onchainAmount: number;
    lockupAddress: string;
    refundPublicKey: string;
    timeoutBlockHeights: {
        refund: number;
        unilateralClaim: number;
        unilateralRefund: number;
        unilateralRefundWithoutReceiver: number;
    };
};

export const isCreateReverseSwapResponse = (
    data: any
): data is CreateReverseSwapResponse => {
    return (
        data &&
        typeof data === "object" &&
        typeof data.id === "string" &&
        typeof data.invoice === "string" &&
        typeof data.onchainAmount === "number" &&
        typeof data.lockupAddress === "string" &&
        typeof data.refundPublicKey === "string" &&
        data.timeoutBlockHeights &&
        typeof data.timeoutBlockHeights === "object" &&
        typeof data.timeoutBlockHeights.refund === "number" &&
        typeof data.timeoutBlockHeights.unilateralClaim === "number" &&
        typeof data.timeoutBlockHeights.unilateralRefund === "number" &&
        typeof data.timeoutBlockHeights.unilateralRefundWithoutReceiver ===
            "number"
    );
};

const BASE_URLS: Partial<Record<Network, string>> = {
    bitcoin: "https://boltz.arkade.sh",
    mutinynet: "https://api.boltz.mutinynet.arkade.sh",
    regtest: "http://localhost:9069",
};

export class BoltzSwapProvider {
    private readonly wsUrl: string;
    private readonly apiUrl: string;
    private readonly network: Network;

    constructor(config: SwapProviderConfig) {
        this.network = config.network;
        this.apiUrl = config.apiUrl || BASE_URLS[config.network];
        if (!this.apiUrl)
            throw new Error(
                `API URL is required for network: ${config.network}`
            );
        this.wsUrl =
            this.apiUrl
                .replace(/^http(s)?:\/\//, "ws$1://")
                .replace("9069", "9004") + "/v2/ws";
    }

    getApiUrl(): string {
        return this.apiUrl;
    }

    getWsUrl(): string {
        return this.wsUrl;
    }

    getNetwork(): Network {
        return this.network;
    }

    async getFees(): Promise<FeesResponse> {
        const [submarine, reverse] = await Promise.all([
            this.request<GetSubmarinePairsResponse>(
                "/v2/swap/submarine",
                "GET"
            ),
            this.request<GetReversePairsResponse>("/v2/swap/reverse", "GET"),
        ]);
        if (!isGetSubmarinePairsResponse(submarine))
            throw new SchemaError({ message: "error fetching submarine fees" });
        if (!isGetReversePairsResponse(reverse))
            throw new SchemaError({ message: "error fetching reverse fees" });
        return {
            submarine: {
                percentage: submarine.ARK.BTC.fees.percentage,
                minerFees: submarine.ARK.BTC.fees.minerFees,
            },
            reverse: {
                percentage: reverse.BTC.ARK.fees.percentage,
                minerFees: reverse.BTC.ARK.fees.minerFees,
            },
        };
    }

    async getLimits(): Promise<LimitsResponse> {
        const response = await this.request<GetSubmarinePairsResponse>(
            "/v2/swap/submarine",
            "GET"
        );
        if (!isGetSubmarinePairsResponse(response))
            throw new SchemaError({ message: "error fetching limits" });
        return {
            min: response.ARK.BTC.limits.minimal,
            max: response.ARK.BTC.limits.maximal,
        };
    }

    async getReverseSwapTxId(id: string): Promise<GetReverseSwapTxIdResponse> {
        const res = await this.request<GetReverseSwapTxIdResponse>(
            `/v2/swap/reverse/${id}/transaction`,
            "GET"
        );
        if (!isGetReverseSwapTxIdResponse(res))
            throw new SchemaError({
                message: `error fetching txid for swap: ${id}`,
            });
        return res;
    }

    async getSwapStatus(id: string): Promise<GetSwapStatusResponse> {
        const response = await this.request<GetSwapStatusResponse>(
            `/v2/swap/${id}`,
            "GET"
        );
        if (!isGetSwapStatusResponse(response))
            throw new SchemaError({
                message: `error fetching status for swap: ${id}`,
            });
        return response;
    }

    async getSwapPreimage(id: string): Promise<GetSwapPreimageResponse> {
        const res = await this.request<GetSwapPreimageResponse>(
            `/v2/swap/submarine/${id}/preimage`,
            "GET"
        );
        if (!isGetSwapPreimageResponse(res))
            throw new SchemaError({
                message: `error fetching preimage for swap: ${id}`,
            });
        return res;
    }

    async createSubmarineSwap({
        invoice,
        refundPublicKey,
    }: CreateSubmarineSwapRequest): Promise<CreateSubmarineSwapResponse> {
        // refundPublicKey must be in compressed version (33 bytes / 66 hex chars)
        if (refundPublicKey.length != 66) {
            throw new SwapError({
                message: "refundPublicKey must be a compressed public key",
            });
        }
        // make submarine swap request
        const response = await this.request<CreateSubmarineSwapResponse>(
            "/v2/swap/submarine",
            "POST",
            {
                from: "ARK",
                to: "BTC",
                invoice,
                refundPublicKey,
            }
        );
        if (!isCreateSubmarineSwapResponse(response))
            throw new SchemaError({ message: "Error creating submarine swap" });
        return response;
    }

    async createReverseSwap({
        invoiceAmount,
        claimPublicKey,
        preimageHash,
        description,
    }: CreateReverseSwapRequest): Promise<CreateReverseSwapResponse> {
        // claimPublicKey must be in compressed version (33 bytes / 66 hex chars)
        if (claimPublicKey.length != 66) {
            throw new SwapError({
                message: "claimPublicKey must be a compressed public key",
            });
        }
        // make reverse swap request
        const requestBody: {
            from: "BTC";
            to: "ARK";
            invoiceAmount: number;
            claimPublicKey: string;
            preimageHash: string;
            description?: string;
        } = {
            from: "BTC",
            to: "ARK",
            invoiceAmount,
            claimPublicKey,
            preimageHash,
            ...(description?.trim() ? { description: description.trim() } : {}),
        };

        const response = await this.request<CreateReverseSwapResponse>(
            "/v2/swap/reverse",
            "POST",
            requestBody
        );
        if (!isCreateReverseSwapResponse(response))
            throw new SchemaError({ message: "Error creating reverse swap" });
        return response;
    }

    async monitorSwap(
        swapId: string,
        update: (type: BoltzSwapStatus, data?: any) => void
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const webSocket = new globalThis.WebSocket(this.wsUrl);

            const connectionTimeout = setTimeout(() => {
                webSocket.close();
                reject(new NetworkError("WebSocket connection timeout"));
            }, 30000); // 30 second timeout

            webSocket.onerror = (error) => {
                clearTimeout(connectionTimeout);
                reject(new NetworkError(`WebSocket error: ${error.message}`));
            };

            webSocket.onopen = () => {
                clearTimeout(connectionTimeout);
                webSocket.send(
                    JSON.stringify({
                        op: "subscribe",
                        channel: "swap.update",
                        args: [swapId],
                    })
                );
            };

            webSocket.onclose = () => {
                clearTimeout(connectionTimeout);
                resolve();
            };

            webSocket.onmessage = async (rawMsg) => {
                const msg = JSON.parse(rawMsg.data as string);

                // we are only interested in updates for the specific swap
                if (msg.event !== "update" || msg.args[0].id !== swapId) return;

                if (msg.args[0].error) {
                    webSocket.close();
                    reject(new SwapError({ message: msg.args[0].error }));
                }

                const status = msg.args[0].status as BoltzSwapStatus;

                switch (status) {
                    case "invoice.settled":
                    case "transaction.claimed":
                    case "transaction.refunded":
                    case "invoice.expired":
                    case "invoice.failedToPay":
                    case "transaction.failed":
                    case "transaction.lockupFailed":
                    case "swap.expired":
                        webSocket.close();
                        update(status);
                        break;
                    case "invoice.paid":
                    case "invoice.pending":
                    case "invoice.set":
                    case "swap.created":
                    case "transaction.claim.pending":
                    case "transaction.confirmed":
                    case "transaction.mempool":
                        update(status);
                }
            };
        });
    }

    private async request<T>(
        path: string,
        method: "GET" | "POST",
        body?: unknown
    ): Promise<T> {
        const url = `${this.apiUrl}${path}`;
        try {
            const response = await globalThis.fetch(url, {
                method,
                headers: { "Content-Type": "application/json" },
                body: body ? JSON.stringify(body) : undefined,
            });

            if (!response.ok) {
                const errorBody = await response.text();
                let errorData: any;
                try {
                    errorData = JSON.parse(errorBody);
                } catch {
                    // If parsing fails, errorData remains undefined
                }
                const message = errorData
                    ? `Boltz API error: ${response.status}`
                    : `Boltz API error: ${response.status} ${errorBody}`;
                throw new NetworkError(message, response.status, errorData);
            }
            if (response.headers.get("content-length") === "0") {
                throw new NetworkError("Empty response from Boltz API");
            }
            // Use type assertion to T, as we expect the API to return the correct type
            return (await response.json()) as T;
        } catch (error) {
            if (error instanceof NetworkError) throw error;
            throw new NetworkError(
                `Request to ${url} failed: ${(error as Error).message}`
            );
        }
    }
}
