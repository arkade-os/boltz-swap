import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ArkadeLightning } from "../src/arkade-lightning";
import {
    BoltzSwapProvider,
    CreateReverseSwapRequest,
    CreateReverseSwapResponse,
    CreateSubmarineSwapRequest,
    CreateSubmarineSwapResponse,
} from "../src/boltz-swap-provider";
import type {
    PendingReverseSwap,
    PendingSubmarineSwap,
    ArkadeLightningConfig,
} from "../src/types";
import {
    RestArkProvider,
    RestIndexerProvider,
    Identity,
    Wallet,
    SingleKey,
} from "@arkade-os/sdk";
import { VHTLC } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { randomBytes } from "crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { decodeInvoice } from "../src/utils/decoding";
import { pubECDSA } from "@scure/btc-signer/utils.js";

// Mock WebSocket - this needs to be at the top level
vi.mock("ws", () => {
    return {
        WebSocket: vi.fn().mockImplementation((url: string) => {
            const mockWs = {
                url,
                onopen: null as ((event: any) => void) | null,
                onmessage: null as ((event: any) => void) | null,
                onerror: null as ((event: any) => void) | null,
                onclose: null as ((event: any) => void) | null,

                send: vi.fn().mockImplementation((data: string) => {
                    const message = JSON.parse(data);
                    // Simulate async WebSocket responses
                    process.nextTick(() => {
                        if (mockWs.onmessage && message.op === "subscribe") {
                            // Simulate swap.created status
                            mockWs.onmessage({
                                data: JSON.stringify({
                                    event: "update",
                                    args: [
                                        {
                                            id: message.args[0],
                                            status: "swap.created",
                                        },
                                    ],
                                }),
                            });

                            // Simulate transaction.confirmed status
                            process.nextTick(() => {
                                if (mockWs.onmessage) {
                                    mockWs.onmessage({
                                        data: JSON.stringify({
                                            event: "update",
                                            args: [
                                                {
                                                    id: message.args[0],
                                                    status: "transaction.confirmed",
                                                },
                                            ],
                                        }),
                                    });
                                }
                            });

                            // Simulate invoice.settled status
                            process.nextTick(() => {
                                if (mockWs.onmessage) {
                                    mockWs.onmessage({
                                        data: JSON.stringify({
                                            event: "update",
                                            args: [
                                                {
                                                    id: message.args[0],
                                                    status: "invoice.settled",
                                                },
                                            ],
                                        }),
                                    });
                                }
                            });
                        }
                    });
                }),

                close: vi.fn().mockImplementation(() => {
                    if (mockWs.onclose) {
                        mockWs.onclose({ type: "close" });
                    }
                }),
            };

            // Simulate connection opening
            process.nextTick(() => {
                if (mockWs.onopen) {
                    mockWs.onopen({ type: "open" });
                }
            });

            return mockWs;
        }),
    };
});

// Scaffolding test file for ArkadeLightning
// This file will be updated when implementing features from README.md

