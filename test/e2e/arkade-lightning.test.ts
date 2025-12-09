import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ArkadeLightning } from "../../src/arkade-lightning";
import {
    BoltzSwapProvider,
    CreateReverseSwapRequest,
    CreateReverseSwapResponse,
    CreateSubmarineSwapRequest,
    CreateSubmarineSwapResponse,
} from "../../src/boltz-swap-provider";
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
        id: mock.id,
        type: "reverse",
        createdAt: Date.now(),
        preimage: hex.encode(randomBytes(20)),
        request: createReverseSwapRequest,
        response: createReverseSwapResponse,
        status: "swap.created",
    };

    const mockSubmarineSwap: PendingSubmarineSwap = {
        id: mock.id,
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
        };

        // Create ArkadeLightning instance
        lightning = new ArkadeLightning(params);
    });

    afterEach(() => {
        vi.restoreAllMocks();
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

    describe.skip("Reverse Swaps", () => {
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

    describe.skip("Decoding lightning invoices", () => {
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

    describe.skip("Sending Lightning Payments", () => {
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

    describe.skip("Swap Storage and History", () => {
        beforeEach(() => {
            // Mock the contract repository methods
            vi.spyOn(
                wallet.contractRepository,
                "saveToContractCollection"
            ).mockResolvedValue();
            vi.spyOn(
                wallet.contractRepository,
                "getContractCollection"
            ).mockImplementation(async (collectionName) => {
                if (collectionName === "reverseSwaps") {
                    return [];
                }
                if (collectionName === "submarineSwaps") {
                    return [];
                }
                return [];
            });
        });

        describe.skip("getPendingReverseSwaps", () => {
            it("should return empty array when no reverse swaps exist", async () => {
                // act
                const result = await lightning.getPendingReverseSwaps();

                // assert
                expect(result).toEqual([]);
                expect(
                    wallet.contractRepository.getContractCollection
                ).toHaveBeenCalledWith("reverseSwaps");
            });

            it("should return only reverse swaps with swap.created status", async () => {
                // arrange
                const mockReverseSwaps: PendingReverseSwap[] = [
                    {
                        ...mockReverseSwap,
                        createdAt: Date.now() - 2000,
                        preimage: "preimage1",
                        response: { ...createReverseSwapResponse, id: "swap1" },
                        status: "swap.created",
                    },
                    {
                        ...mockReverseSwap,
                        createdAt: Date.now() - 1000,
                        preimage: "preimage2",
                        response: { ...createReverseSwapResponse, id: "swap2" },
                        status: "invoice.settled",
                    },
                    {
                        ...mockReverseSwap,
                        preimage: "preimage3",
                        response: { ...createReverseSwapResponse, id: "swap3" },
                        status: "swap.created",
                    },
                ];

                vi.spyOn(
                    wallet.contractRepository,
                    "getContractCollection"
                ).mockImplementation(async (collectionName) => {
                    if (collectionName === "reverseSwaps") {
                        return mockReverseSwaps;
                    }
                    return [];
                });

                // act
                const result = await lightning.getPendingReverseSwaps();

                // assert
                expect(result).toHaveLength(2);
                expect(result[0].id).toBe("swap1");
                expect(result[1].id).toBe("swap3");
                expect(
                    result.every((swap) => swap.status === "swap.created")
                ).toBe(true);
            });
        });

        describe.skip("getPendingSubmarineSwaps", () => {
            it("should return empty array when no submarine swaps exist", async () => {
                // act
                const result = await lightning.getPendingSubmarineSwaps();

                // assert
                expect(result).toEqual([]);
                expect(
                    wallet.contractRepository.getContractCollection
                ).toHaveBeenCalledWith("submarineSwaps");
            });

            it("should return only submarine swaps with invoice.set status", async () => {
                // arrange
                const mockSubmarineSwaps: PendingSubmarineSwap[] = [
                    {
                        ...mockSubmarineSwap,
                        createdAt: Date.now() - 2000,
                        response: {
                            ...createSubmarineSwapResponse,
                            id: "swap1",
                        },
                        status: "invoice.set",
                    },
                    {
                        ...mockSubmarineSwap,
                        createdAt: Date.now() - 1000,
                        response: {
                            ...createSubmarineSwapResponse,
                            id: "swap2",
                        },
                        status: "swap.created",
                    },
                    {
                        ...mockSubmarineSwap,
                        response: {
                            ...createSubmarineSwapResponse,
                            id: "swap3",
                        },
                        status: "invoice.set",
                    },
                ];

                vi.spyOn(
                    wallet.contractRepository,
                    "getContractCollection"
                ).mockImplementation(async (collectionName) => {
                    if (collectionName === "submarineSwaps") {
                        return mockSubmarineSwaps;
                    }
                    return [];
                });

                // act
                const result = await lightning.getPendingSubmarineSwaps();

                // assert
                expect(result).toHaveLength(2);
                expect(result[0].id).toBe("swap1");
                expect(result[1].id).toBe("swap3");
                expect(
                    result.every((swap) => swap.status === "invoice.set")
                ).toBe(true);
            });
        });

        describe.skip("getSwapHistory", () => {
            it("should return empty array when no swaps exist", async () => {
                // act
                const result = await lightning.getSwapHistory();

                // assert
                expect(result).toEqual([]);
                expect(
                    wallet.contractRepository.getContractCollection
                ).toHaveBeenCalledWith("reverseSwaps");
                expect(
                    wallet.contractRepository.getContractCollection
                ).toHaveBeenCalledWith("submarineSwaps");
            });

            it("should return all swaps sorted by creation date (newest first)", async () => {
                // arrange
                const now = Date.now();
                const mockReverseSwaps: PendingReverseSwap[] = [
                    {
                        ...mockReverseSwap,
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
                        createdAt: now - 2000, // middle
                        response: {
                            ...createSubmarineSwapResponse,
                            id: "submarine1",
                        },
                        status: "invoice.set",
                    },
                    {
                        ...mockSubmarineSwap,
                        createdAt: now, // newest overall
                        response: {
                            ...createSubmarineSwapResponse,
                            id: "submarine2",
                        },
                        status: "swap.created",
                    },
                ];

                vi.spyOn(
                    wallet.contractRepository,
                    "getContractCollection"
                ).mockImplementation(async (collectionName) => {
                    if (collectionName === "reverseSwaps") {
                        return mockReverseSwaps;
                    }
                    if (collectionName === "submarineSwaps") {
                        return mockSubmarineSwaps;
                    }
                    return [];
                });

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

                vi.spyOn(
                    wallet.contractRepository,
                    "getContractCollection"
                ).mockImplementation(async (collectionName) => {
                    if (collectionName === "reverseSwaps") {
                        return mockReverseSwaps;
                    }
                    if (collectionName === "submarineSwaps") {
                        return mockSubmarineSwaps;
                    }
                    return [];
                });

                // act
                const result = await lightning.getSwapHistory();

                // assert
                expect(result).toHaveLength(2);
                expect(result[0].type).toBe("submarine");
                expect(result[1].type).toBe("reverse");
            });
        });

        describe.skip("swap persistence during operations", () => {
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
                expect(
                    wallet.contractRepository.saveToContractCollection
                ).toHaveBeenCalledWith(
                    "submarineSwaps",
                    expect.objectContaining({
                        type: "submarine",
                        status: "invoice.set",
                        request: expect.objectContaining({
                            invoice: mock.invoice.address,
                        }),
                        response: createSubmarineSwapResponse,
                    }),
                    "type"
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
                expect(
                    wallet.contractRepository.saveToContractCollection
                ).toHaveBeenCalledWith(
                    "reverseSwaps",
                    expect.objectContaining({
                        type: "reverse",
                        status: "swap.created",
                        request: expect.objectContaining({
                            invoiceAmount: mock.invoice.amount,
                        }),
                        response: createReverseSwapResponse,
                    }),
                    "type"
                );
                expect(result.type).toBe("reverse");
                expect(result.status).toBe("swap.created");
            });
        });
    });

    describe.skip("waitAndClaim", () => {
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
                timeoutBlockHeight: 123,
            });

            // Mock monitorSwap to directly trigger the invoice.settled case
            vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                async (swapId, update) => {
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
                timeoutBlockHeight: 123,
            });

            // Mock monitorSwap to directly trigger the invoice.settled case
            vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                async (swapId, update) => {
                    setTimeout(() => update("invoice.settled"), 10);
                }
            );

            // act & assert
            await expect(lightning.waitAndClaim(pendingSwap)).rejects.toThrow(
                "Transaction ID not available for settled swap"
            );
        });
    });
});
