import { IUpdater, Response /* , RequestEnvelope, ResponseEnvelope */ } from "@arkade-os/sdk";
import { PendingSwap, SwapManager, SwapManagerConfig } from "../swap-manager";
import { logger } from "../logger";
import {
    BoltzSwapProvider,
    BoltzSwapStatus,
    isReverseFinalStatus,
    isSubmarineFinalStatus,
} from "../boltz-swap-provider";
import { NetworkName } from "@arkade-os/sdk";

type Type = "SWAP_UPDATED" | "SWAP_FAILED" |"SWAP_COMPLETED" | "ERROR" | "INITIALIZED";
type Payload = ReturnType<typeof swapUpdated| typeof initialized> ;

export interface SwapUpdatedEvent extends Response.Base<Type> {
    swap: PendingSwap;
    previousStatus: PendingSwap["status"];
}
const swapUpdated = (
    swap: PendingSwap,
    previousStatus: PendingSwap["status"]
): SwapUpdatedEvent => ({
    success: true,
    id: "no-id",
    type: "SWAP_UPDATED",
    swap,
    previousStatus,
} as any);
export interface SwapFailedEvent extends Response.Base<Type> {
    swap: PendingSwap;
    error: string;
}
const swapFailed = (swap: PendingSwap, error: string): SwapFailedEvent => ({
    type: "SWAP_FAILED",
    success: false,
    id: "no-id",
    swap,
    error,
});
const swapCompleted = (
    swap: PendingSwap,
): SwapUpdatedEvent =>
    ({
        success: true,
        id: "no-id",
        type: "SWAP_COMPLETED",
        swap,
    }) as any;
export const initialized = (id: string): Response.Base<Type> => ({
    type: "INITIALIZED",
    success: true,
    id
});


type SwapUpdaterRequest = any ; // RequestEnvelope<string, unknown>;
type SwapUpdaterResponse = any ; // ResponseEnvelope<Type, Payload>;