describe("ArkadeLightning", () => {
    let indexerProvider: RestIndexerProvider;
    let swapProvider: BoltzSwapProvider;
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

    beforeEach(async () => {
        vi.clearAllMocks();

        // Basic mocks
        identity = SingleKey.fromPrivateKey(seckeys.alice);
        wallet = await Wallet.create({
            identity,
            arkServerUrl: "http://localhost:7070",
        });
        arkProvider = new RestArkProvider("http://localhost:7070");
        swapProvider = new BoltzSwapProvider({ network: "regtest" });
        indexerProvider = new RestIndexerProvider("http://localhost:7070");
        lightning = new ArkadeLightning({
            wallet,
            arkProvider,
            swapProvider,
            indexerProvider,
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("Initialization", () => {
        it("should be instantiated with wallet and swap provider", () => {
            expect(lightning).toBeInstanceOf(ArkadeLightning);
        });

        it("should fail to instantiate without required config", async () => {
            const params: ArkadeLightningConfig = {
                wallet,
                swapProvider,
                arkProvider,
                indexerProvider,
            };
            expect(
                () =>
                    new ArkadeLightning({
                        ...params,
                        swapProvider: null as any,
                    })
            ).toThrow("Swap provider is required.");
        });

        it("should default to wallet instances without required config", async () => {
            const params: ArkadeLightningConfig = {
                wallet,
                swapProvider,
                arkProvider,
                indexerProvider,
            };
            expect(() => new ArkadeLightning({ ...params })).not.toThrow();
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
            expect(lightning.refundVHTLC).toBeInstanceOf(Function);
            expect(lightning.sendLightningPayment).toBeInstanceOf(Function);
            expect(lightning.waitAndClaim).toBeInstanceOf(Function);
            expect(lightning.waitForSwapSettlement).toBeInstanceOf(Function);
        });
    });

    describe("VHTLC Operations", () => {
        const preimage = randomBytes(20);
        const mockVHTLC = {
            vhtlcAddress: mock.address,
            vhtlcScript: new VHTLC.Script({
                preimageHash: ripemd160(sha256(preimage)),
                sender: mock.pubkeys.alice,
                receiver: mock.pubkeys.boltz,
                server: mock.pubkeys.server,
                refundLocktime: BigInt(17),
                unilateralClaimDelay: {
                    type: "blocks",
                    value: BigInt(21),
                },
                unilateralRefundDelay: {
                    type: "blocks",
                    value: BigInt(42),
                },
                unilateralRefundWithoutReceiverDelay: {
                    type: "blocks",
                    value: BigInt(63),
                },
            }),
        };
        it("should claim a VHTLC", async () => {
            // arrange
            const pendingSwap: PendingReverseSwap = {
                type: "reverse",
                createdAt: Date.now(),
                preimage: hex.encode(preimage),
                request: createReverseSwapRequest,
                response: createReverseSwapResponse,
                status: "swap.created",
            };
            vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce({
                signerPubkey: hex.encode(mock.pubkeys.server),
                network: "regtest",
                vtxoTreeExpiry: 604800n,
                unilateralExitDelay: 604800n,
                roundInterval: 604800n,
                dust: 333n,
                forfeitAddress: "mock-forfeit-address",
                version: "1.0.0",
                boardingExitDelay: 604800n,
                vtxoMaxAmount: 21000000n * 100_000_000n,
                utxoMaxAmount: 21000000n * 100_000_000n,
                vtxoMinAmount: -1n,
                utxoMinAmount: -1n,
                checkpointExitClosure: "",
            });
            vi.spyOn(lightning, "createVHTLCScript").mockReturnValueOnce(
                mockVHTLC
            );
            vi.spyOn(indexerProvider, "getVtxos").mockResolvedValueOnce({
                vtxos: [],
            });
            vi.spyOn(arkProvider, "submitTx").mockResolvedValueOnce({
                arkTxid: "",
                finalArkTx: "",
                signedCheckpointTxs: [],
            });
            vi.spyOn(arkProvider, "finalizeTx").mockResolvedValueOnce();
            await expect(lightning.claimVHTLC(pendingSwap)).rejects.toThrow(
                "Boltz is trying to scam us"
            );
        });
    });

    describe("Create Lightning Invoice", () => {
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
            // arrange
            const pendingSwap: PendingReverseSwap = {
                type: "reverse",
                createdAt: Date.now(),
                preimage: mock.preimage,
                request: createReverseSwapRequest,
                response: createReverseSwapResponse,
                status: "swap.created",
            };
            vi.spyOn(lightning, "createReverseSwap").mockResolvedValueOnce(
                pendingSwap
            );

            // act
            const result = await lightning.createLightningInvoice({
                amount: mock.amount,
            });

            // assert
            expect(result.expiry).toBe(mock.invoice.expiry);
            expect(result.invoice).toBe(mock.invoice.address);
            expect(result.paymentHash).toBe(mock.invoice.paymentHash);
            expect(result.preimage).toBe(mock.preimage);
            expect(result.pendingSwap.request.claimPublicKey).toBe(
                compressedPubkeys.alice
            );
        });

        it("should pass description to reverse swap when creating Lightning invoice", async () => {
            // arrange
            const testDescription = "Test payment description";
            const pendingSwap: PendingReverseSwap = {
                type: "reverse",
                createdAt: Date.now(),
                preimage: mock.preimage,
                request: {
                    ...createReverseSwapRequest,
                    description: testDescription,
                },
                response: createReverseSwapResponse,
                status: "swap.created",
            };
            const createReverseSwapSpy = vi
                .spyOn(lightning, "createReverseSwap")
                .mockResolvedValueOnce(pendingSwap);

            // act
            await lightning.createLightningInvoice({
                amount: mock.amount,
                description: testDescription,
            });

            // assert
            expect(createReverseSwapSpy).toHaveBeenCalledWith({
                amount: mock.amount,
                description: testDescription,
            });
        });
    });

    describe("Reverse Swaps", () => {
        it("should create a reverse swap", async () => {
            // arrange
            vi.spyOn(swapProvider, "createReverseSwap").mockResolvedValueOnce(
                createReverseSwapResponse
            );

            // act
            const pendingSwap = await lightning.createReverseSwap({
                amount: mock.invoice.amount,
            });

            // assert
            expect(pendingSwap.request.invoiceAmount).toBe(mock.invoice.amount);
            expect(pendingSwap.request.preimageHash).toHaveLength(64);
            expect(pendingSwap.response.invoice).toBe(mock.invoice.address);
            expect(pendingSwap.response.lockupAddress).toBe(mock.lockupAddress);
            expect(pendingSwap.response.onchainAmount).toBe(
                mock.invoice.amount
            );
            expect(pendingSwap.response.refundPublicKey).toBe(
                compressedPubkeys.boltz
            );
            expect(pendingSwap.status).toEqual("swap.created");
        });

        it("should get correct swap status", async () => {
            // arrange
            vi.spyOn(swapProvider, "createReverseSwap").mockResolvedValueOnce(
                createReverseSwapResponse
            );
            vi.spyOn(swapProvider, "getSwapStatus").mockResolvedValueOnce({
                status: "swap.created",
            });

            // act
            const pendingSwap = await lightning.createReverseSwap({
                amount: mock.invoice.amount,
            });

            // assert
            expect(lightning.getSwapStatus).toBeInstanceOf(Function);
            const status = await lightning.getSwapStatus(
                pendingSwap.response.id
            );
            expect(status.status).toBe("swap.created");
        });

        it("should pass description to swap provider when creating reverse swap", async () => {
            // arrange
            const testDescription = "Test reverse swap description";
            const createReverseSwapSpy = vi
                .spyOn(swapProvider, "createReverseSwap")
                .mockResolvedValueOnce(createReverseSwapResponse);

            // act
            await lightning.createReverseSwap({
                amount: mock.invoice.amount,
                description: testDescription,
            });

            // assert
            expect(createReverseSwapSpy).toHaveBeenCalledWith({
                invoiceAmount: mock.invoice.amount,
                claimPublicKey: expect.any(String),
                preimageHash: expect.any(String),
                description: testDescription,
            });
        });
    });

    describe("Submarine Swaps", () => {
        it("should create a submarine swap", async () => {
            // arrange
            vi.spyOn(swapProvider, "createSubmarineSwap").mockResolvedValueOnce(
                createSubmarineSwapResponse
            );

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
            // arrange
            vi.spyOn(swapProvider, "createSubmarineSwap").mockResolvedValueOnce(
                createSubmarineSwapResponse
            );
            vi.spyOn(swapProvider, "getSwapStatus").mockResolvedValueOnce({
                status: "swap.created",
            });

            // act
            const pendingSwap = await lightning.createSubmarineSwap({
                invoice: mock.invoice.address,
            });

            // assert
            expect(lightning.getSwapStatus).toBeInstanceOf(Function);
            const status = await lightning.getSwapStatus(
                pendingSwap.response.id
            );
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
            const pendingSwap: PendingSubmarineSwap = {
                type: "submarine",
                createdAt: Date.now(),
                request: createSubmarineSwapRequest,
                response: createSubmarineSwapResponse,
                status: "swap.created",
            };
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

        describe("getPendingReverseSwaps", () => {
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
                        type: "reverse",
                        createdAt: Date.now() - 2000,
                        preimage: "preimage1",
                        request: createReverseSwapRequest,
                        response: { ...createReverseSwapResponse, id: "swap1" },
                        status: "swap.created",
                    },
                    {
                        type: "reverse",
                        createdAt: Date.now() - 1000,
                        preimage: "preimage2",
                        request: createReverseSwapRequest,
                        response: { ...createReverseSwapResponse, id: "swap2" },
                        status: "invoice.settled",
                    },
                    {
                        type: "reverse",
                        createdAt: Date.now(),
                        preimage: "preimage3",
                        request: createReverseSwapRequest,
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
                expect(result[0].response.id).toBe("swap1");
                expect(result[1].response.id).toBe("swap3");
                expect(
                    result.every((swap) => swap.status === "swap.created")
                ).toBe(true);
            });
        });

        describe("getPendingSubmarineSwaps", () => {
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
                        type: "submarine",
                        createdAt: Date.now() - 2000,
                        request: createSubmarineSwapRequest,
                        response: {
                            ...createSubmarineSwapResponse,
                            id: "swap1",
                        },
                        status: "invoice.set",
                    },
                    {
                        type: "submarine",
                        createdAt: Date.now() - 1000,
                        request: createSubmarineSwapRequest,
                        response: {
                            ...createSubmarineSwapResponse,
                            id: "swap2",
                        },
                        status: "swap.created",
                    },
                    {
                        type: "submarine",
                        createdAt: Date.now(),
                        request: createSubmarineSwapRequest,
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
                expect(result[0].response.id).toBe("swap1");
                expect(result[1].response.id).toBe("swap3");
                expect(
                    result.every((swap) => swap.status === "invoice.set")
                ).toBe(true);
            });
        });

        describe("getSwapHistory", () => {
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
                        type: "reverse",
                        createdAt: now - 3000, // oldest
                        preimage: "preimage1",
                        request: createReverseSwapRequest,
                        response: {
                            ...createReverseSwapResponse,
                            id: "reverse1",
                        },
                        status: "swap.created",
                    },
                    {
                        type: "reverse",
                        createdAt: now - 1000, // newest reverse
                        preimage: "preimage2",
                        request: createReverseSwapRequest,
                        response: {
                            ...createReverseSwapResponse,
                            id: "reverse2",
                        },
                        status: "invoice.settled",
                    },
                ];

                const mockSubmarineSwaps: PendingSubmarineSwap[] = [
                    {
                        type: "submarine",
                        createdAt: now - 2000, // middle
                        request: createSubmarineSwapRequest,
                        response: {
                            ...createSubmarineSwapResponse,
                            id: "submarine1",
                        },
                        status: "invoice.set",
                    },
                    {
                        type: "submarine",
                        createdAt: now, // newest overall
                        request: createSubmarineSwapRequest,
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
                expect(result[0].response.id).toBe("submarine2"); // newest
                expect(result[1].response.id).toBe("reverse2");
                expect(result[2].response.id).toBe("submarine1");
                expect(result[3].response.id).toBe("reverse1"); // oldest

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
                        type: "reverse",
                        createdAt: Date.now() - 1000,
                        preimage: "preimage1",
                        request: createReverseSwapRequest,
                        response: {
                            ...createReverseSwapResponse,
                            id: "reverse1",
                        },
                        status: "transaction.confirmed",
                    },
                ];

                const mockSubmarineSwaps: PendingSubmarineSwap[] = [
                    {
                        type: "submarine",
                        createdAt: Date.now(),
                        request: createSubmarineSwapRequest,
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

        describe("swap persistence during operations", () => {
            it("should save reverse swap when creating lightning invoice", async () => {
                // arrange
                vi.spyOn(lightning, "createReverseSwap").mockResolvedValueOnce({
                    type: "reverse",
                    createdAt: Date.now(),
                    preimage: mock.preimage,
                    request: createReverseSwapRequest,
                    response: createReverseSwapResponse,
                    status: "swap.created",
                });

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

    describe("waitAndClaim", () => {
        it("should return valid txid when transaction is available", async () => {
            // arrange
            const pendingSwap: PendingReverseSwap = {
                type: "reverse",
                createdAt: Date.now(),
                preimage: mock.preimage,
                request: createReverseSwapRequest,
                response: createReverseSwapResponse,
                status: "swap.created",
            };

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
            const pendingSwap: PendingReverseSwap = {
                type: "reverse",
                createdAt: Date.now(),
                preimage: mock.preimage,
                request: createReverseSwapRequest,
                response: createReverseSwapResponse,
                status: "swap.created",
            };

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
