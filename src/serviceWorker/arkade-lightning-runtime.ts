import { GetSwapStatusResponse, BoltzSwapStatus } from "../boltz-swap-provider";
import {
    ArkadeLightningConfig,
    CreateLightningInvoiceRequest,
    CreateLightningInvoiceResponse,
    FeesResponse,
    LimitsResponse,
    Network,
    PendingReverseSwap,
    PendingSubmarineSwap,
    SendLightningPaymentRequest,
    SendLightningPaymentResponse,
} from "../types";
import { SwapRepository } from "../repositories/swap-repository";
import {
    ArkadeLightningUpdaterRequest,
    ArkadeLightningUpdaterResponse,
    DEFAULT_MESSAGE_TAG,
    RequestInitArkLn,
} from "./arkade-lightning-message-handler";
import type {
    ResponseCreateLightningInvoice,
    ResponseCreateReverseSwap,
    ResponseCreateSubmarineSwap,
    ResponseGetFees,
    ResponseGetLimits,
    ResponseGetPendingReverseSwaps,
    ResponseGetPendingSubmarineSwaps,
    ResponseGetSwapHistory,
    ResponseGetSwapStatus,
    ResponseRestoreSwaps,
    ResponseSendLightningPayment,
    ResponseWaitAndClaim,
    ResponseWaitForSwapSettlement,
} from "./arkade-lightning-message-handler";
import type { VHTLC } from "@arkade-os/sdk";
import { IArkadeLightning } from "../arkade-lightning";
import { IndexedDbSwapRepository } from "../repositories/IndexedDb/swap-repository";
import type { SwapManagerClient } from "../swap-manager";

export type SvcWrkArkadeLightningConfig = Pick<
    ArkadeLightningConfig,
    "swapManager" | "swapProvider" | "swapRepository"
> & {
    serviceWorker: ServiceWorker;
    messageTag?: string;
    network: Network;
    arkServerUrl: string;
};

export class SwArkadeLightningRuntime implements IArkadeLightning {
    private eventListenerInitialized = false;
    private swapUpdateListeners = new Set<
        (swap: PendingReverseSwap | PendingSubmarineSwap, oldStatus: BoltzSwapStatus) => void
    >();
    private swapCompletedListeners = new Set<
        (swap: PendingReverseSwap | PendingSubmarineSwap) => void
    >();
    private swapFailedListeners = new Set<
        (swap: PendingReverseSwap | PendingSubmarineSwap, error: Error) => void
    >();
    private actionExecutedListeners = new Set<
        (swap: PendingReverseSwap | PendingSubmarineSwap, action: "claim" | "refund") => void
    >();
    private wsConnectedListeners = new Set<() => void>();
    private wsDisconnectedListeners = new Set<(error?: Error) => void>();

    private constructor(
        private readonly messageTag: string,
        public readonly serviceWorker: ServiceWorker,
        public readonly swapRepository: SwapRepository, // expose methods, not the repo
        private readonly withSwapManager: boolean
    ) {}

    static async create(config: SvcWrkArkadeLightningConfig) {
        const messageTag = config.messageTag ?? DEFAULT_MESSAGE_TAG;

        const swapRepository =
            config.swapRepository ?? new IndexedDbSwapRepository();

        const svcArkadeLightning = new SwArkadeLightningRuntime(
            messageTag,
            config.serviceWorker,
            swapRepository,
            Boolean(config.swapManager)
        );

        const initMessage: RequestInitArkLn = {
            tag: messageTag,
            id: getRandomId(),
            type: "INIT_ARKADE_LIGHTNING",
            payload: {
                network: config.network,
                arkServerUrl: config.arkServerUrl,
                swapProvider: { baseUrl: config.swapProvider.getApiUrl() },
            },
        };

        await svcArkadeLightning.sendMessage(initMessage);

        return svcArkadeLightning;
    }

    async startSwapManager(): Promise<void> {
        if (!this.withSwapManager) {
            throw new Error("SwapManager is not enabled.");
        }

        await this.sendMessage({
            id: getRandomId(),
            tag: this.messageTag,
            type: "SM-START",
        });
    }

    async stopSwapManager(): Promise<void> {
        if (!this.withSwapManager) return;

        await this.sendMessage({
            id: getRandomId(),
            tag: this.messageTag,
            type: "SM-STOP",
        });
    }