type SwapUpdaterConfig = { pollInterval?: number };
export class SwapUpdater
    implements
        IUpdater<
            SwapUpdaterRequest["type"],
            SwapUpdaterRequest["payload"],
            SwapUpdaterResponse["type"],
            SwapUpdaterResponse["payload"]
        >
{
    static messagePrefix = "SwapUpdater";
    readonly messagePrefix = SwapUpdater.messagePrefix;

    private monitoredSwaps = new Map<string, PendingSwap>();
    private swapProvider: BoltzSwapProvider | undefined;
    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    private onNextTick: (() => SwapUpdaterResponse | null)[] = [];

    constructor(private readonly config: SwapUpdaterConfig) {

    }

    private handleInit({baseUrl,network}:{baseUrl: string, network: NetworkName}) {
        this.swapProvider = new BoltzSwapProvider({ apiUrl: baseUrl, network });
    };

    async handleMessage(
        message: SwapUpdaterRequest
    ): Promise<SwapUpdaterResponse | null> {
        if (message.type === "INIT") {
            await this.handleInit(message.payload as any);
            const payload = initialized(message.id);
            return { id: message.id, type: payload.type, payload}
        }
        if (!this.swapProvider) {
            return Response.error(message.id, "Swap Provider not initialized");
        }
        switch (message.type) {
            case "GET_REVERSE_SWAP_TX_ID": {
                const res = await this.swapProvider.getReverseSwapTxId(
                    (message as any).payload.swapId
                );
                if (res.id) {
                    return { id: message.id, type: "GET_REVERSE_SWAP_TX_ID", payload: {txid: res.id} }
                }
                return Response.error(message.id, "Failed to get reverse swap txid");
            }
            case "GET_WS_URL": {
                const wsUrl = this.swapProvider.getWsUrl();
                return { id: message.id, type: "GET_WS_URL", payload: {wsUrl} }
            }
            case "SWAP_STATUS_UPDATED": {
                const { swapId, status , error } = (message as any).payload;
                const swap = this.monitoredSwaps.get(swapId);
                if (!swap) return null;
                if (error) {
                    this.scheduleForNextTick(() => ({
                        prefix: SwapUpdater.messagePrefix,
                        type: "SWAP_FAILED",
                        broadcast: true,
                        payload: swapFailed(swap, error),
                    }));
                    return null;
                }
                if (!status) return null
                 this.handleSwapStatusUpdate(swap, status);
                return null
            }
            case "GET_MONITORED_SWAPS":
                return { id: message.id, type: "GET_MONITORED_SWAPS", payload: { swaps: Array.from(this.monitoredSwaps.values()) } }
            case "GET_SWAP":
                return { id: message.id, type: "GET_SWAP", payload: { swap: this.monitoredSwaps.get((message as any).payload.swapId) } }
            case "MONITOR_SWAP": {
                const {swap} = (message as any).payload;
                this.monitoredSwaps.set(swap.id, swap);
                return null
            }
            case "STOP_MONITORING_SWAP": {
                const {swapId} = (message as any).payload;
                this.monitoredSwaps.delete(swapId);
                return null
            }
            default:
                console.warn(`[${SwapUpdater.messagePrefix}] Unhandled message:`, message);
        }
        return null;
    }

    async start(): Promise<void> {
        // Start regular polling interval
        await this.startPolling();
        return;
    }

    async stop(): Promise<void> {
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
        }
        return Promise.resolve(undefined);
    }

    async tick(_now: number) {
        await this.pollAllSwaps();
        const results = await Promise.allSettled(
            this.onNextTick.map((fn) => fn())
        );
        this.onNextTick = [];
        return results
            .map((result) => {
                if (result.status === "fulfilled") {
                    return result.value;
                } else {
                    console.error(
                        `[${SwapUpdater.messagePrefix}] tick failed`,
                        result.reason
                    );
                    // TODO: how to deliver errors down the stream? a broadcast?
                    return null;
                }
            })
            .filter((response) => response !== null);
    }

    /**
     * Start regular polling
     * Polls all swaps at configured interval when WebSocket is active
     */
    private startPolling(): void {
        // Clear existing timer
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
        }

        // Schedule next poll
        this.pollTimer = setTimeout(async () => {
            await this.pollAllSwaps();
        }, this.config.pollInterval);
    }

    // Swap provider specific
    /**
     * Poll all monitored swaps for status updates
     * This is called:
     * 1. After WebSocket connects
     * 2. After WebSocket reconnects
     * 3. Periodically while WebSocket is active
     * 4. As fallback when WebSocket is unavailable
     */
    private async pollAllSwaps(): Promise<void> {
        if (!this.swapProvider) throw new Error("Swap provider not initialized");
        if (this.monitoredSwaps.size === 0) return;

        logger.log(`Polling ${this.monitoredSwaps.size} swaps...`);

        const pollPromises = Array.from(this.monitoredSwaps.values()).map(
            async (swap) => {
                try {
                    const statusResponse =
                        await this.swapProvider!.getSwapStatus(swap.id);

                    if (statusResponse.status !== swap.status) {
                        await this.handleSwapStatusUpdate(
                            swap,
                            statusResponse.status
                        );
                    }
                } catch (error) {
                    logger.error(`Failed to poll swap ${swap.id}:`, error);
                }
            }
        );

        await Promise.allSettled(pollPromises);
    }

    private scheduleForNextTick(callback: () => SwapUpdaterResponse | null) {
        this.onNextTick.push(callback);
    }

    /**
     * Handle status update for a swap
     * This is the core logic that determines what actions to take
     */
    private async handleSwapStatusUpdate(
        swap: PendingSwap,
        newStatus: BoltzSwapStatus
    ): Promise<void> {
        const oldStatus = swap.status;

        // Skip if status hasn't changed
        if (oldStatus === newStatus) return;

        // Update swap status
        swap.status = newStatus;

        logger.log(`Swap ${swap.id} status: ${oldStatus} → ${newStatus}`);

        // notify all clients about the swap update
        this.scheduleForNextTick(() => ({
            prefix: SwapUpdater.messagePrefix,
            type: "SWAP_STATUS_UPDATED",
            broadcast: true,
            payload: swapUpdated(swap, oldStatus),
        }));


        // Remove from monitoring if final status
        if (this.isFinalStatus(newStatus)) {
            this.monitoredSwaps.delete(swap.id);
            // Emit completed event to all listeners
            logger.log(`Swap ${swap.id} completed with status: ${newStatus}`);
            this.scheduleForNextTick(() => ({
                prefix: SwapUpdater.messagePrefix,
                type: "SWAP_COMPLETED",
                broadcast: true,
                payload: swapCompleted(swap),
            }));
        }
    }

    /**
     * Check if a status is final (no more updates expected)
     */
    private isFinalStatus(status: BoltzSwapStatus): boolean {
        return isReverseFinalStatus(status) || isSubmarineFinalStatus(status);
    }
}