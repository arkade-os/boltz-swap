import {
    BoltzSwapProvider,
    BoltzSwapStatus,
    isPendingReverseSwap,
    isPendingSubmarineSwap,
    isReverseFinalStatus,
    isSubmarineFinalStatus,
    isReverseClaimableStatus,
    isSubmarineRefundableStatus,
    isPendingChainSwap,
    isChainClaimableStatus,
    isChainRefundableStatus,
    isChainFinalStatus,
    isChainSignableStatus,
} from "./boltz-swap-provider";
import {
    PendingChainSwap,
    PendingReverseSwap,
    PendingSubmarineSwap,
    PendingSwap,
} from "./types";
import { NetworkError } from "./errors";
import { logger } from "./logger";

type Actions =
    | "claim"
    | "refund"
    | "claimArk"
    | "claimBtc"
    | "refundArk"
    | "signServerClaim";

export interface SwapManagerConfig {
    /** Auto claim/refund swaps (default: true) */
    enableAutoActions?: boolean;
    /** Polling interval in ms (default: 30000) */
    pollInterval?: number;
    /** Initial reconnect delay (default: 1000) */
    reconnectDelayMs?: number;
    /** Max reconnect delay (default: 60000) */
    maxReconnectDelayMs?: number;
    /** Initial poll retry delay (default: 5000) */
    pollRetryDelayMs?: number;
    /** Max poll retry delay (default: 300000) */
    maxPollRetryDelayMs?: number;
    /** Event callbacks for swap lifecycle events (optional, can use on/off methods instead) */
    events?: SwapManagerEvents;
}

export interface SwapManagerEvents {
    onSwapUpdate?: (swap: PendingSwap, oldStatus: BoltzSwapStatus) => void;
    onSwapCompleted?: (swap: PendingSwap) => void;
    onSwapFailed?: (swap: PendingSwap, error: Error) => void;
    onActionExecuted?: (swap: PendingSwap, action: Actions) => void;
    onWebSocketConnected?: () => void;
    onWebSocketDisconnected?: (error?: Error) => void;
}

// Event listener types
type SwapUpdateListener = (
    swap: PendingSwap,
    oldStatus: BoltzSwapStatus
) => void;
type SwapCompletedListener = (swap: PendingSwap) => void;
type SwapFailedListener = (swap: PendingSwap, error: Error) => void;
type ActionExecutedListener = (swap: PendingSwap, action: Actions) => void;
type WebSocketConnectedListener = () => void;
type WebSocketDisconnectedListener = (error?: Error) => void;

type SwapUpdateCallback = (
    swap: PendingSwap,
    oldStatus: BoltzSwapStatus
) => void;

export class SwapManager {
    private readonly swapProvider: BoltzSwapProvider;
    private readonly config: SwapManagerConfig;

    // Event listeners storage (supports multiple listeners per event)
    private swapUpdateListeners = new Set<SwapUpdateListener>();
    private swapCompletedListeners = new Set<SwapCompletedListener>();
    private swapFailedListeners = new Set<SwapFailedListener>();
    private actionExecutedListeners = new Set<ActionExecutedListener>();
    private wsConnectedListeners = new Set<WebSocketConnectedListener>();
    private wsDisconnectedListeners = new Set<WebSocketDisconnectedListener>();

    // State
    private websocket: WebSocket | null = null;
    private monitoredSwaps = new Map<string, PendingSwap>();
    private initialSwaps = new Map<string, PendingSwap>(); // All swaps passed to start(), including completed ones
    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private isRunning = false;
    private currentReconnectDelay: number;
    private currentPollRetryDelay: number;
    private usePollingFallback = false;
    private isReconnecting = false;

    // Race condition prevention
    private swapsInProgress = new Set<string>();

    // Per-swap subscriptions for UI hooks
    private swapSubscriptions = new Map<string, Set<SwapUpdateCallback>>();

    // Callbacks for actions (injected by ArkadeLightning)
    private claimCallback:
        | ((swap: PendingReverseSwap) => Promise<void>)
        | null = null;
    private refundCallback:
        | ((swap: PendingSubmarineSwap) => Promise<void>)
        | null = null;