    getSwapManager(): SwapManagerClient | null {
        if (!this.withSwapManager) {
            return null;
        }

        this.initEventStream();

        const send = this.sendMessage.bind(this);
        const tag = this.messageTag;

        const proxy = {
            start: async () => {
                await send({
                    id: getRandomId(),
                    tag,
                    type: "SM-START",
                });
            },
            stop: async () => {
                await send({
                    id: getRandomId(),
                    tag,
                    type: "SM-STOP",
                });
            },
            addSwap: async (
                swap: PendingReverseSwap | PendingSubmarineSwap
            ) => {
                await send({
                    id: getRandomId(),
                    tag,
                    type: "SM-ADD_SWAP",
                    payload: swap,
                });
            },
            removeSwap: async (swapId: string) => {
                await send({
                    id: getRandomId(),
                    tag,
                    type: "SM-REMOVE_SWAP",
                    payload: { swapId },
                });
            },
            getPendingSwaps: async () => {
                const res = await send({
                    id: getRandomId(),
                    tag,
                    type: "SM-GET_PENDING_SWAPS",
                });
                return (
                    res as ArkadeLightningUpdaterResponse & {
                        payload: (PendingReverseSwap | PendingSubmarineSwap)[];
                    }
                ).payload;
            },
            hasSwap: async (swapId: string) => {
                const res = await send({
                    id: getRandomId(),
                    tag,
                    type: "SM-HAS_SWAP",
                    payload: { swapId },
                });
                return (
                    res as ArkadeLightningUpdaterResponse & {
                        payload: { has: boolean };
                    }
                ).payload.has;
            },
            isProcessing: async (swapId: string) => {
                const res = await send({
                    id: getRandomId(),
                    tag,
                    type: "SM-IS_PROCESSING",
                    payload: { swapId },
                });
                return (
                    res as ArkadeLightningUpdaterResponse & {
                        payload: { processing: boolean };
                    }
                ).payload.processing;
            },
            getStats: async () => {
                const res = await send({
                    id: getRandomId(),
                    tag,
                    type: "SM-GET_STATS",
                });
                return (
                    res as ArkadeLightningUpdaterResponse & {
                        payload: {
                            isRunning: boolean;
                            monitoredSwaps: number;
                            websocketConnected: boolean;
                            usePollingFallback: boolean;
                            currentReconnectDelay: number;
                            currentPollRetryDelay: number;
                        };
                    }
                ).payload;
            },
            waitForSwapCompletion: async (swapId: string) => {
                const res = await send({
                    id: getRandomId(),
                    tag,
                    type: "SM-WAIT_FOR_COMPLETION",
                    payload: { swapId },
                });
                return (
                    res as ArkadeLightningUpdaterResponse & {
                        payload: { txid: string };
                    }
                ).payload;
            },
            subscribeToSwapUpdates: async () => () => {},
            onSwapUpdate: async (
                listener: (
                    swap: PendingReverseSwap | PendingSubmarineSwap,
                    oldStatus: BoltzSwapStatus
                ) => void
            ) => {
                this.swapUpdateListeners.add(listener);
                return () => this.swapUpdateListeners.delete(listener);
            },
            onSwapCompleted: async (
                listener: (
                    swap: PendingReverseSwap | PendingSubmarineSwap
                ) => void
            ) => {
                this.swapCompletedListeners.add(listener);
                return () => this.swapCompletedListeners.delete(listener);
            },
            onSwapFailed: async (
                listener: (
                    swap: PendingReverseSwap | PendingSubmarineSwap,
                    error: Error
                ) => void
            ) => {
                this.swapFailedListeners.add(listener);
                return () => this.swapFailedListeners.delete(listener);
            },
            onActionExecuted: async (
                listener: (
                    swap: PendingReverseSwap | PendingSubmarineSwap,
                    action: "claim" | "refund"
                ) => void
            ) => {
                this.actionExecutedListeners.add(listener);
                return () => this.actionExecutedListeners.delete(listener);
            },
            onWebSocketConnected: async (listener: () => void) => {
                this.wsConnectedListeners.add(listener);
                return () => this.wsConnectedListeners.delete(listener);
            },
            onWebSocketDisconnected: async (
                listener: (error?: Error) => void
            ) => {
                this.wsDisconnectedListeners.add(listener);
                return () => this.wsDisconnectedListeners.delete(listener);
            },
        };

        return proxy as SwapManagerClient;
    }

