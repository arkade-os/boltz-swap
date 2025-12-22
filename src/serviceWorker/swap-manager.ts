import { PendingSwap, SwapManagerConfig } from "../swap-manager";
import { BoltzSwapProvider, BoltzSwapStatus, SwapProviderConfig } from "../boltz-swap-provider";

import { Request, Response } from "@arkade-os/sdk";
import { SwapUpdater } from "./swap-updater";
import { hex } from "@scure/base";
import { PendingReverseSwap, PendingSubmarineSwap } from "../types";
import { logger } from "../logger";

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

export class ServiceWorkerSwapManager {
    private swapUpdateListeners = new Set<SwapUpdateListener>();
    private swapCompletedListeners = new Set<SwapCompletedListener>();
    private swapFailedListeners = new Set<SwapFailedListener>();


    constructor(
        public readonly serviceWorker: ServiceWorker,
        private config: SwapManagerConfig
    ) {
        navigator.serviceWorker.addEventListener("message", (m) => {
            if (m.data.prefix !== SwapUpdater.messagePrefix) return;
            console.debug("[Swap Manager] broadcast received", m);
            this.onBroadcastMessage(m)
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

    async getMonitoredSwaps(): Promise<PendingSwap[]> {
        const res: any = await this.sendMessage({ type: "GET_MONITORED_SWAPS", id: getRandomId() } as any)
        if (res.success && res.payload.swaps) return res.payload.swaps;
        console.error("invalid response", res);
        throw  new Error("Failed to get monitored swaps");
    }

    async getSwap(swapId: string): Promise<PendingSwap | undefined> {
        const res: any = await this.sendMessage({
            type: "GET_SWAP",
            id: getRandomId(),
            swapId,
        } as any);
        if (res.success && res.payload.swap) return res.payload.swap;
        console.error("invalid response", res);
        return undefined;
    }

    async monitorSwap(swap: PendingSwap): Promise<void> {
        const res = await this.sendMessage({ type: "MONITOR_SWAP", swap } as any);
        if (res.success) return;
        throw  new Error("Failed to monitor swap");
    }

    async stopMonitoringSwap(swapId: string): Promise<void> {
        const res = await this.sendMessage({ type: "STOP_MONITORING_SWAP", swapId } as any);
        if (res.success) return;
        throw  new Error("Failed to stop monitoring swap");
    }

    async getReverseSwapTxId(swapId: string): Promise<string> {
        const res: any = await this.sendMessage({ type: "GET_REVERSE_SWAP_TX_ID" as any, id: getRandomId()  as any, payload: { swapId}})
        if (res.success && res.payload.txid) return res.payload.txid;
        console.error("invalid response", res);
        throw  new Error("Failed to get reverse swap txid");
    }

    async getWsUrl(): Promise<string> {
        const res: any = await this.sendMessage({ type: "GET_WS_URL", id: getRandomId() } as any)
        if (res.success && res.payload.wsUrl) return res.payload.wsUrl;
        console.error("invalid response", res);
        throw  new Error("Failed to get ws url");
    }

    async notifySwapStatusUpdate( input: { swapId: string, status: BoltzSwapStatus, error: string}): Promise<void> {
        const res  = await this.sendMessage({ type: "SWAP_STATUS_UPDATED", id: getRandomId(), payload: {
            swapId: input.swapId, error: input.error, status: input.status
            }} as any)
        if (res.success) return;
        throw  new Error("Failed to notify swap status update");
    }

    // send a message and wait for a response
    private async sendMessage<T extends Request.Base>(
        message: T
    ): Promise<Response.Base<any>> {
        return new Promise((resolve, reject) => {
            const messageHandler = (event: MessageEvent) => {
                const response = event.data.payload as Response.Base<any>;
                if (response.id === "") {
                    reject(new Error("Invalid response id"));
                    return;
                }
                if (response.id !== message.id) {
                    return;
                }
                navigator.serviceWorker.removeEventListener(
                    "message",
                    messageHandler
                );

                if (!response.success) {
                    reject(new Error((response as Response.Error).message));
                } else {
                    resolve(response);
                }
            };

            navigator.serviceWorker.addEventListener("message", messageHandler);
            console.log("Sending message to SW:", message);
            this.serviceWorker.postMessage({
                prefix: SwapUpdater.messagePrefix,
                id: message.id,
                type: message.type,
                payload: message,
            });
        });
    }

    private async onBroadcastMessage(event: MessageEvent) {
        const message = event.data;
        switch (message.type) {
            case "SWAP_FAILED": {
                const {swap, error} = message.payload;
                this.swapFailedListeners.forEach((listener) =>
                    listener(swap, new Error(error)))
                }
                return
            case "SWAP_STATUS_UPDATED": {
                const { swap, previousStatus } = message.payload;
                this.swapUpdateListeners.forEach((listener) =>
                    listener(swap, previousStatus)
                );
                return
            }
            case "SWAP_COMPLETED": {
                const {swap} = message.payload;
                this.swapCompletedListeners.forEach((listener) => listener(swap));
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