    // Callbacks for actions (injected by ArkadeChainSwap)
    private claimArkCallback:
        | ((swap: PendingChainSwap) => Promise<void>)
        | null = null;
    private claimBtcCallback:
        | ((swap: PendingChainSwap) => Promise<void>)
        | null = null;
    private refundArkCallback:
        | ((swap: PendingChainSwap) => Promise<void>)
        | null = null;
    private signServerClaimCallback:
        | ((swap: PendingChainSwap) => Promise<void>)
        | null = null;

    // Callback injected by ArkadeChainSwap and ArkadeLightning
    private saveSwapCallback: ((swap: PendingSwap) => Promise<void>) | null =
        null;

    constructor(
        swapProvider: BoltzSwapProvider,
        config: SwapManagerConfig = {}
    ) {
        this.swapProvider = swapProvider;
        // Note: autostart is not stored - it's only used by ArkadeLightning
        this.config = {
            enableAutoActions: config.enableAutoActions ?? true,
            pollInterval: config.pollInterval ?? 30000,
            reconnectDelayMs: config.reconnectDelayMs ?? 1000,
            maxReconnectDelayMs: config.maxReconnectDelayMs ?? 60000,
            pollRetryDelayMs: config.pollRetryDelayMs ?? 5000,
            maxPollRetryDelayMs: config.maxPollRetryDelayMs ?? 300000,
            events: config.events ?? {},
        };

        // Register initial event listeners from config if provided
        if (config.events?.onSwapUpdate) {
            this.swapUpdateListeners.add(config.events.onSwapUpdate);
        }
        if (config.events?.onSwapCompleted) {
            this.swapCompletedListeners.add(config.events.onSwapCompleted);
        }
        if (config.events?.onSwapFailed) {
            this.swapFailedListeners.add(config.events.onSwapFailed);
        }
        if (config.events?.onActionExecuted) {
            this.actionExecutedListeners.add(config.events.onActionExecuted);
        }
        if (config.events?.onWebSocketConnected) {
            this.wsConnectedListeners.add(config.events.onWebSocketConnected);
        }
        if (config.events?.onWebSocketDisconnected) {
            this.wsDisconnectedListeners.add(
                config.events.onWebSocketDisconnected
            );
        }

        this.currentReconnectDelay = this.config.reconnectDelayMs!;
        this.currentPollRetryDelay = this.config.pollRetryDelayMs!;
    }

    /**
     * Set callbacks for claim, refund, and save operations
     * These are called by the manager when autonomous actions are needed
     */
    setCallbacks(callbacks: {
        claim: (swap: PendingReverseSwap) => Promise<void>;
        refund: (swap: PendingSubmarineSwap) => Promise<void>;
        saveSwap: (swap: PendingSwap) => Promise<void>;
    }): void {
        this.claimCallback = callbacks.claim;
        this.refundCallback = callbacks.refund;
        this.saveSwapCallback = callbacks.saveSwap;
    }