    async createLightningInvoice(
        args: CreateLightningInvoiceRequest
    ): Promise<CreateLightningInvoiceResponse> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "CREATE_LIGHTNING_INVOICE",
                payload: args,
            });
            return (res as ResponseCreateLightningInvoice).payload;
        } catch (e) {
            throw new Error("Cannot create Lightning Invoice", { cause: e });
        }
    }

    async sendLightningPayment(
        args: SendLightningPaymentRequest
    ): Promise<SendLightningPaymentResponse> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "SEND_LIGHTNING_PAYMENT",
                payload: args,
            });
            return (res as ResponseSendLightningPayment).payload;
        } catch (e) {
            throw new Error("Cannot send Lightning payment", { cause: e });
        }
    }

    async createSubmarineSwap(
        args: SendLightningPaymentRequest
    ): Promise<PendingSubmarineSwap> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "CREATE_SUBMARINE_SWAP",
                payload: args,
            });
            return (res as ResponseCreateSubmarineSwap).payload;
        } catch (e) {
            throw new Error("Cannot create submarine swap", { cause: e });
        }
    }

    async createReverseSwap(
        args: CreateLightningInvoiceRequest
    ): Promise<PendingReverseSwap> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "CREATE_REVERSE_SWAP",
                payload: args,
            });
            return (res as ResponseCreateReverseSwap).payload;
        } catch (e) {
            throw new Error("Cannot create reverse swap", { cause: e });
        }
    }

    async claimVHTLC(pendingSwap: PendingReverseSwap): Promise<void> {
        await this.sendMessage({
            id: getRandomId(),
            tag: this.messageTag,
            type: "CLAIM_VHTLC",
            payload: pendingSwap,
        });
    }

    async refundVHTLC(pendingSwap: PendingSubmarineSwap): Promise<void> {
        await this.sendMessage({
            id: getRandomId(),
            tag: this.messageTag,
            type: "REFUND_VHTLC",
            payload: pendingSwap,
        });
    }

    async waitAndClaim(
        pendingSwap: PendingReverseSwap
    ): Promise<{ txid: string }> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "WAIT_AND_CLAIM",
                payload: pendingSwap,
            });
            return (res as ResponseWaitAndClaim).payload;
        } catch (e) {
            throw new Error("Cannot wait and claim reverse swap", {
                cause: e,
            });
        }
    }

    async waitForSwapSettlement(
        pendingSwap: PendingSubmarineSwap
    ): Promise<{ preimage: string }> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "WAIT_FOR_SWAP_SETTLEMENT",
                payload: pendingSwap,
            });
            return (res as ResponseWaitForSwapSettlement).payload;
        } catch (e) {
            throw new Error("Cannot wait for swap settlement", { cause: e });
        }
    }

    async restoreSwaps(boltzFees?: FeesResponse): Promise<{
        reverseSwaps: PendingReverseSwap[];
        submarineSwaps: PendingSubmarineSwap[];
    }> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "RESTORE_SWAPS",
                payload: boltzFees,
            });
            return (res as ResponseRestoreSwaps).payload;
        } catch (e) {
            throw new Error("Cannot restore swaps", { cause: e });
        }
    }

    enrichReverseSwapPreimage(
        _swap: PendingReverseSwap,
        _preimage: string
    ): PendingReverseSwap {
        throw new Error(
            "enrichReverseSwapPreimage is not supported via service worker"
        );
    }

    enrichSubmarineSwapInvoice(
        _swap: PendingSubmarineSwap,
        _invoice: string
    ): PendingSubmarineSwap {
        throw new Error(
            "enrichSubmarineSwapInvoice is not supported via service worker"
        );
    }

    createVHTLCScript(_args: {
        network: string;
        preimageHash: Uint8Array;
        receiverPubkey: string;
        senderPubkey: string;
        serverPubkey: string;
        timeoutBlockHeights: {
            refund: number;
            unilateralClaim: number;
            unilateralRefund: number;
            unilateralRefundWithoutReceiver: number;
        };
    }): { vhtlcScript: VHTLC.Script; vhtlcAddress: string } {
        throw new Error(
            "createVHTLCScript is not supported via service worker"
        );
    }

    async getFees(): Promise<FeesResponse> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "GET_FEES",
            });
            return (res as ResponseGetFees).payload;
        } catch (e) {
            throw new Error("Cannot get fees", { cause: e });
        }
    }

    async getLimits(): Promise<LimitsResponse> {
        try {
            console.log("--- getting limits via message");
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "GET_LIMITS",
            });
            return (res as ResponseGetLimits).payload;
        } catch (e) {
            throw new Error("Cannot get limits", { cause: e });
        }
    }

    async getSwapStatus(swapId: string): Promise<GetSwapStatusResponse> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "GET_SWAP_STATUS",
                payload: { swapId },
            });
            return (res as ResponseGetSwapStatus).payload;
        } catch (e) {
            throw new Error("Cannot get swap status", { cause: e });
        }
    }

    async getPendingSubmarineSwaps(): Promise<PendingSubmarineSwap[]> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "GET_PENDING_SUBMARINE_SWAPS",
            });
            return (res as ResponseGetPendingSubmarineSwaps).payload;
        } catch (e) {
            throw new Error("Cannot get pending submarine swaps", {
                cause: e,
            });
        }
    }

    async getPendingReverseSwaps(): Promise<PendingReverseSwap[]> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "GET_PENDING_REVERSE_SWAPS",
            });
            return (res as ResponseGetPendingReverseSwaps).payload;
        } catch (e) {
            throw new Error("Cannot get pending reverse swaps", { cause: e });
        }
    }

    async getSwapHistory(): Promise<
        (PendingReverseSwap | PendingSubmarineSwap)[]
    > {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "GET_SWAP_HISTORY",
            });
            return (res as ResponseGetSwapHistory).payload;
        } catch (e) {
            throw new Error("Cannot get swap history", { cause: e });
        }
    }

    async refreshSwapsStatus(): Promise<void> {
        await this.sendMessage({
            id: getRandomId(),
            tag: this.messageTag,
            type: "REFRESH_SWAPS_STATUS",
        });
    }

    async dispose(): Promise<void> {
        if (this.withSwapManager) {
            await this.stopSwapManager().catch(() => {});
        }
    }

    async [Symbol.asyncDispose](): Promise<void> {
        return this.dispose();
    }

    private async sendMessage(
        request: ArkadeLightningUpdaterRequest
    ): Promise<ArkadeLightningUpdaterResponse> {
        return new Promise((resolve, reject) => {
            const messageHandler = (event: MessageEvent) => {
                const response = event.data;
                if (request.id !== response.id) {
                    return;
                }

                navigator.serviceWorker.removeEventListener(
                    "message",
                    messageHandler
                );
                if (response.error) {
                    reject(response.error);
                } else {
                    resolve(response);
                }
            };

            navigator.serviceWorker.addEventListener("message", messageHandler);
            this.serviceWorker.postMessage(request);
        });
    }

    private initEventStream() {
        if (this.eventListenerInitialized) return;
        this.eventListenerInitialized = true;
        navigator.serviceWorker.addEventListener(
            "message",
            this.handleEventMessage
        );
    }

    private handleEventMessage = (event: MessageEvent) => {
        const data = event.data;
        if (!data || data.tag !== this.messageTag) return;
        if (typeof data.type !== "string") return;
        if (!data.type.startsWith("SM-EVENT-")) return;

        switch (data.type) {
            case "SM-EVENT-SWAP_UPDATE":
                this.swapUpdateListeners.forEach((cb) =>
                    cb(data.payload.swap, data.payload.oldStatus)
                );
                break;
            case "SM-EVENT-SWAP_COMPLETED":
                this.swapCompletedListeners.forEach((cb) =>
                    cb(data.payload.swap)
                );
                break;
            case "SM-EVENT-SWAP_FAILED": {
                const err = new Error(data.payload.error?.message);
                this.swapFailedListeners.forEach((cb) =>
                    cb(data.payload.swap, err)
                );
                break;
            }
            case "SM-EVENT-ACTION_EXECUTED":
                this.actionExecutedListeners.forEach((cb) =>
                    cb(data.payload.swap, data.payload.action)
                );
                break;
            case "SM-EVENT-WS_CONNECTED":
                this.wsConnectedListeners.forEach((cb) => cb());
                break;
            case "SM-EVENT-WS_DISCONNECTED": {
                const err = data.payload?.errorMessage
                    ? new Error(data.payload.errorMessage)
                    : undefined;
                this.wsDisconnectedListeners.forEach((cb) => cb(err));
                break;
            }
            default:
                break;
        }
    };
}

function getRandomId(): string {
    return `${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
}
