import {
    ArkProvider,
    IReadonlyWallet,
    IWallet,
    MessageHandler,
    RequestEnvelope,
    ResponseEnvelope,
} from "@arkade-os/sdk";
import { logger } from "../logger";
import {
    BoltzSwapProvider,
    BoltzSwapStatus,
    isReverseFinalStatus,
    isSubmarineFinalStatus,
} from "../boltz-swap-provider";
import { NetworkName } from "@arkade-os/sdk";
import { PendingSwap } from "../repositories/swap-repository";

export type RequestInit = RequestEnvelope & {
    type: "INIT";
    payload: {
        apiUrl: string;
        network: NetworkName;
    };
};
export type ResponseInit = ResponseEnvelope & { type: "INITIALIZED" };

export type RequestGetReverseSwapTx = RequestEnvelope & {
    type: "GET_REVERSE_SWAP_TX_ID";
    payload: { swapId: string };
};
export type ResponseGetReverseSwapTx = ResponseEnvelope & {
    type: "REVERSE_SWAP_TX_ID";
    payload: { txid: string };
};

export type RequestGetWsUrl = RequestEnvelope & { type: "GET_WS_URL" };
export type ResponseGetWsUrl = ResponseEnvelope & {
    type: "WS_URL";
    payload: { wsUrl: string };
};

export type RequestSwapStatusUpdated = RequestEnvelope & {
    type: "SWAP_STATUS_UPDATED";
    payload: { swapId: string; status: BoltzSwapStatus; error: string };
};

export type RequestGetMonitoredSwaps = RequestEnvelope & {
    type: "GET_MONITORED_SWAPS";
};
export type ResponseGetMonitoredSwaps = ResponseEnvelope & {
    type: "MONITORED_SWAPS";
    payload: { swaps: PendingSwap[] };
};

export type RequestGetSwap = RequestEnvelope & {
    type: "GET_SWAP";
    payload: { swapId: string };
};
export type ResponseGetSwap = ResponseEnvelope & {
    type: "GET_SWAP";
    payload: { swap: PendingSwap | undefined };
};

// generic empty response to ensure the caller doesn't time out
type ResponseAck = ResponseEnvelope & { type: "ACK" };
export type ResponseSwapStatusUpdated = ResponseEnvelope & {
    broadcast: true;
    type: "SWAP_STATUS_UPDATED";
    payload: { swap: PendingSwap; previousStatus: BoltzSwapStatus };
};
export type ResponseSwapFailed = ResponseEnvelope & {
    broadcast: true;
    type: "SWAP_FAILED";
    payload: { swap: PendingSwap; error: string };
};
export type ResponseSwapCompleted = ResponseEnvelope & {
    broadcast: true;
    type: "SWAP_COMPLETED";
    payload: { swap: PendingSwap };
};

export type RequestMonitorSwap = RequestEnvelope & {
    type: "MONITOR_SWAP";
    payload: { swap: PendingSwap };
};
export type RequestStopMonitoringSwap = RequestEnvelope & {
    type: "STOP_MONITORING_SWAP";
    payload: { swapId: string };
};

export type SwapUpdaterRequest =
    | RequestInit
    | RequestGetReverseSwapTx
    | RequestGetWsUrl
    | RequestSwapStatusUpdated
    | RequestGetMonitoredSwaps
    | RequestMonitorSwap
    | RequestStopMonitoringSwap
    | RequestGetSwap;

export type SwapUpdaterResponse =
    | ResponseInit
    | ResponseGetReverseSwapTx
    | ResponseGetWsUrl
    | ResponseSwapStatusUpdated
    | ResponseAck
    | ResponseSwapFailed
    | ResponseSwapCompleted
    | ResponseGetMonitoredSwaps
    | ResponseGetSwap;

type SwapUpdaterConfig = { pollInterval?: number; debug?: boolean };