    /**
     * Set callbacks for claim, refund, and save operations
     * These are called by the manager when autonomous actions are needed
     */
    setChainCallbacks(callbacks: {
        claimArk: (swap: PendingChainSwap) => Promise<void>;
        claimBtc: (swap: PendingChainSwap) => Promise<void>;
        refundArk: (swap: PendingChainSwap) => Promise<void>;
        saveSwap: (swap: PendingSwap) => Promise<void>;
        signServerClaim: (swap: PendingChainSwap) => Promise<void>;
    }): void {
        this.claimArkCallback = callbacks.claimArk;
        this.claimBtcCallback = callbacks.claimBtc;
        this.refundArkCallback = callbacks.refundArk;
        this.saveSwapCallback = callbacks.saveSwap;
        this.signServerClaimCallback = callbacks.signServerClaim;
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
     * Add an event listener for executed actions (claim/refund)
     * @returns Unsubscribe function
     */
    onActionExecuted(listener: ActionExecutedListener): () => void {
        this.actionExecutedListeners.add(listener);
        return () => this.actionExecutedListeners.delete(listener);
    }

    /**
     * Add an event listener for WebSocket connection
     * @returns Unsubscribe function
     */
    onWebSocketConnected(listener: WebSocketConnectedListener): () => void {
        this.wsConnectedListeners.add(listener);
        return () => this.wsConnectedListeners.delete(listener);
    }

    /**
     * Add an event listener for WebSocket disconnection
     * @returns Unsubscribe function
     */
    onWebSocketDisconnected(
        listener: WebSocketDisconnectedListener
    ): () => void {
        this.wsDisconnectedListeners.add(listener);
        return () => this.wsDisconnectedListeners.delete(listener);
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

    /**
     * Remove an event listener for executed actions
     */
    offActionExecuted(listener: ActionExecutedListener): void {
        this.actionExecutedListeners.delete(listener);
    }

    /**
     * Remove an event listener for WebSocket connection
     */
    offWebSocketConnected(listener: WebSocketConnectedListener): void {
        this.wsConnectedListeners.delete(listener);
    }

    /**
     * Remove an event listener for WebSocket disconnection
     */
    offWebSocketDisconnected(listener: WebSocketDisconnectedListener): void {
        this.wsDisconnectedListeners.delete(listener);
    }

    /**
     * Start the swap manager
     * This will:
     * 1. Load pending swaps
     * 2. Connect WebSocket (with fallback to polling)
     * 3. Poll all swaps after connection
     * 4. Resume any actionable swaps
     */
    async start(pendingSwaps: PendingSwap[]): Promise<void> {
        if (this.isRunning) {
            logger.warn("SwapManager is already running");
            return;
        }

        this.isRunning = true;

        // Store all initial swaps (including completed ones) for waitForSwapCompletion
        this.initialSwaps.clear();
        for (const swap of pendingSwaps) {
            this.initialSwaps.set(swap.id, swap);
        }

        // Load pending swaps into monitoring map (only non-final swaps)
        for (const swap of pendingSwaps) {
            if (!this.isFinalStatus(swap)) {
                this.monitoredSwaps.set(swap.id, swap);
            }
        }

        // Try to connect WebSocket, fall back to polling if it fails
        await this.connectWebSocket();

        // Resume any actionable swaps immediately
        await this.resumeActionableSwaps();
    }

    /**
     * Stop the swap manager
     * Cleanup: close WebSocket, stop all timers
     */
    async stop(): Promise<void> {
        if (!this.isRunning) return;

        this.isRunning = false;

        // Close WebSocket
        if (this.websocket) {
            this.websocket.close();
            this.websocket = null;
        }

        // Clear timers
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    /**
     * Add a new swap to monitoring
     */
    addSwap(swap: PendingSwap): void {
        this.monitoredSwaps.set(swap.id, swap);

        // Subscribe to this swap if WebSocket is connected
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
            this.subscribeToSwap(swap.id);
        }
    }

    /**
     * Remove a swap from monitoring
     */
    removeSwap(swapId: string): void {
        this.monitoredSwaps.delete(swapId);
        this.swapSubscriptions.delete(swapId);
        logger.log(`Removed swap ${swapId} from monitoring`);
    }

    /**
     * Get all currently monitored swaps
     */
    getPendingSwaps(): PendingSwap[] {
        return Array.from(this.monitoredSwaps.values());
    }

    /**
     * Subscribe to updates for a specific swap
     * Returns an unsubscribe function
     * Useful for UI components that need to track specific swap progress
     */
    subscribeToSwapUpdates(
        swapId: string,
        callback: SwapUpdateCallback
    ): () => void {
        if (!this.swapSubscriptions.has(swapId)) {
            this.swapSubscriptions.set(swapId, new Set());
        }

        const subscribers = this.swapSubscriptions.get(swapId)!;
        subscribers.add(callback);

        // Return unsubscribe function
        return () => {
            subscribers.delete(callback);
            if (subscribers.size === 0) {
                this.swapSubscriptions.delete(swapId);
            }
        };
    }

    /**
     * Wait for a specific swap to complete
     * This blocks until the swap reaches a final status or fails
     * Useful when you want blocking behavior even with SwapManager enabled
     */
    async waitForSwapCompletion(swapId: string): Promise<{ txid: string }> {
        return new Promise<{ txid: string }>((resolve, reject) => {
            let swap = this.monitoredSwaps.get(swapId);

            // If not in monitored swaps, check if it was in initial swaps (might be completed)
            if (!swap) {
                swap = this.initialSwaps.get(swapId);
                if (!swap) {
                    reject(new Error(`Swap ${swapId} not found in manager`));
                    return;
                }
            }

            // Check if already in final status
            if (this.isFinalStatus(swap)) {
                if (isPendingReverseSwap(swap)) {
                    this.swapProvider
                        .getReverseSwapTxId(swap.id)
                        .then((response) => resolve({ txid: response.id }))
                        .catch((error) => reject(error));
                } else if (isPendingSubmarineSwap(swap)) {
                    reject(new Error("Submarine swap already completed"));
                } else if (isPendingChainSwap(swap)) {
                    reject(new Error("Chain swap already completed"));
                }
                return;
            }

            // Subscribe to swap updates
            const unsubscribe = this.subscribeToSwapUpdates(
                swapId,
                (updatedSwap, _oldStatus) => {
                    // Check if swap reached final status
                    if (this.isFinalStatus(updatedSwap)) {
                        unsubscribe();

                        if (isPendingReverseSwap(updatedSwap)) {
                            // Check if successfully claimed
                            if (updatedSwap.status === "invoice.settled") {
                                this.swapProvider
                                    .getReverseSwapTxId(updatedSwap.id)
                                    .then((response) =>
                                        resolve({ txid: response.id })
                                    )
                                    .catch((error) => reject(error));
                            } else {
                                reject(
                                    new Error(
                                        `Swap failed with status: ${updatedSwap.status}`
                                    )
                                );
                            }
                        } else if (isPendingSubmarineSwap(updatedSwap)) {
                            // Check if successfully completed
                            if (updatedSwap.status === "transaction.claimed") {
                                resolve({ txid: updatedSwap.id });
                            } else {
                                reject(
                                    new Error(
                                        `Swap failed with status: ${updatedSwap.status}`
                                    )
                                );
                            }
                        } else if (isPendingChainSwap(updatedSwap)) {
                            // Check if successfully completed
                            if (updatedSwap.status === "transaction.claimed") {
                                resolve({ txid: updatedSwap.id });
                            } else {
                                reject(
                                    new Error(
                                        `Swap failed with status: ${updatedSwap.status}`
                                    )
                                );
                            }
                        }
                    }
                }
            );
        });
    }

    /**
     * Check if a swap is currently being processed
     * Useful for preventing race conditions
     */
    isProcessing(swapId: string): boolean {
        return this.swapsInProgress.has(swapId);
    }

    /**
     * Check if manager has a specific swap
     */
    hasSwap(swapId: string): boolean {
        return this.monitoredSwaps.has(swapId);
    }

    /**
     * Connect to WebSocket for real-time swap updates
     * Falls back to polling if connection fails
     */
    private async connectWebSocket(): Promise<void> {
        if (this.isReconnecting) return;
        this.isReconnecting = true;

        try {
            const wsUrl = this.swapProvider.getWsUrl();
            this.websocket = new globalThis.WebSocket(wsUrl);

            // Connection timeout
            const connectionTimeout = setTimeout(() => {
                logger.error("WebSocket connection timeout");
                this.websocket?.close();
                this.handleWebSocketFailure();
            }, 10000);

            this.websocket.onerror = (error) => {
                clearTimeout(connectionTimeout);
                logger.error("WebSocket error:", error);
                this.handleWebSocketFailure();
            };

            this.websocket.onopen = () => {
                clearTimeout(connectionTimeout);

                // Reset reconnect delay on successful connection
                this.currentReconnectDelay = this.config.reconnectDelayMs!;
                this.usePollingFallback = false;
                this.isReconnecting = false;

                // Subscribe to all monitored swaps
                for (const swapId of this.monitoredSwaps.keys()) {
                    this.subscribeToSwap(swapId);
                }

                // CRITICAL: Poll all swaps AFTER WebSocket connects
                this.pollAllSwaps();

                // Start regular polling interval
                this.startPolling();

                // Emit connected event
                // Emit WebSocket connected event to all listeners
                this.wsConnectedListeners.forEach((listener) => listener());
            };

            this.websocket.onclose = () => {
                clearTimeout(connectionTimeout);

                this.websocket = null;

                // Only attempt reconnect if manager is still running
                if (this.isRunning) {
                    this.scheduleReconnect();
                }

                // Emit WebSocket disconnected event to all listeners
                this.wsDisconnectedListeners.forEach((listener) => listener());
            };

            this.websocket.onmessage = async (rawMsg) => {
                await this.handleWebSocketMessage(rawMsg);
            };
        } catch (error) {
            logger.error("Failed to create WebSocket:", error);
            this.handleWebSocketFailure();
        }
    }

    /**
     * Handle WebSocket connection failure
     * Falls back to polling-only mode with exponential backoff
     */
    private handleWebSocketFailure(): void {
        this.isReconnecting = false;
        this.websocket = null;
        this.usePollingFallback = true;

        // Start polling with exponential backoff
        this.startPollingFallback();

        // Emit WebSocket disconnected event to all listeners
        const error = new NetworkError("WebSocket connection failed");
        this.wsDisconnectedListeners.forEach((listener) => listener(error));
    }

    /**
     * Schedule WebSocket reconnection with exponential backoff
     */
    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;

        logger.log(
            `Scheduling WebSocket reconnect in ${this.currentReconnectDelay}ms`
        );

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.isReconnecting = false;
            this.connectWebSocket();
        }, this.currentReconnectDelay);

