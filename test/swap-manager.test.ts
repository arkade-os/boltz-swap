import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SwapManager } from "../src/swap-manager";
import { BoltzSwapProvider } from "../src/boltz-swap-provider";
import { PendingReverseSwap, PendingSubmarineSwap } from "../src/types";

describe("SwapManager", () => {
    let swapProvider: BoltzSwapProvider;
    let mockWebSocket: any;
    let swapManager: SwapManager;

    const mockReverseSwap: PendingReverseSwap = {
        id: "reverse-swap-1",
        type: "reverse",
        createdAt: Date.now() / 1000,
        preimage: "0".repeat(64),
        status: "swap.created",
        request: {
            claimPublicKey: "0".repeat(66),
            invoiceAmount: 10000,
            preimageHash: "0".repeat(64),
        },
        response: {
            id: "reverse-swap-1",
            invoice: "lnbc100n1p0",
            onchainAmount: 10000,
            lockupAddress: "ark1test",
            refundPublicKey: "0".repeat(66),
            timeoutBlockHeights: {
                refund: 100,
                unilateralClaim: 200,
                unilateralRefund: 300,
                unilateralRefundWithoutReceiver: 400,
            },
        },
    };

    const mockSubmarineSwap: PendingSubmarineSwap = {
        id: "submarine-swap-1",
        type: "submarine",
        createdAt: Date.now() / 1000,
        status: "invoice.set",
        request: {
            invoice: "lnbc100n1p0",
            refundPublicKey: "0".repeat(66),
        },
        response: {
            id: "submarine-swap-1",
            address: "ark1test",
            expectedAmount: 10000,
            claimPublicKey: "0".repeat(66),
            acceptZeroConf: false,
            timeoutBlockHeights: {
                refund: 100,
                unilateralClaim: 200,
                unilateralRefund: 300,
                unilateralRefundWithoutReceiver: 400,
            },
        },
    };

    beforeEach(() => {
        // Mock WebSocket
        mockWebSocket = {
            send: vi.fn(),
            close: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            readyState: 1, // OPEN
            onerror: null,
            onopen: null,
            onclose: null,
            onmessage: null,
        };

        // Mock WebSocket constructor with static constants
        const MockWebSocketConstructor = vi.fn(() => mockWebSocket) as any;
        MockWebSocketConstructor.CONNECTING = 0;
        MockWebSocketConstructor.OPEN = 1;
        MockWebSocketConstructor.CLOSING = 2;
        MockWebSocketConstructor.CLOSED = 3;
        global.WebSocket = MockWebSocketConstructor;

        swapProvider = new BoltzSwapProvider({
            network: "regtest",
            apiUrl: "http://localhost:9069",
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe("Initialization", () => {
        it("should create SwapManager with default config", () => {
            swapManager = new SwapManager(swapProvider);
            expect(swapManager).toBeDefined();
            expect(swapManager.getStats().isRunning).toBe(false);
        });

        it("should create SwapManager with custom config", () => {
            swapManager = new SwapManager(swapProvider, {
                enableAutoActions: false,
                pollInterval: 60000,
                reconnectDelayMs: 2000,
            });
            expect(swapManager).toBeDefined();
        });

        it("should accept event callbacks", () => {
            const onSwapUpdate = vi.fn();
            const onSwapCompleted = vi.fn();

            swapManager = new SwapManager(swapProvider, {
                events: {
                    onSwapUpdate,
                    onSwapCompleted,
                },
            });

            expect(swapManager).toBeDefined();
        });
    });

    describe("Lifecycle", () => {
        beforeEach(() => {
            swapManager = new SwapManager(swapProvider);

            const claimCallback = vi.fn();
            const refundCallback = vi.fn();
            const saveSwapCallback = vi.fn();

            swapManager.setCallbacks({
                claim: claimCallback,
                refund: refundCallback,
                saveSwap: saveSwapCallback,
            });
        });

        it("should start with empty pending swaps", async () => {
            await swapManager.start([]);

            const stats = swapManager.getStats();
            expect(stats.isRunning).toBe(true);
            expect(stats.monitoredSwaps).toBe(0);
        });

        it("should start with pending swaps", async () => {
            await swapManager.start([mockReverseSwap, mockSubmarineSwap]);

            const stats = swapManager.getStats();
            expect(stats.isRunning).toBe(true);
            expect(stats.monitoredSwaps).toBe(2);
        });

        it("should not start if already running", async () => {
            await swapManager.start([]);

            const consoleWarnSpy = vi.spyOn(console, "warn");
            await swapManager.start([]);

            expect(consoleWarnSpy).toHaveBeenCalledWith(
                "SwapManager is already running"
            );
        });

        it("should stop manager", async () => {
            await swapManager.start([mockReverseSwap]);
            await swapManager.stop();

            const stats = swapManager.getStats();
            expect(stats.isRunning).toBe(false);
        });

        it("should close WebSocket on stop", async () => {
            await swapManager.start([]);
            await swapManager.stop();

            expect(mockWebSocket.close).toHaveBeenCalled();
        });
    });

    describe("WebSocket", () => {
        beforeEach(() => {
            swapManager = new SwapManager(swapProvider);
            swapManager.setCallbacks({
                claim: vi.fn(),
                refund: vi.fn(),
                saveSwap: vi.fn(),
            });

            // Mock fetch for polling (needed when WebSocket connects)
            global.fetch = vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            status: "swap.created",
                        }),
                    headers: new Headers({
                        "content-length": "100",
                    }),
                } as Response)
            );
        });

        it("should connect to WebSocket on start", async () => {
            await swapManager.start([]);

            // Trigger onopen callback (it was assigned by SwapManager)
            if (mockWebSocket.onopen) {
                mockWebSocket.onopen();
            }

            // Give async operations time to complete
            await new Promise((resolve) => setTimeout(resolve, 10));

            const stats = swapManager.getStats();
            expect(stats.websocketConnected).toBe(true);
        });

        it("should subscribe to all swap IDs", async () => {
            await swapManager.start([mockReverseSwap, mockSubmarineSwap]);

            // Trigger onopen callback (it was assigned by SwapManager)
            if (mockWebSocket.onopen) {
                mockWebSocket.onopen();
            }

            // Give async operations time to complete
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(mockWebSocket.send).toHaveBeenCalledWith(
                JSON.stringify({
                    op: "subscribe",
                    channel: "swap.update",
                    args: ["reverse-swap-1"],
                })
            );

            expect(mockWebSocket.send).toHaveBeenCalledWith(
                JSON.stringify({
                    op: "subscribe",
                    channel: "swap.update",
                    args: ["submarine-swap-1"],
                })
            );
        });

        it("should handle WebSocket connection timeout", async () => {
            vi.useFakeTimers();

            await swapManager.start([]);

            // Advance time past connection timeout
            vi.advanceTimersByTime(15000);

            expect(mockWebSocket.close).toHaveBeenCalled();

            vi.useRealTimers();
        });

        it("should fall back to polling on WebSocket error", async () => {
            const onWebSocketDisconnected = vi.fn();
            swapManager = new SwapManager(swapProvider, {
                events: { onWebSocketDisconnected },
            });
            swapManager.setCallbacks({
                claim: vi.fn(),
                refund: vi.fn(),
                saveSwap: vi.fn(),
            });

            await swapManager.start([]);

            // Trigger error
            mockWebSocket.onerror(new Error("Connection failed"));

            const stats = swapManager.getStats();
            expect(stats.usePollingFallback).toBe(true);
            expect(onWebSocketDisconnected).toHaveBeenCalled();
        });

        it("should reconnect with exponential backoff", async () => {
            vi.useFakeTimers();

            await swapManager.start([]);

            // Trigger onopen then close
            mockWebSocket.onopen();
            mockWebSocket.onclose();

            const stats1 = swapManager.getStats();
            expect(stats1.currentReconnectDelay).toBeGreaterThan(0);

            // Advance time to trigger reconnect
            vi.advanceTimersByTime(stats1.currentReconnectDelay);

            const stats2 = swapManager.getStats();
            expect(stats2.currentReconnectDelay).toBeGreaterThanOrEqual(
                stats1.currentReconnectDelay
            );

            vi.useRealTimers();
        });
    });

    describe("Swap Monitoring", () => {
        beforeEach(() => {
            swapManager = new SwapManager(swapProvider);
            swapManager.setCallbacks({
                claim: vi.fn(),
                refund: vi.fn(),
                saveSwap: vi.fn(),
            });

            // Mock fetch for polling (needed when WebSocket connects)
            global.fetch = vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            status: "swap.created",
                        }),
                    headers: new Headers({
                        "content-length": "100",
                    }),
                } as Response)
            );
        });

        it("should add swap to monitoring", async () => {
            await swapManager.start([]);

            swapManager.addSwap(mockReverseSwap);

            const stats = swapManager.getStats();
            expect(stats.monitoredSwaps).toBe(1);

            const pending = swapManager.getPendingSwaps();
            expect(pending).toHaveLength(1);
            expect(pending[0].id).toBe("reverse-swap-1");
        });

        it("should remove swap from monitoring", async () => {
            await swapManager.start([mockReverseSwap]);

            swapManager.removeSwap("reverse-swap-1");

            const stats = swapManager.getStats();
            expect(stats.monitoredSwaps).toBe(0);
        });

        it("should subscribe to new swap if WebSocket is open", async () => {
            await swapManager.start([]);

            // Trigger onopen callback (it was assigned by SwapManager)
            if (mockWebSocket.onopen) {
                mockWebSocket.onopen();
            }

            // Give async operations time to complete
            await new Promise((resolve) => setTimeout(resolve, 10));

            swapManager.addSwap(mockReverseSwap);

            expect(mockWebSocket.send).toHaveBeenCalledWith(
                JSON.stringify({
                    op: "subscribe",
                    channel: "swap.update",
                    args: ["reverse-swap-1"],
                })
            );
        });

        it("should filter out final status swaps on start", async () => {
            const completedSwap: PendingReverseSwap = {
                ...mockReverseSwap,
                status: "invoice.settled",
            };

            await swapManager.start([mockReverseSwap, completedSwap]);

            const stats = swapManager.getStats();
            // Only mockReverseSwap should be monitored (swap.created)
            expect(stats.monitoredSwaps).toBe(1);
        });
    });

    describe("Status Updates", () => {
        let claimCallback: any;
        let refundCallback: any;
        let saveSwapCallback: any;
        let onSwapUpdate: any;
        let onSwapCompleted: any;
        let onActionExecuted: any;

        beforeEach(() => {
            claimCallback = vi.fn();
            refundCallback = vi.fn();
            saveSwapCallback = vi.fn();
            onSwapUpdate = vi.fn();
            onSwapCompleted = vi.fn();
            onActionExecuted = vi.fn();

            swapManager = new SwapManager(swapProvider, {
                enableAutoActions: true,
                events: {
                    onSwapUpdate,
                    onSwapCompleted,
                    onActionExecuted,
                },
            });

            swapManager.setCallbacks({
                claim: claimCallback,
                refund: refundCallback,
                saveSwap: saveSwapCallback,
            });

            // Mock fetch for polling (needed when WebSocket connects)
            global.fetch = vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            status: "swap.created",
                        }),
                    headers: new Headers({
                        "content-length": "100",
                    }),
                } as Response)
            );
        });

        it("should handle reverse swap status update", async () => {
            await swapManager.start([mockReverseSwap]);
            mockWebSocket.onopen();

            // Simulate WebSocket message
            const message = {
                event: "update",
                args: [
                    {
                        id: "reverse-swap-1",
                        status: "transaction.confirmed",
                    },
                ],
            };

            await mockWebSocket.onmessage({
                data: JSON.stringify(message),
            });

            expect(onSwapUpdate).toHaveBeenCalled();
            expect(saveSwapCallback).toHaveBeenCalled();
        });

        it("should auto-claim reverse swap when claimable", async () => {
            await swapManager.start([mockReverseSwap]);
            mockWebSocket.onopen();

            // Simulate status update to claimable
            const message = {
                event: "update",
                args: [
                    {
                        id: "reverse-swap-1",
                        status: "transaction.confirmed",
                    },
                ],
            };

            await mockWebSocket.onmessage({
                data: JSON.stringify(message),
            });

            expect(claimCallback).toHaveBeenCalled();
            expect(onActionExecuted).toHaveBeenCalledWith(
                expect.objectContaining({ id: "reverse-swap-1" }),
                "claim"
            );
        });

        it("should auto-refund submarine swap when refundable", async () => {
            const refundableSwap: PendingSubmarineSwap = {
                ...mockSubmarineSwap,
                status: "invoice.set",
            };

            await swapManager.start([refundableSwap]);
            mockWebSocket.onopen();

            // Simulate status update to refundable
            const message = {
                event: "update",
                args: [
                    {
                        id: "submarine-swap-1",
                        status: "invoice.failedToPay",
                    },
                ],
            };

            await mockWebSocket.onmessage({
                data: JSON.stringify(message),
            });

            expect(refundCallback).toHaveBeenCalled();
            expect(onActionExecuted).toHaveBeenCalledWith(
                expect.objectContaining({ id: "submarine-swap-1" }),
                "refund"
            );
        });

        it("should remove swap on final status", async () => {
            await swapManager.start([mockReverseSwap]);
            mockWebSocket.onopen();

            // Simulate status update to final
            const message = {
                event: "update",
                args: [
                    {
                        id: "reverse-swap-1",
                        status: "invoice.settled",
                    },
                ],
            };

            await mockWebSocket.onmessage({
                data: JSON.stringify(message),
            });

            expect(onSwapCompleted).toHaveBeenCalled();

            const stats = swapManager.getStats();
            expect(stats.monitoredSwaps).toBe(0);
        });

        it("should not execute action if auto-actions disabled", async () => {
            swapManager = new SwapManager(swapProvider, {
                enableAutoActions: false,
            });
            swapManager.setCallbacks({
                claim: claimCallback,
                refund: refundCallback,
                saveSwap: saveSwapCallback,
            });

            await swapManager.start([mockReverseSwap]);
            mockWebSocket.onopen();

            // Simulate status update to claimable
            const message = {
                event: "update",
                args: [
                    {
                        id: "reverse-swap-1",
                        status: "transaction.confirmed",
                    },
                ],
            };

            await mockWebSocket.onmessage({
                data: JSON.stringify(message),
            });

            expect(claimCallback).not.toHaveBeenCalled();
        });

        it("should ignore duplicate status updates", async () => {
            await swapManager.start([mockReverseSwap]);
            mockWebSocket.onopen();

            const message = {
                event: "update",
                args: [
                    {
                        id: "reverse-swap-1",
                        status: "swap.created",
                    },
                ],
            };

            await mockWebSocket.onmessage({
                data: JSON.stringify(message),
            });

            // Should not emit update for same status
            expect(onSwapUpdate).not.toHaveBeenCalled();
        });

        it("should handle error in WebSocket message", async () => {
            const onSwapFailed = vi.fn();
            swapManager = new SwapManager(swapProvider, {
                events: { onSwapFailed },
            });
            swapManager.setCallbacks({
                claim: vi.fn(),
                refund: vi.fn(),
                saveSwap: vi.fn(),
            });

            await swapManager.start([mockReverseSwap]);

            // Trigger onopen callback
            if (mockWebSocket.onopen) {
                mockWebSocket.onopen();
            }

            // Give async operations time to complete
            await new Promise((resolve) => setTimeout(resolve, 10));

            const message = {
                event: "update",
                args: [
                    {
                        id: "reverse-swap-1",
                        error: "Swap failed",
                    },
                ],
            };

            // Trigger onmessage callback
            if (mockWebSocket.onmessage) {
                mockWebSocket.onmessage({
                    data: JSON.stringify(message),
                });
            }

            // Give error handler time to execute
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(onSwapFailed).toHaveBeenCalled();
        });
    });

    describe("Polling", () => {
        beforeEach(() => {
            swapManager = new SwapManager(swapProvider);
            swapManager.setCallbacks({
                claim: vi.fn(),
                refund: vi.fn(),
                saveSwap: vi.fn(),
            });

            // Mock fetch for polling
            global.fetch = vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            status: "swap.created",
                        }),
                    headers: new Headers({
                        "content-length": "100",
                    }),
                } as Response)
            );
        });

        it("should poll all swaps after WebSocket connects", async () => {
            await swapManager.start([mockReverseSwap]);

            // Trigger WebSocket open callback
            if (mockWebSocket.onopen) {
                mockWebSocket.onopen();
            }

            // Give async operations time to complete (including initial poll)
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(global.fetch).toHaveBeenCalled();
        });

        it("should use exponential backoff for polling fallback", async () => {
            vi.useFakeTimers();

            swapManager = new SwapManager(swapProvider, {
                pollRetryDelayMs: 1000,
            });
            swapManager.setCallbacks({
                claim: vi.fn(),
                refund: vi.fn(),
                saveSwap: vi.fn(),
            });

            await swapManager.start([mockReverseSwap]);

            // Trigger WebSocket error to enable fallback
            mockWebSocket.onerror(new Error("Connection failed"));

            const stats1 = swapManager.getStats();
            expect(stats1.usePollingFallback).toBe(true);

            // Advance by initial delay
            await vi.advanceTimersByTimeAsync(1000);

            const stats2 = swapManager.getStats();
            expect(stats2.currentPollRetryDelay).toBeGreaterThan(1000);

            vi.useRealTimers();
        });
    });

    describe("Per-Swap Subscriptions", () => {
        beforeEach(() => {
            swapManager = new SwapManager(swapProvider);
            swapManager.setCallbacks({
                claim: vi.fn().mockResolvedValue(undefined),
                refund: vi.fn().mockResolvedValue(undefined),
                saveSwap: vi.fn().mockResolvedValue(undefined),
            });
        });

        it("should subscribe to swap updates", async () => {
            // Create a fresh copy to avoid mutations from other tests
            const freshSwap = {
                ...mockSubmarineSwap,
                status: "invoice.set" as const,
            };
            await swapManager.start([freshSwap]);

            // Subscribe to swap updates
            const updateCallback = vi.fn();
            const unsubscribe = swapManager.subscribeToSwapUpdates(
                "submarine-swap-1",
                updateCallback
            );

            // Trigger a status update
            await swapManager["handleSwapStatusUpdate"](
                freshSwap,
                "transaction.mempool"
            );

            expect(updateCallback).toHaveBeenCalledWith(
                expect.objectContaining({ id: "submarine-swap-1" }),
                "invoice.set"
            );

            unsubscribe();
            await swapManager.stop();
        });

        it("should support multiple subscribers for same swap", async () => {
            // Create a fresh copy to avoid mutations from other tests
            const freshSwap = {
                ...mockSubmarineSwap,
                status: "invoice.set" as const,
            };
            await swapManager.start([freshSwap]);

            // Subscribe two callbacks to the same swap
            const callback1 = vi.fn();
            const callback2 = vi.fn();
            const unsubscribe1 = swapManager.subscribeToSwapUpdates(
                "submarine-swap-1",
                callback1
            );
            const unsubscribe2 = swapManager.subscribeToSwapUpdates(
                "submarine-swap-1",
                callback2
            );

            // Trigger a status update
            await swapManager["handleSwapStatusUpdate"](
                freshSwap,
                "transaction.mempool"
            );

            expect(callback1).toHaveBeenCalled();
            expect(callback2).toHaveBeenCalled();

            unsubscribe1();
            unsubscribe2();
            await swapManager.stop();
        });
    });

    describe("Race Condition Prevention", () => {
        beforeEach(() => {
            swapManager = new SwapManager(swapProvider);
        });

        it("should prevent concurrent processing of same swap", async () => {
            const claimCallback = vi.fn().mockImplementation(async () => {
                // Simulate slow claim operation
                await new Promise((resolve) => setTimeout(resolve, 50));
            });

            // Disable auto actions so we can manually test the locking mechanism
            swapManager = new SwapManager(swapProvider, {
                enableAutoActions: false,
            });

            swapManager.setCallbacks({
                claim: claimCallback,
                refund: vi.fn().mockResolvedValue(undefined),
                saveSwap: vi.fn().mockResolvedValue(undefined),
            });

            const claimableSwap = {
                ...mockReverseSwap,
                status: "transaction.confirmed" as const,
            };
            await swapManager.start([claimableSwap]);

            // Check swap is not being processed initially
            expect(swapManager.isProcessing("reverse-swap-1")).toBe(false);

            // Trigger first autonomous action (will start processing)
            const promise1 =
                swapManager["executeAutonomousAction"](claimableSwap);

            // Check swap is now being processed
            expect(swapManager.isProcessing("reverse-swap-1")).toBe(true);

            // Trigger second autonomous action (should be skipped)
            const promise2 =
                swapManager["executeAutonomousAction"](claimableSwap);

            await Promise.all([promise1, promise2]);

            // Claim should only be called once (no race condition)
            expect(claimCallback).toHaveBeenCalledTimes(1);

            // Check swap is no longer being processed
            expect(swapManager.isProcessing("reverse-swap-1")).toBe(false);

            await swapManager.stop();
        });

        it("should check if manager has swap", async () => {
            swapManager.setCallbacks({
                claim: vi.fn().mockResolvedValue(undefined),
                refund: vi.fn().mockResolvedValue(undefined),
                saveSwap: vi.fn().mockResolvedValue(undefined),
            });

            // Create a fresh copy to avoid mutations from other tests
            const freshSwap = {
                ...mockReverseSwap,
                status: "swap.created" as const,
            };
            await swapManager.start([freshSwap]);

            expect(swapManager.hasSwap("reverse-swap-1")).toBe(true);
            expect(swapManager.hasSwap("non-existent-swap")).toBe(false);

            await swapManager.stop();
        });
    });

    describe("Wait for Completion", () => {
        const mockTxId = "abc123def456";

        beforeEach(() => {
            // Mock getReverseSwapTxId to return a mock txid
            vi.spyOn(swapProvider, "getReverseSwapTxId").mockResolvedValue({
                id: mockTxId,
                hex: "0200000001...",
            });

            swapManager = new SwapManager(swapProvider);
            swapManager.setCallbacks({
                claim: vi.fn().mockResolvedValue(undefined),
                refund: vi.fn().mockResolvedValue(undefined),
                saveSwap: vi.fn().mockResolvedValue(undefined),
            });
        });

        it("should wait for reverse swap completion", async () => {
            const confirmedSwap = {
                ...mockReverseSwap,
                status: "transaction.confirmed" as const,
            };
            await swapManager.start([confirmedSwap]);

            // Start waiting for completion
            const waitPromise =
                swapManager.waitForSwapCompletion("reverse-swap-1");

            // Simulate status update to final status
            setTimeout(async () => {
                await swapManager["handleSwapStatusUpdate"](
                    confirmedSwap,
                    "invoice.settled"
                );
            }, 10);

            // Should resolve when swap reaches final status
            const result = await waitPromise;
            expect(result.txid).toBe(mockTxId);
            expect(swapProvider.getReverseSwapTxId).toHaveBeenCalledWith(
                "reverse-swap-1"
            );

            await swapManager.stop();
        });

        it("should reject if swap not found", async () => {
            await swapManager.start([]);

            await expect(
                swapManager.waitForSwapCompletion("non-existent-swap")
            ).rejects.toThrow("Swap non-existent-swap not found in manager");

            await swapManager.stop();
        });

        it("should resolve immediately if swap already completed", async () => {
            const completedSwap = {
                ...mockReverseSwap,
                status: "invoice.settled" as const,
            };
            await swapManager.start([completedSwap]);

            // Should resolve immediately since swap is already in final status
            const result =
                await swapManager.waitForSwapCompletion("reverse-swap-1");
            expect(result.txid).toBe(mockTxId);
            expect(swapProvider.getReverseSwapTxId).toHaveBeenCalledWith(
                "reverse-swap-1"
            );

            await swapManager.stop();
        });

        it("should reject if getReverseSwapTxId fails", async () => {
            vi.spyOn(swapProvider, "getReverseSwapTxId").mockRejectedValue(
                new Error("Failed to fetch txid")
            );

            const completedSwap = {
                ...mockReverseSwap,
                status: "invoice.settled" as const,
            };
            await swapManager.start([completedSwap]);

            await expect(
                swapManager.waitForSwapCompletion("reverse-swap-1")
            ).rejects.toThrow("Failed to fetch txid");

            await swapManager.stop();
        });
    });

    describe("Statistics", () => {
        beforeEach(() => {
            swapManager = new SwapManager(swapProvider);
            swapManager.setCallbacks({
                claim: vi.fn(),
                refund: vi.fn(),
                saveSwap: vi.fn(),
            });

            // Mock fetch for polling (needed when WebSocket connects)
            global.fetch = vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            status: "swap.created",
                        }),
                    headers: new Headers({
                        "content-length": "100",
                    }),
                } as Response)
            );
        });

        it("should return correct stats", async () => {
            const stats1 = swapManager.getStats();
            expect(stats1.isRunning).toBe(false);
            expect(stats1.monitoredSwaps).toBe(0);
            expect(stats1.websocketConnected).toBe(false);

            // Create fresh copies to avoid mutations from other tests
            const freshReverseSwap = {
                ...mockReverseSwap,
                status: "swap.created" as const,
            };
            const freshSubmarineSwap = {
                ...mockSubmarineSwap,
                status: "invoice.set" as const,
            };
            await swapManager.start([freshReverseSwap, freshSubmarineSwap]);

            // Trigger onopen callback
            if (mockWebSocket.onopen) {
                mockWebSocket.onopen();
            }

            // Give async operations time to complete
            await new Promise((resolve) => setTimeout(resolve, 10));

            const stats2 = swapManager.getStats();
            expect(stats2.isRunning).toBe(true);
            expect(stats2.monitoredSwaps).toBe(2);
            expect(stats2.websocketConnected).toBe(true);
        });
    });
});
