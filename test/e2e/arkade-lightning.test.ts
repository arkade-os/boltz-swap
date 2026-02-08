import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ArkadeLightning } from "../../src/arkade-lightning";
import {
    BoltzSwapProvider,
    CreateReverseSwapRequest,
    CreateReverseSwapResponse,
    CreateSubmarineSwapRequest,
    CreateSubmarineSwapResponse,
} from "../../src/boltz-swap-provider";
import { SwapManager } from "../../src/swap-manager";
import type {
    PendingReverseSwap,
    PendingSubmarineSwap,
    ArkadeLightningConfig,
} from "../../src/types";
import {
    RestArkProvider,
    RestIndexerProvider,
    Identity,
    Wallet,
    SingleKey,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { decodeInvoice } from "../../src/utils/decoding";
import { pubECDSA } from "@scure/btc-signer/utils.js";
import { randomBytes } from "crypto";
import { SwapRepository } from "../../src/repositories/swap-repository";

// Scaffolding test file for ArkadeLightning
// This file will be updated when implementing features from README.md

// Helper to check if regtest environment is running
async function isRegtestAvailable(): Promise<boolean> {
    try {
        const response = await fetch("http://localhost:9069/version");
        return response.ok;
    } catch {
        return false;
    }
}

// Check if regtest is available before running tests
const skipE2E = !(await isRegtestAvailable());

describe("ArkadeLightning", () => {
    let indexerProvider: RestIndexerProvider;
    let swapProvider: BoltzSwapProvider;
    let params: ArkadeLightningConfig;
    let arkProvider: RestArkProvider;
    let lightning: ArkadeLightning;
    let identity: Identity;
    let wallet: Wallet;
    let swapRepository: SwapRepository;

    const seckeys = {
        alice: schnorr.utils.randomSecretKey(),
        boltz: schnorr.utils.randomSecretKey(),
        server: schnorr.utils.randomSecretKey(),
    };

    const compressedPubkeys = {
        alice: hex.encode(pubECDSA(seckeys.alice, true)),
        boltz: hex.encode(pubECDSA(seckeys.boltz, true)),
        server: hex.encode(pubECDSA(seckeys.server, true)),
    };

    const mock = {
        address: "mock-address",
        amount: 21000,
        hex: "mock-hex",
        id: "mock-id",
        invoice: {
            amount: 3000000, // amount in satoshis
            description: "Payment request with multipart support",
            paymentHash:
                "850aeaf5f69670e8889936fc2e0cff3ceb0c3b5eab8f04ae57767118db673a91",
            expiry: 28800, // 8 hours in seconds
            address:
                "lntb30m1pw2f2yspp5s59w4a0kjecw3zyexm7zur8l8n4scw674w" +
                "8sftjhwec33km882gsdpa2pshjmt9de6zqun9w96k2um5ypmkjar" +
                "gypkh2mr5d9cxzun5ypeh2ursdae8gxqruyqvzddp68gup69uhnz" +
                "wfj9cejuvf3xshrwde68qcrswf0d46kcarfwpshyaplw3skw0tdw" +
                "4k8g6tsv9e8glzddp68gup69uhnzwfj9cejuvf3xshrwde68qcrs" +
                "wf0d46kcarfwpshyaplw3skw0tdw4k8g6tsv9e8gcqpfmy8keu46" +
                "zsrgtz8sxdym7yedew6v2jyfswg9zeqetpj2yw3f52ny77c5xsrg" +
                "53q9273vvmwhc6p0gucz2av5gtk3esevk0cfhyvzgxgpgyyavt",
        },
        lockupAddress: "mock-lockup-address",
        preimage: "mock-preimage",
        pubkeys: {
            alice: schnorr.getPublicKey(seckeys.alice),
            boltz: schnorr.getPublicKey(seckeys.boltz),
            server: schnorr.getPublicKey(seckeys.server),
        },
        txid: "mock-txid",
    };

    const createSubmarineSwapRequest: CreateSubmarineSwapRequest = {
        invoice: mock.invoice.address,
        refundPublicKey: compressedPubkeys.alice,
    };

    const createSubmarineSwapResponse: CreateSubmarineSwapResponse = {
        id: mock.id,
        address: mock.address,
        expectedAmount: mock.invoice.amount,
        acceptZeroConf: true,
        claimPublicKey: compressedPubkeys.boltz,
        timeoutBlockHeights: {
            refund: 17,
            unilateralClaim: 21,
            unilateralRefund: 42,
            unilateralRefundWithoutReceiver: 63,
        },
    };

    const createReverseSwapRequest: CreateReverseSwapRequest = {
        claimPublicKey: compressedPubkeys.alice,
        preimageHash: mock.invoice.paymentHash,
        invoiceAmount: mock.invoice.amount,
    };

    const createReverseSwapResponse: CreateReverseSwapResponse = {
        id: mock.id,
        invoice: mock.invoice.address,
        onchainAmount: mock.invoice.amount,
        lockupAddress: mock.lockupAddress,
        refundPublicKey: compressedPubkeys.boltz,
        timeoutBlockHeights: {
            refund: 17,
            unilateralClaim: 21,
            unilateralRefund: 42,
            unilateralRefundWithoutReceiver: 63,
        },
    };

    const mockReverseSwap: PendingReverseSwap = {
        id: "reverse-mock-id",
        type: "reverse",
        createdAt: Date.now(),
        preimage: hex.encode(randomBytes(20)),
        request: createReverseSwapRequest,
        response: createReverseSwapResponse,
        status: "swap.created",
    };

    const mockSubmarineSwap: PendingSubmarineSwap = {
        id: "submarine-mock-id",
        type: "submarine",
        createdAt: Date.now(),
        request: createSubmarineSwapRequest,
        response: createSubmarineSwapResponse,
        status: "swap.created",
    };

    beforeEach(async () => {
        vi.clearAllMocks();

        const url = "http://localhost:7070";

        // Create identity
        identity = SingleKey.fromPrivateKey(seckeys.alice);

        // Create providers
        arkProvider = new RestArkProvider(url);
        indexerProvider = new RestIndexerProvider(url);
        swapProvider = new BoltzSwapProvider({ network: "regtest" });

        swapRepository = {
            saveSwap: vi.fn(),
            deleteSwap: vi.fn(),
            getAllSwaps: vi.fn(async () => []),
            clear: vi.fn(),
        } as any;

        // Create wallet
        wallet = await Wallet.create({
            identity,
            arkServerUrl: url,
        });

        // Params for new ArkadeLightning()
        params = {
            wallet,
            swapProvider,
            arkProvider,
            indexerProvider,
            swapRepository,
        };

        // Create ArkadeLightning instance
        lightning = new ArkadeLightning(params);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        swapRepository.clear();
    });

    describe("Initialization", () => {
        it("should be instantiated with wallet and swap provider", () => {
            expect(() => new ArkadeLightning({ ...params })).not.toThrow();
        });

        it("should fail to instantiate without required config", async () => {
            expect(
                () =>
                    new ArkadeLightning({
                        ...params,
                        swapProvider: null as any,
                    })
            ).toThrow("Swap provider is required.");
        });

        it("should default to wallet instances without required config", async () => {
            expect(
                () =>
                    new ArkadeLightning({ ...params, arkProvider: null as any })
            ).not.toThrow();
            expect(
                () =>
                    new ArkadeLightning({
                        ...params,
                        indexerProvider: null as any,
                    })
            ).not.toThrow();
        });

        it("should have expected interface methods", () => {
            expect(lightning.claimVHTLC).toBeInstanceOf(Function);
            expect(lightning.createLightningInvoice).toBeInstanceOf(Function);
            expect(lightning.createReverseSwap).toBeInstanceOf(Function);
            expect(lightning.createSubmarineSwap).toBeInstanceOf(Function);
            expect(lightning.createVHTLCScript).toBeInstanceOf(Function);
            expect(lightning.getFees).toBeInstanceOf(Function);
            expect(lightning.getLimits).toBeInstanceOf(Function);
            expect(lightning.getPendingSubmarineSwaps).toBeInstanceOf(Function);
            expect(lightning.getPendingReverseSwaps).toBeInstanceOf(Function);
            expect(lightning.getSwapHistory).toBeInstanceOf(Function);
            expect(lightning.getSwapStatus).toBeInstanceOf(Function);
            expect(lightning.refreshSwapsStatus).toBeInstanceOf(Function);
            expect(lightning.refundVHTLC).toBeInstanceOf(Function);
            expect(lightning.sendLightningPayment).toBeInstanceOf(Function);
            expect(lightning.waitAndClaim).toBeInstanceOf(Function);
            expect(lightning.waitForSwapSettlement).toBeInstanceOf(Function);
        });
    });

    describe.skipIf(skipE2E)("Create Lightning Invoice", () => {
        it("should throw if amount is not > 0", async () => {
            // act & assert
            await expect(
                lightning.createLightningInvoice({ amount: 0 })
            ).rejects.toThrow("Amount must be greater than 0");
            await expect(
                lightning.createLightningInvoice({ amount: -1 })
            ).rejects.toThrow("Amount must be greater than 0");
        });

        it("should create a Lightning invoice", async () => {
            // act
            const result = await lightning.createLightningInvoice({
                amount: mock.amount,
            });

            const decodeInvoiceResult = decodeInvoice(result.invoice);

            // assert
            expect(decodeInvoiceResult.amountSats).toBe(mock.amount);
        });

        it("should pass description to reverse swap when creating Lightning invoice", async () => {
            // arrange
            const description = "Test payment description";

            // act
            const result = await lightning.createLightningInvoice({
                amount: mock.amount,
                description,
            });

            const decodeInvoiceResult = decodeInvoice(result.invoice);

            // assert
            expect(decodeInvoiceResult.amountSats).toBe(mock.amount);
            expect(decodeInvoiceResult.description).toBe(description);
        });
    });

    describe("Reverse Swaps", () => {
        it("should create a reverse swap", async () => {
            // act
            const pendingSwap = await lightning.createReverseSwap({
                amount: mock.invoice.amount,
            });

            // assert
            expect(pendingSwap.status).toEqual("swap.created");
        });

        it("should get correct swap status", async () => {
            // act
            const pendingSwap = await lightning.createReverseSwap({
                amount: mock.invoice.amount,
            });

            // assert
            expect(lightning.getSwapStatus).toBeInstanceOf(Function);
            const status = await lightning.getSwapStatus(pendingSwap.id);
            expect(status.status).toBe("swap.created");
        });

        it("should pass description to swap provider when creating reverse swap", async () => {
            // arrange
            const testDescription = "Test reverse swap description";

            // act
            const pendingSwap = await lightning.createReverseSwap({
                amount: mock.invoice.amount,
                description: testDescription,
            });

            const decodeInvoiceResult = decodeInvoice(
                pendingSwap.response.invoice
            );

            // assert
            expect(decodeInvoiceResult.amountSats).toBe(mock.invoice.amount);
            expect(decodeInvoiceResult.description).toBe(testDescription);
        });
    });

    describe.skip("Submarine Swaps", () => {
        it("should create a submarine swap", async () => {
            // act
            const pendingSwap = await lightning.createSubmarineSwap({
                invoice: mock.invoice.address,
            });

            // assert
            expect(pendingSwap.status).toEqual("invoice.set");
            expect(pendingSwap.request).toEqual(createSubmarineSwapRequest);
            expect(pendingSwap.response).toEqual(createSubmarineSwapResponse);
        });

        it("should get correct swap status", async () => {
            // act
            const pendingSwap = await lightning.createSubmarineSwap({
                invoice: mock.invoice.address,
            });

            // assert
            expect(lightning.getSwapStatus).toBeInstanceOf(Function);
            const status = await lightning.getSwapStatus(pendingSwap.id);
            expect(status.status).toBe("swap.created");
        });
    });

    describe("Decoding lightning invoices", () => {
        it("should decode a lightning invoice", async () => {
            // act
            const decoded = decodeInvoice(mock.invoice.address);
            // assert
            expect(decoded.expiry).toBe(mock.invoice.expiry);
            expect(decoded.amountSats).toBe(mock.invoice.amount);
            expect(decoded.description).toBe(mock.invoice.description);
            expect(decoded.paymentHash).toBe(mock.invoice.paymentHash);
        });

        it("should throw on invalid Lightning invoice", async () => {
            // act
            const invoice = "lntb30m1invalid";
            // assert
            expect(() => decodeInvoice(invoice)).toThrow();
        });
    });

    describe("Sending Lightning Payments", () => {
        it("should send a Lightning payment", async () => {
            // arrange
            const pendingSwap = mockSubmarineSwap;
            vi.spyOn(wallet, "sendBitcoin").mockResolvedValueOnce(mock.txid);
            vi.spyOn(lightning, "createSubmarineSwap").mockResolvedValueOnce(
                pendingSwap
            );
            vi.spyOn(lightning, "waitForSwapSettlement").mockResolvedValueOnce({
                preimage: mock.preimage,
            });
            // act
            const result = await lightning.sendLightningPayment({
                invoice: mock.invoice.address,
            });
            // assert
            expect(wallet.sendBitcoin).toHaveBeenCalledWith({
                address: mock.address,
                amount: mock.invoice.amount,
            });
            expect(result.amount).toBe(mock.invoice.amount);
            expect(result.preimage).toBe(mock.preimage);
            expect(result.txid).toBe(mock.txid);
        });
    });

    // TODO: Implement tests for features shown in README.md

    // Sending payments:
    // - Invoice decoding
    // - Successful Lightning payment
    // - Fee calculation and limits
    // - UTXO selection
    // - Error handling

    // Receiving payments:
    // - Invoice creation
    // - Payment monitoring
    // - Event handling (pending/confirmed/failed)

    // Swap management:
    // - Pending swap listing
    // - Refund claiming
    // - Automatic refund handling

    // Configuration:
    // - Timeout settings
    // - Fee limits
    // - Retry logic
    // - Custom refund handler

    describe("Swap Storage and History", () => {
        beforeEach(() => {
            // Mock the contract repository methods
            vi.spyOn(swapRepository, "getAllSwaps").mockResolvedValue([]);
        });

        describe("getSwapHistory", () => {
            it("should return empty array when no swaps exist", async () => {
                // act
                const result = await lightning.getSwapHistory();

                // assert
                expect(result).toEqual([]);
                expect(swapRepository.getAllSwaps).toHaveBeenCalledWith({
                    orderBy: "createdAt",
                    orderDirection: "desc",
                });
            });

            it("should return all swaps sorted by creation date (newest first)", async () => {
                // arrange
                const now = Date.now();
                const mockReverseSwaps: PendingReverseSwap[] = [
                    {
                        ...mockReverseSwap,
                        id: "reverse1",
                        createdAt: now - 3000, // oldest
                        preimage: "preimage1",
                        response: {
                            ...createReverseSwapResponse,
                            id: "reverse1",
                        },
                        status: "swap.created",
                    },
                    {
                        ...mockReverseSwap,
                        id: "reverse2",
                        createdAt: now - 1000, // newest reverse
                        preimage: "preimage2",
                        response: {
                            ...createReverseSwapResponse,
                            id: "reverse2",
                        },
                        status: "invoice.settled",
                    },
                ];

                const mockSubmarineSwaps: PendingSubmarineSwap[] = [
                    {
                        ...mockSubmarineSwap,
                        id: "submarine1",
                        createdAt: now - 2000, // middle
                        response: {
                            ...createSubmarineSwapResponse,
                            id: "submarine1",
                        },
                        status: "invoice.set",
                    },
                    {
                        ...mockSubmarineSwap,
                        id: "submarine2",
                        createdAt: now, // newest overall
                        response: {
                            ...createSubmarineSwapResponse,
                            id: "submarine2",
                        },
                        status: "swap.created",
                    },
                ];

                vi.spyOn(swapRepository, "getAllSwaps").mockResolvedValueOnce([
                    mockSubmarineSwaps[1],
                    mockReverseSwaps[1],
                    mockSubmarineSwaps[0],
                    mockReverseSwaps[0],
                ]);

                // act
                const result = await lightning.getSwapHistory();

                // assert
                expect(result).toHaveLength(4);
                // Should be sorted by createdAt desc (newest first)
                expect(result[0].id).toBe("submarine2"); // newest
                expect(result[1].id).toBe("reverse2");
                expect(result[2].id).toBe("submarine1");
                expect(result[3].id).toBe("reverse1"); // oldest

                // Verify the sort order
                for (let i = 0; i < result.length - 1; i++) {
                    expect(result[i].createdAt).toBeGreaterThanOrEqual(
                        result[i + 1].createdAt
                    );
                }
            });

            it("should handle mixed swap types and statuses correctly", async () => {
                // arrange
                const mockReverseSwaps: PendingReverseSwap[] = [
                    {
                        ...mockReverseSwap,
                        createdAt: Date.now() - 1000,
                        preimage: "preimage1",
                        response: {
                            ...createReverseSwapResponse,
                            id: "reverse1",
                        },
                        status: "transaction.confirmed",
                    },
                ];

                const mockSubmarineSwaps: PendingSubmarineSwap[] = [
                    {
                        ...mockSubmarineSwap,
                        response: {
                            ...createSubmarineSwapResponse,
                            id: "submarine1",
                        },
                        status: "transaction.failed",
                    },
                ];

                vi.spyOn(swapRepository, "getAllSwaps").mockResolvedValueOnce([
                    mockSubmarineSwaps[0],
                    mockReverseSwaps[0],
                ]);

                // act
                const result = await lightning.getSwapHistory();

                // assert
                expect(result).toHaveLength(2);
                expect(result[0].type).toBe("submarine");
                expect(result[1].type).toBe("reverse");
            });
        });

        describe("swap persistence during operations", () => {
            it("should save reverse swap when creating lightning invoice", async () => {
                // arrange
                vi.spyOn(lightning, "createReverseSwap").mockResolvedValueOnce(
                    mockReverseSwap
                );

                // act
                await lightning.createLightningInvoice({ amount: mock.amount });

                // assert
                expect(lightning.createReverseSwap).toHaveBeenCalledWith({
                    amount: mock.amount,
                });
            });

            it("should save submarine swap when creating swap", async () => {
                // arrange
                vi.spyOn(
                    swapProvider,
                    "createSubmarineSwap"
                ).mockResolvedValueOnce(createSubmarineSwapResponse);

                // act
                const result = await lightning.createSubmarineSwap({
                    invoice: mock.invoice.address,
                });

                // assert
                expect(swapRepository.saveSwap).toHaveBeenCalledWith(
                    expect.objectContaining({
                        type: "submarine",
                        status: "invoice.set",
                        request: expect.objectContaining({
                            invoice: mock.invoice.address,
                        }),
                        response: createSubmarineSwapResponse,
                    })
                );
                expect(result.type).toBe("submarine");
                expect(result.status).toBe("invoice.set");
            });

            it("should save reverse swap when creating reverse swap", async () => {
                // arrange
                vi.spyOn(
                    swapProvider,
                    "createReverseSwap"
                ).mockResolvedValueOnce(createReverseSwapResponse);

                // act
                const result = await lightning.createReverseSwap({
                    amount: mock.invoice.amount,
                });

                // assert
                expect(swapRepository.saveSwap).toHaveBeenCalledWith(
                    expect.objectContaining({
                        type: "reverse",
                        status: "swap.created",
                        request: expect.objectContaining({
                            invoiceAmount: mock.invoice.amount,
                        }),
                        response: createReverseSwapResponse,
                    })
                );
                expect(result.type).toBe("reverse");
                expect(result.status).toBe("swap.created");
            });
        });
    });

    describe("waitAndClaim", () => {
        it("should return valid txid when transaction is available", async () => {
            // arrange
            const pendingSwap = mockReverseSwap;

            // Mock getSwapStatus to return a status with valid transaction
            vi.spyOn(swapProvider, "getSwapStatus").mockResolvedValue({
                status: "invoice.settled",
            });

            // Mock getReverseSwapTxId to return an object with valid transaction id
            vi.spyOn(swapProvider, "getReverseSwapTxId").mockResolvedValue({
                id: mock.txid,
                hex: "abc123",
                timeoutBlockHeight: 123,
            });

            // Mock monitorSwap to directly trigger the invoice.settled case
            vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                async (_swapId, update) => {
                    setTimeout(() => update("invoice.settled"), 10);
                }
            );

            // act
            const result = await lightning.waitAndClaim(pendingSwap);

            // assert
            expect(result.txid).toBe(mock.txid);
            expect(result.txid).not.toBe("");
        });

        it("should throw error when transaction id is empty string", async () => {
            // arrange
            const pendingSwap = mockReverseSwap;

            // Mock getSwapStatus to return a status with empty transaction id
            vi.spyOn(swapProvider, "getSwapStatus").mockResolvedValue({
                status: "invoice.settled",
                transaction: {
                    id: "",
                    hex: mock.hex,
                },
            });

            // Mock getReverseSwapTxId to return a undefined id (the problematic case)
            vi.spyOn(swapProvider, "getReverseSwapTxId").mockResolvedValue({
                id: "",
                hex: "abc123",
                timeoutBlockHeight: 123,
            });

            // Mock monitorSwap to directly trigger the invoice.settled case
            vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                async (_swapId, update) => {
                    setTimeout(() => update("invoice.settled"), 10);
                }
            );

            // act & assert
            await expect(lightning.waitAndClaim(pendingSwap)).rejects.toThrow(
                "Transaction ID not available for settled swap"
            );
        });
    });

    describe.skipIf(skipE2E)("SwapManager Integration", () => {
        let swapManagerLightning: ArkadeLightning;

        afterEach(async () => {
            // Clean up swap manager after each test
            if (swapManagerLightning) {
                await swapManagerLightning.stopSwapManager();
            }
        });

        describe("Initialization with SwapManager", () => {
            it("should instantiate with swapManager enabled (boolean true)", () => {
                // act
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: true,
                });

                // assert
                expect(swapManagerLightning.getSwapManager()).not.toBeNull();
            });

            it("should instantiate with swapManager config object", () => {
                // act
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        enableAutoActions: false,
                        pollInterval: 60000,
                    },
                });

                // assert
                expect(swapManagerLightning.getSwapManager()).not.toBeNull();
            });

            it("should have null swapManager when disabled", () => {
                // act
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: false,
                });

                // assert
                expect(swapManagerLightning.getSwapManager()).toBeNull();
            });

            it("should have null swapManager when not configured", () => {
                // assert - using the default lightning instance without swapManager
                expect(lightning.getSwapManager()).toBeNull();
            });

            it("should have SwapManager interface methods", () => {
                // arrange
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: true,
                });

                const manager = swapManagerLightning.getSwapManager();

                // assert
                expect(manager).not.toBeNull();
                expect(manager!.start).toBeInstanceOf(Function);
                expect(manager!.stop).toBeInstanceOf(Function);
                expect(manager!.addSwap).toBeInstanceOf(Function);
                expect(manager!.removeSwap).toBeInstanceOf(Function);
                expect(manager!.getPendingSwaps).toBeInstanceOf(Function);
                expect(manager!.hasSwap).toBeInstanceOf(Function);
                expect(manager!.isProcessing).toBeInstanceOf(Function);
                expect(manager!.getStats).toBeInstanceOf(Function);
                expect(manager!.subscribeToSwapUpdates).toBeInstanceOf(
                    Function
                );
                expect(manager!.waitForSwapCompletion).toBeInstanceOf(Function);
                expect(manager!.onSwapUpdate).toBeInstanceOf(Function);
                expect(manager!.onSwapCompleted).toBeInstanceOf(Function);
                expect(manager!.onSwapFailed).toBeInstanceOf(Function);
                expect(manager!.onActionExecuted).toBeInstanceOf(Function);
                expect(manager!.onWebSocketConnected).toBeInstanceOf(Function);
                expect(manager!.onWebSocketDisconnected).toBeInstanceOf(
                    Function
                );
            });
        });

        describe("SwapManager Lifecycle", () => {
            it("should start and stop swap manager manually", async () => {
                // arrange - create with autoStart disabled
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        autoStart: false,
                    },
                });

                const manager = swapManagerLightning.getSwapManager()!;

                // assert initial state
                expect((await manager.getStats()).isRunning).toBe(false);

                // act - start
                await swapManagerLightning.startSwapManager();

                // assert - running
                expect((await manager.getStats()).isRunning).toBe(true);

                // act - stop
                await swapManagerLightning.stopSwapManager();

                // assert - stopped
                expect((await manager.getStats()).isRunning).toBe(false);
            });

            it("should throw when starting swap manager without config", async () => {
                // assert
                await expect(lightning.startSwapManager()).rejects.toThrow(
                    "SwapManager is not enabled"
                );
            });

            it("should not throw when stopping disabled swap manager", async () => {
                // act & assert
                await expect(
                    lightning.stopSwapManager()
                ).resolves.toBeUndefined();
            });
        });

        describe("SwapManager Stats", () => {
            it("should return correct stats when not running", async () => {
                // arrange
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        autoStart: false,
                    },
                });

                const manager = swapManagerLightning.getSwapManager()!;

                // act
                const stats = await manager.getStats();

                // assert
                expect(stats.isRunning).toBe(false);
                expect(stats.monitoredSwaps).toBe(0);
                expect(stats.websocketConnected).toBe(false);
                expect(stats.usePollingFallback).toBe(false);
                expect(typeof stats.currentReconnectDelay).toBe("number");
                expect(typeof stats.currentPollRetryDelay).toBe("number");
            });

            it("should return correct stats when running", async () => {
                // arrange
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        autoStart: false,
                    },
                });

                const manager = swapManagerLightning.getSwapManager()!;

                // act
                await swapManagerLightning.startSwapManager();
                const stats = await manager.getStats();

                // assert
                expect(stats.isRunning).toBe(true);
                expect(stats.monitoredSwaps).toBe(0);
            });
        });

        describe("SwapManager Add/Remove Swaps", () => {
            it("should add swap to monitoring", async () => {
                // arrange
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        autoStart: false,
                    },
                });

                const manager = swapManagerLightning.getSwapManager()!;
                await swapManagerLightning.startSwapManager();

                // act
                await manager.addSwap(mockReverseSwap);

                // assert
                expect(await manager.hasSwap(mockReverseSwap.id)).toBe(true);
                expect((await manager.getStats()).monitoredSwaps).toBe(1);
                expect(await manager.getPendingSwaps()).toHaveLength(1);
                expect((await manager.getPendingSwaps())[0].id).toBe(
                    mockReverseSwap.id
                );
            });

            it("should remove swap from monitoring", async () => {
                // arrange
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        autoStart: false,
                    },
                });

                const manager = swapManagerLightning.getSwapManager()!;
                await swapManagerLightning.startSwapManager();
                await manager.addSwap(mockReverseSwap);

                // act
                await manager.removeSwap(mockReverseSwap.id);

                // assert
                expect(await manager.hasSwap(mockReverseSwap.id)).toBe(false);
                expect((await manager.getStats()).monitoredSwaps).toBe(0);
                expect(await manager.getPendingSwaps()).toHaveLength(0);
            });

            it("should add multiple swaps", async () => {
                // arrange
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        autoStart: false,
                    },
                });

                const manager = swapManagerLightning.getSwapManager()!;
                await swapManagerLightning.startSwapManager();

                const reverseSwap2: PendingReverseSwap = {
                    ...mockReverseSwap,
                    id: "reverse-swap-2",
                    preimage: hex.encode(randomBytes(20)),
                };

                // act
                await manager.addSwap(mockReverseSwap);
                await manager.addSwap(mockSubmarineSwap);
                await manager.addSwap(reverseSwap2);

                // assert
                expect((await manager.getStats()).monitoredSwaps).toBe(3);
                expect(await manager.hasSwap(mockReverseSwap.id)).toBe(true);
                expect(await manager.hasSwap(mockSubmarineSwap.id)).toBe(true);
                expect(await manager.hasSwap("reverse-swap-2")).toBe(true);
            });
        });

        describe("SwapManager Event Listeners", () => {
            it("should add and remove swap update listener", async () => {
                // arrange
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        autoStart: false,
                    },
                });

                const manager = swapManagerLightning.getSwapManager()!;
                const listener = vi.fn();

                // act - add listener
                const unsubscribe = await manager.onSwapUpdate(listener);

                // assert - unsubscribe is a function
                expect(typeof unsubscribe).toBe("function");

                // act - remove listener
                unsubscribe();
            });

            it("should add and remove swap completed listener", async () => {
                // arrange
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        autoStart: false,
                    },
                });

                const manager = swapManagerLightning.getSwapManager()!;
                const listener = vi.fn();

                // act - add listener
                const unsubscribe = await manager.onSwapCompleted(listener);

                // assert
                expect(typeof unsubscribe).toBe("function");

                // act - remove listener using off method
                await manager.offSwapCompleted(listener);
            });

            it("should add and remove swap failed listener", async () => {
                // arrange
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        autoStart: false,
                    },
                });

                const manager = swapManagerLightning.getSwapManager()!;
                const listener = vi.fn();

                // act & assert
                const unsubscribe = await manager.onSwapFailed(listener);
                expect(typeof unsubscribe).toBe("function");
                await manager.offSwapFailed(listener);
            });

            it("should add and remove action executed listener", async () => {
                // arrange
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        autoStart: false,
                    },
                });

                const manager = swapManagerLightning.getSwapManager()!;
                const listener = vi.fn();

                // act & assert
                const unsubscribe = await manager.onActionExecuted(listener);
                expect(typeof unsubscribe).toBe("function");
                await manager.offActionExecuted(listener);
            });

            it("should add and remove WebSocket connected listener", async () => {
                // arrange
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        autoStart: false,
                    },
                });

                const manager = swapManagerLightning.getSwapManager()!;
                const listener = vi.fn();

                // act & assert
                const unsubscribe = await manager.onWebSocketConnected(
                    listener
                );
                expect(typeof unsubscribe).toBe("function");
                await manager.offWebSocketConnected(listener);
            });

            it("should add and remove WebSocket disconnected listener", async () => {
                // arrange
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        autoStart: false,
                    },
                });

                const manager = swapManagerLightning.getSwapManager()!;
                const listener = vi.fn();

                // act & assert
                const unsubscribe = await manager.onWebSocketDisconnected(
                    listener
                );
                expect(typeof unsubscribe).toBe("function");
                await manager.offWebSocketDisconnected(listener);
            });
        });

        describe("SwapManager Per-Swap Subscriptions", () => {
            it("should subscribe to specific swap updates", async () => {
                // arrange
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        autoStart: false,
                    },
                });

                const manager = swapManagerLightning.getSwapManager()!;
                await swapManagerLightning.startSwapManager();
                await manager.addSwap(mockReverseSwap);

                const callback = vi.fn();

                // act
                const unsubscribe = await manager.subscribeToSwapUpdates(
                    mockReverseSwap.id,
                    callback
                );

                // assert
                expect(typeof unsubscribe).toBe("function");

                // cleanup
                unsubscribe();
            });

            it("should unsubscribe from specific swap updates", async () => {
                // arrange
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        autoStart: false,
                    },
                });

                const manager = swapManagerLightning.getSwapManager()!;
                const callback = vi.fn();

                // act
                const unsubscribe = await manager.subscribeToSwapUpdates(
                    mockReverseSwap.id,
                    callback
                );
                unsubscribe();

                // assert - unsubscribe should not throw
                expect(true).toBe(true);
            });
        });

        describe("SwapManager Processing State", () => {
            it("should report not processing when no action is running", async () => {
                // arrange
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        autoStart: false,
                    },
                });

                const manager = swapManagerLightning.getSwapManager()!;
                await swapManagerLightning.startSwapManager();
                await manager.addSwap(mockReverseSwap);

                // act & assert
                expect(
                    await manager.isProcessing(mockReverseSwap.id)
                ).toBe(false);
            });

            it("should report not processing for unknown swap", async () => {
                // arrange
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        autoStart: false,
                    },
                });

                const manager = swapManagerLightning.getSwapManager()!;

                // act & assert
                expect(await manager.isProcessing("unknown-swap-id")).toBe(
                    false
                );
            });
        });

        describe("SwapManager Configuration", () => {
            it("should use default config values", async () => {
                // arrange
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: true,
                });

                const manager = swapManagerLightning.getSwapManager()!;
                const stats = await manager.getStats();

                // assert - check default reconnect delay (1000ms)
                expect(stats.currentReconnectDelay).toBe(1000);
                // Default poll retry delay (5000ms)
                expect(stats.currentPollRetryDelay).toBe(5000);
            });

            it("should use custom reconnect delay", async () => {
                // arrange
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        reconnectDelayMs: 2000,
                    },
                });

                const manager = swapManagerLightning.getSwapManager()!;
                const stats = await manager.getStats();

                // assert
                expect(stats.currentReconnectDelay).toBe(2000);
            });

            it("should use custom poll retry delay", async () => {
                // arrange
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        pollRetryDelayMs: 10000,
                    },
                });

                const manager = swapManagerLightning.getSwapManager()!;
                const stats = await manager.getStats();

                // assert
                expect(stats.currentPollRetryDelay).toBe(10000);
            });

            it("should accept event callbacks in config", () => {
                // arrange
                const onSwapUpdate = vi.fn();
                const onSwapCompleted = vi.fn();
                const onSwapFailed = vi.fn();

                // act
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        events: {
                            onSwapUpdate,
                            onSwapCompleted,
                            onSwapFailed,
                        },
                    },
                });

                // assert - should not throw
                expect(swapManagerLightning.getSwapManager()).not.toBeNull();
            });
        });

        describe("SwapManager with Pending Swaps on Start", () => {
            it("should start with pending swaps from storage", async () => {
                // arrange
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        autoStart: false,
                    },
                });

                // Mock storage to return pending swaps
                vi.spyOn(swapRepository, "getAllSwaps").mockResolvedValueOnce([
                    mockReverseSwap,
                    mockSubmarineSwap,
                ]);

                // act
                await swapManagerLightning.startSwapManager();

                const manager = swapManagerLightning.getSwapManager()!;

                // assert
                expect((await manager.getStats()).monitoredSwaps).toBe(2);
                expect(await manager.hasSwap(mockReverseSwap.id)).toBe(true);
                expect(await manager.hasSwap(mockSubmarineSwap.id)).toBe(true);
            });

            it("should filter out completed swaps on start", async () => {
                // arrange
                swapManagerLightning = new ArkadeLightning({
                    ...params,
                    swapManager: {
                        autoStart: false,
                    },
                });

                const completedSwap: PendingReverseSwap = {
                    ...mockReverseSwap,
                    id: "completed-swap",
                    status: "invoice.settled", // Final status
                };

                const expiredSwap: PendingSubmarineSwap = {
                    ...mockSubmarineSwap,
                    id: "expired-swap",
                    status: "swap.expired", // Final status
                };

                // Mock storage to return mix of pending and completed swaps
                vi.spyOn(swapRepository, "getAllSwaps").mockResolvedValueOnce([
                    mockReverseSwap,
                    completedSwap,
                    mockSubmarineSwap,
                    expiredSwap,
                ]);

                // act
                await swapManagerLightning.startSwapManager();

                const manager = swapManagerLightning.getSwapManager()!;

                // assert - only non-final swaps should be monitored
                expect((await manager.getStats()).monitoredSwaps).toBe(2);
                expect(await manager.hasSwap(mockReverseSwap.id)).toBe(true);
                expect(await manager.hasSwap(mockSubmarineSwap.id)).toBe(true);
                expect(await manager.hasSwap("completed-swap")).toBe(false);
                expect(await manager.hasSwap("expired-swap")).toBe(false);
            });
        });
    });

    describe("SwapManager Standalone", () => {
        let manager: SwapManager;

        beforeEach(() => {
            manager = new SwapManager(swapProvider);
        });

        afterEach(async () => {
            await manager.stop();
        });

        it("should create SwapManager with default config", async () => {
            // assert
            expect(manager).toBeDefined();
            expect((await manager.getStats()).isRunning).toBe(false);
        });

        it("should create SwapManager with custom config", async () => {
            // arrange
            const customManager = new SwapManager(swapProvider, {
                enableAutoActions: false,
                pollInterval: 60000,
                reconnectDelayMs: 2000,
                maxReconnectDelayMs: 120000,
            });

            // assert
            expect(customManager).toBeDefined();
            expect(
                (await customManager.getStats()).currentReconnectDelay
            ).toBe(2000);
        });

        it("should start with empty swap list", async () => {
            // act
            await manager.start([]);

            // assert
            expect((await manager.getStats()).isRunning).toBe(true);
            expect((await manager.getStats()).monitoredSwaps).toBe(0);
        });

        it("should start with pending swaps", async () => {
            // act
            await manager.start([mockReverseSwap, mockSubmarineSwap]);

            // assert
            expect((await manager.getStats()).isRunning).toBe(true);
            expect((await manager.getStats()).monitoredSwaps).toBe(2);
        });

        it("should warn when starting already running manager", async () => {
            // arrange
            const consoleWarnSpy = vi
                .spyOn(console, "warn")
                .mockImplementation(() => {});
            await manager.start([]);

            // act
            await manager.start([]);

            // assert
            expect(consoleWarnSpy).toHaveBeenCalledWith(
                "SwapManager is already running"
            );

            consoleWarnSpy.mockRestore();
        });

        it("should not throw when stopping non-running manager", async () => {
            // act & assert
            await expect(manager.stop()).resolves.toBeUndefined();
        });

        it("should return pending swaps", async () => {
            // arrange
            await manager.start([mockReverseSwap]);

            // act
            const swaps = await manager.getPendingSwaps();

            // assert
            expect(swaps).toHaveLength(1);
            expect(swaps[0]).toEqual(mockReverseSwap);
        });

        it("should check if swap exists", async () => {
            // arrange
            await manager.start([mockReverseSwap]);

            // act & assert
            expect(await manager.hasSwap(mockReverseSwap.id)).toBe(true);
            expect(await manager.hasSwap("non-existent")).toBe(false);
        });

        describe("setCallbacks", () => {
            it("should set callbacks without error", () => {
                // act & assert
                expect(() => {
                    manager.setCallbacks({
                        claim: async () => {},
                        refund: async () => {},
                        saveSwap: async () => {},
                    });
                }).not.toThrow();
            });
        });
    });
});
