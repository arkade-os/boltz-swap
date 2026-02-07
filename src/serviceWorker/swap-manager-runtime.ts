import { SwapManagerConfig } from "../swap-manager";
import { BoltzSwapProvider, BoltzSwapStatus } from "../boltz-swap-provider";

import {
    SwapMessageHandler,
    ResponseGetMonitoredSwaps,
    ResponseGetSwap,
    ResponseGetReverseSwapTx,
    ResponseGetWsUrl,
    SwapUpdaterRequest,
    SwapUpdaterResponse,
} from "./swap-message-handler";
import { hex } from "@scure/base";
import { PendingReverseSwap, PendingSubmarineSwap } from "../types";
import { PendingSwap } from "../repositories/swap-repository";

// Event listener types
export type SwapUpdateListener = (
    swap: PendingReverseSwap | PendingSubmarineSwap,
    oldStatus: BoltzSwapStatus
) => void;
export type SwapCompletedListener = (
    swap: PendingReverseSwap | PendingSubmarineSwap
) => void;
export type SwapFailedListener = (
    swap: PendingReverseSwap | PendingSubmarineSwap,
    error: Error
) => void;
export type ActionExecutedListener = (
    swap: PendingReverseSwap | PendingSubmarineSwap,
    action: "claim" | "refund"
) => void;

export class SwSwapManagerRuntime {
    private swapUpdateListeners = new Set<SwapUpdateListener>();
    private swapCompletedListeners = new Set<SwapCompletedListener>();
    private swapFailedListeners = new Set<SwapFailedListener>();

    constructor(
        public readonly serviceWorker: ServiceWorker,
        config: SwapManagerConfig
    ) {
        navigator.serviceWorker.addEventListener("message", (m) => {
            if (m.data.tag !== SwapMessageHandler.messageTag) return;
            console.debug("[Swap Manager] broadcast received", m);
            this.onBroadcastMessage(m);
        });
        if (config.events?.onSwapUpdate) {
            this.swapUpdateListeners.add(config.events.onSwapUpdate);
        }
        if (config.events?.onSwapCompleted) {
            this.swapCompletedListeners.add(config.events.onSwapCompleted);
        }
        if (config.events?.onSwapFailed) {
            this.swapFailedListeners.add(config.events.onSwapFailed);
        }
    }

    async init(config: {
        network: ReturnType<BoltzSwapProvider["getNetwork"]>;
        apiUrl: string;
    }): Promise<void> {
        await this.sendMessage({
            id: getRandomId(),
            tag: SwapMessageHandler.messageTag,
            type: "INIT",
            payload: {
                apiUrl: config.apiUrl,
                network: config.network,
            },
        });
    }

    async getMonitoredSwaps(): Promise<PendingSwap[]> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: SwapMessageHandler.messageTag,
                type: "GET_MONITORED_SWAPS",
            });
            return (res as ResponseGetMonitoredSwaps).payload.swaps;
        } catch (e) {
            throw new Error("Failed to get monitored swaps", { cause: e });
        }
    }

    async getSwap(swapId: string): Promise<PendingSwap | undefined> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: SwapMessageHandler.messageTag,
                type: "GET_SWAP",
                payload: { swapId },
            });
            return (res as ResponseGetSwap).payload.swap;
        } catch (e) {
            throw new Error(`Failed to get swap ${swapId}`, { cause: e });
        }
    }

    async monitorSwap(swap: PendingSwap): Promise<void> {
        await this.sendMessage({
            id: getRandomId(),
            tag: SwapMessageHandler.messageTag,
            type: "MONITOR_SWAP",
            payload: { swap },
        });
    }

    async stopMonitoringSwap(swapId: string): Promise<void> {
        await this.sendMessage({
            id: getRandomId(),
            tag: SwapMessageHandler.messageTag,
            type: "STOP_MONITORING_SWAP",
            payload: { swapId },
        });
    }

    async getReverseSwapTxId(swapId: string): Promise<string> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: SwapMessageHandler.messageTag,
                type: "GET_REVERSE_SWAP_TX_ID",
                payload: { swapId },
            });
            return (res as ResponseGetReverseSwapTx).payload.txid;
        } catch (e) {
            throw new Error(`Failed to get reverse swap txid for ${swapId}`, {
                cause: e,
            });
        }
    }

    async getWsUrl(): Promise<string> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: SwapMessageHandler.messageTag,
                type: "GET_WS_URL",
            });
            return (res as ResponseGetWsUrl).payload.wsUrl;
        } catch (e) {
            throw new Error("Failed to get swap websocket URL", { cause: e });
        }
    }

    async notifySwapStatusUpdate(input: {
        swapId: string;
        status: BoltzSwapStatus;
        error: string;
    }): Promise<void> {
        await this.sendMessage({
            type: "SWAP_STATUS_UPDATED",
            id: getRandomId(),
            tag: SwapMessageHandler.messageTag,
            payload: {
                swapId: input.swapId,
                error: input.error,
                status: input.status,
            },
        });
    }

    // send a message and wait for a response
    private async sendMessage(
        request: SwapUpdaterRequest
    ): Promise<SwapUpdaterResponse> {
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

    private async onBroadcastMessage(event: MessageEvent) {
        const message = event.data;
        switch (message.type) {
            case "SWAP_FAILED":
                {
                    const { swap, error } = message.payload;
                    this.swapFailedListeners.forEach((listener) =>
                        listener(swap, new Error(error))
                    );
                }
                return;
            case "SWAP_STATUS_UPDATED": {
                const { swap, previousStatus } = message.payload;
                this.swapUpdateListeners.forEach((listener) =>
                    listener(swap, previousStatus)
                );
                return;
            }
            case "SWAP_COMPLETED": {
                const { swap } = message.payload;
                this.swapCompletedListeners.forEach((listener) =>
                    listener(swap)
                );
            }
        }
    }

    /**
     * Add an event listener for swap updates
     * @returns Unsubscribe function
     */
    onSwapUpdate(listener: SwapUpdateListener): () => void {
        this.swapUpdateListeners.add(listener);
        return () => this.swapUpdateListeners.delete(listener);
    }

    /**
     * Add an event listener for swap completion
     * @returns Unsubscribe function
     */
    onSwapCompleted(listener: SwapCompletedListener): () => void {
        this.swapCompletedListeners.add(listener);
        return () => this.swapCompletedListeners.delete(listener);
    }

    /**
     * Add an event listener for swap failures
     * @returns Unsubscribe function
     */
    onSwapFailed(listener: SwapFailedListener): () => void {
        this.swapFailedListeners.add(listener);
        return () => this.swapFailedListeners.delete(listener);
    }

    /**
     * Remove an event listener for swap updates
     */
    offSwapUpdate(listener: SwapUpdateListener): void {
        this.swapUpdateListeners.delete(listener);
    }

    /**
     * Remove an event listener for swap completion
     */
    offSwapCompleted(listener: SwapCompletedListener): void {
        this.swapCompletedListeners.delete(listener);
    }

    /**
     * Remove an event listener for swap failures
     */
    offSwapFailed(listener: SwapFailedListener): void {
        this.swapFailedListeners.delete(listener);
    }
}

function getRandomId(): string {
    const randomValue = crypto.getRandomValues(new Uint8Array(16));
    return hex.encode(randomValue);
}