        // Exponential backoff for reconnection
        this.currentReconnectDelay = Math.min(
            this.currentReconnectDelay * 2,
            this.config.maxReconnectDelayMs!
        );
    }

    /**
     * Subscribe to a specific swap ID on the WebSocket
     */
    private subscribeToSwap(swapId: string): void {
        if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN)
            return;

        this.websocket.send(
            JSON.stringify({
                op: "subscribe",
                channel: "swap.update",
                args: [swapId],
            })
        );
    }

    /**
     * Handle incoming WebSocket message
     */
    private async handleWebSocketMessage(rawMsg: MessageEvent): Promise<void> {
        try {
            const msg = JSON.parse(rawMsg.data as string);

            // Only process update events
            if (msg.event !== "update") return;

            const swapId = msg.args[0]?.id;
            if (!swapId) return;

            const swap = this.monitoredSwaps.get(swapId);
            if (!swap) return;

            // Handle error from Boltz
            if (msg.args[0].error) {
                logger.error(`Swap ${swapId} error:`, msg.args[0].error);
                const error = new Error(msg.args[0].error);
                this.swapFailedListeners.forEach((listener) =>
                    listener(swap, error)
                );
                return;
            }

            const newStatus = msg.args[0].status as BoltzSwapStatus;
            await this.handleSwapStatusUpdate(swap, newStatus);
        } catch (error) {
            logger.error("Error handling WebSocket message:", error);
        }
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

        // Emit update event to all listeners
        this.swapUpdateListeners.forEach((listener) =>
            listener(swap, oldStatus)
        );

        // Notify per-swap subscribers
        const subscribers = this.swapSubscriptions.get(swap.id);
        if (subscribers) {
            subscribers.forEach((callback) => {
                try {
                    callback(swap, oldStatus);
                } catch (error) {
                    logger.error(
                        `Error in swap subscription callback for ${swap.id}:`,
                        error
                    );
                }
            });
        }

        // Save updated swap to storage
        await this.saveSwap(swap);

        // Execute autonomous actions if enabled
        if (this.config.enableAutoActions) {
            await this.executeAutonomousAction(swap);
        }

        // Remove from monitoring if final status
        if (this.isFinalStatus(swap)) {
            this.monitoredSwaps.delete(swap.id);
            this.swapSubscriptions.delete(swap.id);
            // Emit completed event to all listeners
            this.swapCompletedListeners.forEach((listener) => listener(swap));
        }
    }

    /**
     * Execute autonomous action based on swap status
     * Uses locking to prevent race conditions with manual operations
     */
    private async executeAutonomousAction(swap: PendingSwap): Promise<void> {
        // Skip if already processing this swap
        if (this.swapsInProgress.has(swap.id)) {
            logger.log(
                `Swap ${swap.id} is already being processed, skipping autonomous action`
            );
            return;
        }

        try {
            // Lock the swap
            this.swapsInProgress.add(swap.id);

            if (isPendingReverseSwap(swap)) {
                // Skip restored swaps without preimage (cannot claim without it)
                if (!swap.preimage || swap.preimage.length === 0) {
                    logger.log(
                        `Skipping claim for swap ${swap.id}: missing preimage (restored swap)`
                    );
                    return;
                }
                // Claim reverse swap if status is claimable
                if (isReverseClaimableStatus(swap.status)) {
                    logger.log(`Auto-claiming reverse swap ${swap.id}`);
                    await this.executeClaimAction(swap);
                    // Emit action executed event to all listeners
                    this.actionExecutedListeners.forEach((listener) =>
                        listener(swap, "claim")
                    );
                }
            } else if (isPendingSubmarineSwap(swap)) {
                // Skip restored swaps without invoice (cannot refund without it)
                if (
                    !swap.request?.invoice ||
                    swap.request.invoice.length === 0
                ) {
                    logger.log(
                        `Skipping refund for swap ${swap.id}: missing invoice (restored swap)`
                    );
                    return;
                }
                // Refund submarine swap if status is refundable
                if (isSubmarineRefundableStatus(swap.status)) {
                    logger.log(`Auto-refunding submarine swap ${swap.id}`);
                    await this.executeRefundAction(swap);
                    // Emit action executed event to all listeners
                    this.actionExecutedListeners.forEach((listener) =>
                        listener(swap, "refund")
                    );
                }
            } else if (isPendingChainSwap(swap)) {
                if (isChainClaimableStatus(swap.status)) {
                    // Determine if it's Ark or BTC claim
                    if (swap.request.to === "ARK") {
                        logger.log(`Auto-claiming ARK chain swap ${swap.id}`);
                        await this.executeClaimArkAction(swap);
                        // Emit action executed event to all listeners
                        this.actionExecutedListeners.forEach((listener) =>
                            listener(swap, "claimArk")
                        );
                    } else if (swap.request.to === "BTC") {
                        logger.log(`Auto-claiming BTC chain swap ${swap.id}`);
                        await this.executeClaimBtcAction(swap);
                        // Emit action executed event to all listeners
                        this.actionExecutedListeners.forEach((listener) =>
                            listener(swap, "claimBtc")
                        );
                    }
                } else if (isChainRefundableStatus(swap.status)) {
                    if (swap.request.from === "ARK") {
                        logger.log(`Auto-refunding ARK chain swap ${swap.id}`);
                        await this.executeRefundArkAction(swap);
                        // Emit action executed event to all listeners
                        this.actionExecutedListeners.forEach((listener) =>
                            listener(swap, "refundArk")
                        );
                    }
                    if (swap.request.from === "BTC") {
                        // TODO: Implement BTC refund if needed
                    }
                } else if (
                    swap.request.to === "ARK" &&
                    isChainSignableStatus(swap.status)
                ) {
                    logger.log(
                        `Auto-signing server's cooperative claim for ARK chain swap ${swap.id}`
                    );
                    await this.signServerClaimCallback!(swap);
                    // Emit action executed event to all listeners
                    this.actionExecutedListeners.forEach((listener) =>
                        listener(swap, "signServerClaim")
                    );
                }
            }
        } catch (error) {
            logger.error(
                `Failed to execute autonomous action for swap ${swap.id}:`,
                error
            );
            // Emit swap failed event to all listeners
            this.swapFailedListeners.forEach((listener) =>
                listener(swap, error as Error)
            );
        } finally {
            // Always release the lock
            this.swapsInProgress.delete(swap.id);
        }
    }

    /**
     * Execute claim action for reverse swap
     */
    private async executeClaimAction(swap: PendingReverseSwap): Promise<void> {
        if (!this.claimCallback) {
            logger.error("Claim callback not set");
            return;
        }

        await this.claimCallback(swap);
    }

    /**
     * Execute refund action for submarine swap
     */
    private async executeRefundAction(
        swap: PendingSubmarineSwap
    ): Promise<void> {
        if (!this.refundCallback) {
            logger.error("Refund callback not set");
            return;
        }

        await this.refundCallback(swap);
    }

    /**
     * Execute claim action for chain swap Btc to Ark
     */
    private async executeClaimArkAction(swap: PendingChainSwap): Promise<void> {
        if (!this.claimArkCallback) {
            logger.error("claimArk callback not set");
            return;
        }

        await this.claimArkCallback(swap);
    }

    /**
     * Execute claim action for chain swap Ark to Btc
     */
    private async executeClaimBtcAction(swap: PendingChainSwap): Promise<void> {
        if (!this.claimBtcCallback) {
            logger.error("claimBtc callback not set");
            return;
        }

        await this.claimBtcCallback(swap);
    }

    /**
     * Execute refund action for chain swap Ark to Btc
     */
    private async executeRefundArkAction(
        swap: PendingChainSwap
    ): Promise<void> {
        if (!this.refundArkCallback) {
            logger.error("refundArk callback not set");
            return;
        }

        await this.refundArkCallback(swap);
    }

    /**
     * Save swap to storage
     */
    private async saveSwap(swap: PendingSwap): Promise<void> {
        if (!this.saveSwapCallback) {
            logger.error("Save swap callback not set");
            return;
        }

        await this.saveSwapCallback(swap);
    }

    /**
     * Resume actionable swaps on startup
     * This checks all pending swaps and executes actions if needed
     */
    private async resumeActionableSwaps(): Promise<void> {
        // Only resume if auto actions are enabled
        if (!this.config.enableAutoActions) {
            return;
        }

        for (const swap of this.monitoredSwaps.values()) {
            try {
                // Check if swap needs action based on current status
                if (
                    isPendingReverseSwap(swap) &&
                    isReverseClaimableStatus(swap.status)
                ) {
                    logger.log(`Resuming claim for swap ${swap.id}`);
                    await this.executeAutonomousAction(swap);
                } else if (
                    isPendingSubmarineSwap(swap) &&
                    isSubmarineRefundableStatus(swap.status)
                ) {
                    logger.log(`Resuming refund for swap ${swap.id}`);
                    await this.executeAutonomousAction(swap);
                } else if (
                    isPendingChainSwap(swap) &&
                    isChainClaimableStatus(swap.status)
                ) {
                    logger.log(`Resuming chain claim for swap ${swap.id}`);
                    await this.executeAutonomousAction(swap);
                } else if (
                    isPendingChainSwap(swap) &&
                    isChainRefundableStatus(swap.status)
                ) {
                    logger.log(`Resuming chain refund for swap ${swap.id}`);
                    await this.executeAutonomousAction(swap);
                }
            } catch (error) {
                logger.error(`Failed to resume swap ${swap.id}:`, error);
            }
        }
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

            // Reschedule if manager is still running
            if (this.isRunning) {
                this.startPolling();
            }
        }, this.config.pollInterval);
    }

    /**
     * Start polling fallback when WebSocket is unavailable
     * Uses exponential backoff for retry delay
     */
    private startPollingFallback(): void {
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
        }

        this.pollTimer = setTimeout(async () => {
            await this.pollAllSwaps();

            // Increase poll retry delay with exponential backoff
            this.currentPollRetryDelay = Math.min(
                this.currentPollRetryDelay * 2,
                this.config.maxPollRetryDelayMs!
            );

            // Reschedule if manager is still running and still in fallback mode
            if (this.isRunning && this.usePollingFallback) {
                this.startPollingFallback();
            }
        }, this.currentPollRetryDelay);
    }

    /**
     * Poll all monitored swaps for status updates
     * This is called:
     * 1. After WebSocket connects
     * 2. After WebSocket reconnects
     * 3. Periodically while WebSocket is active
     * 4. As fallback when WebSocket is unavailable
     */
    private async pollAllSwaps(): Promise<void> {
        if (this.monitoredSwaps.size === 0) return;

        const pollPromises = Array.from(this.monitoredSwaps.values()).map(
            async (swap) => {
                try {
                    const statusResponse =
                        await this.swapProvider.getSwapStatus(swap.id);

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

    /**
     * Check if a status is final (no more updates expected)
     */
    private isFinalStatus(pendingSwap: PendingSwap): boolean {
        const status = pendingSwap.status;
        return (
            (isPendingReverseSwap(pendingSwap) &&
                isReverseFinalStatus(status)) ||
            (isPendingSubmarineSwap(pendingSwap) &&
                isSubmarineFinalStatus(status)) ||
            (isPendingChainSwap(pendingSwap) && isChainFinalStatus(status))
        );
    }

    /**
     * Get current manager statistics (for debugging/monitoring)
     */
    getStats(): {
        isRunning: boolean;
        monitoredSwaps: number;
        websocketConnected: boolean;
        usePollingFallback: boolean;
        currentReconnectDelay: number;
        currentPollRetryDelay: number;
    } {
        return {
            isRunning: this.isRunning,
            monitoredSwaps: this.monitoredSwaps.size,
            websocketConnected:
                this.websocket !== null &&
                this.websocket.readyState === WebSocket.OPEN,
            usePollingFallback: this.usePollingFallback,
            currentReconnectDelay: this.currentReconnectDelay,
            currentPollRetryDelay: this.currentPollRetryDelay,
        };
    }
}