export class SwapMessageHandler
    implements MessageHandler<SwapUpdaterRequest, SwapUpdaterResponse>
{
    static messageTag = "SwapUpdater";
    readonly messageTag = SwapMessageHandler.messageTag;

    private monitoredSwaps = new Map<string, PendingSwap>();
    private swapProvider: BoltzSwapProvider | undefined;
    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    private onNextTick: (() => SwapUpdaterResponse | null)[] = [];

    constructor(private readonly config: SwapUpdaterConfig) {}

    private handleInit(msg: RequestInit) {
        this.swapProvider = new BoltzSwapProvider({
            apiUrl: msg.payload.apiUrl,
            network: msg.payload.network,
        });
    }

    private prefixed(res: Partial<SwapUpdaterResponse>) {
        return {
            tag: SwapMessageHandler.messageTag,
            ...res,
        } as SwapUpdaterResponse;
    }

    async handleMessage(
        message: SwapUpdaterRequest
    ): Promise<SwapUpdaterResponse> {
        const id = message.id;
        if (this.config.debug)
            console.log(
                `[SwapUpdater] message received: ${JSON.stringify(message, null, 2)}`
            );
        if (message.type === "INIT") {
            console.log(`[${this.messageTag}] INIT`, message.payload);
            this.handleInit(message);
            return this.prefixed({ id, type: "INITIALIZED" });
        }
        if (!this.swapProvider) {
            return this.prefixed({
                id,
                error: new Error("Swap Provider not initialized"),
            });
        }
        switch (message.type) {
            case "GET_REVERSE_SWAP_TX_ID": {
                const res = await this.swapProvider.getReverseSwapTxId(
                    message.payload.swapId
                );
                return this.prefixed({
                    id,
                    type: "REVERSE_SWAP_TX_ID",
                    payload: { txid: res.id },
                });
            }
            case "GET_WS_URL": {
                const wsUrl = this.swapProvider.getWsUrl();
                return this.prefixed({
                    id,
                    type: "WS_URL",
                    payload: { wsUrl },
                });
            }
            case "SWAP_STATUS_UPDATED": {
                const { swapId, status, error } = message.payload;
                const swap = this.monitoredSwaps.get(swapId);
                if (swap) {
                    if (error) {
                        this.scheduleForNextTick(() =>
                            this.prefixed({
                                type: "SWAP_FAILED",
                                broadcast: true,
                                payload: { swap, error },
                            })
                        );
                    }
                    if (status !== swap.status) {
                        await this.handleSwapStatusUpdate(swap, status);
                    }
                }
                return this.prefixed({ id, type: "ACK" });
            }
            case "GET_MONITORED_SWAPS":
                return this.prefixed({
                    id,
                    type: "MONITORED_SWAPS",
                    payload: {
                        swaps: Array.from(this.monitoredSwaps.values()),
                    },
                });
            case "GET_SWAP":
                return this.prefixed({
                    id,
                    type: "GET_SWAP",
                    payload: {
                        swap: this.monitoredSwaps.get(
                            (message as any).payload.swapId
                        ),
                    },
                });
            case "MONITOR_SWAP": {
                const { swap } = (message as any).payload;
                this.monitoredSwaps.set(swap.id, swap);
                return this.prefixed({ id, type: "ACK" });
            }
            case "STOP_MONITORING_SWAP": {
                const { swapId } = (message as any).payload;
                this.monitoredSwaps.delete(swapId);
                return this.prefixed({ id, type: "ACK" });
            }
            default:
                console.warn(
                    `[${SwapMessageHandler.messageTag}] Unhandled message:`,
                    message
                );
                throw new Error(`Unhandled message: ${message}`);
        }
    }

    async start(_opts: {
        arkProvider: ArkProvider;
        wallet?: IWallet;
        readonlyWallet: IReadonlyWallet;
    }): Promise<void> {
        await this.pollAllSwaps();
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
                        `[${SwapMessageHandler.messageTag}] tick failed`,
                        result.reason
                    );
                    // TODO: how to deliver errors down the stream? a broadcast?
                    return null;
                }
            })
            .filter((response) => response !== null);
    }

    // Swap provider specific

    /**
     * Poll all monitored swaps for status updates
     * This is called per tick.
     */
    private async pollAllSwaps(): Promise<void> {
        if (!this.swapProvider) {
            // A tick may be called when the SwapProvider is not yet initialized.
            return;
        }

        if (this.monitoredSwaps.size === 0) return;

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
        this.scheduleForNextTick(() =>
            this.prefixed({
                broadcast: true,
                type: "SWAP_STATUS_UPDATED",
                payload: { swap, previousStatus: oldStatus },
            })
        );

        // Remove from monitoring if final status
        if (this.isFinalStatus(newStatus)) {
            this.monitoredSwaps.delete(swap.id);
            // Emit completed event to all listeners
            logger.log(`Swap ${swap.id} completed with status: ${newStatus}`);
            this.scheduleForNextTick(() =>
                this.prefixed({
                    broadcast: true,
                    type: "SWAP_COMPLETED",
                    payload: { swap },
                })
            );
        }
    }

    /**
     * Check if a status is final (no more updates expected)
     */
    private isFinalStatus(status: BoltzSwapStatus): boolean {
        return isReverseFinalStatus(status) || isSubmarineFinalStatus(status);
    }
}
