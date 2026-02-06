import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ArkadeChainSwap } from "../src/arkade-chainswap";
import {
    BoltzSwapProvider,
    CreateChainSwapRequest,
    CreateChainSwapResponse,
} from "../src/boltz-swap-provider";
import type {
    PendingChainSwap,
    ArkadeLightningConfig,
    ChainFeesResponse,
    LimitsResponse,
    ArkadeChainSwapConfig,
} from "../src/types";
import {
    RestArkProvider,
    RestIndexerProvider,
    Identity,
    Wallet,
    SingleKey,
    ArkInfo,
} from "@arkade-os/sdk";
import { VHTLC } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { randomBytes } from "crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { pubECDSA } from "@scure/btc-signer/utils.js";

// Mock the @arkade-os/sdk modules
vi.mock("@arkade-os/sdk", async () => {
    const actual = await vi.importActual("@arkade-os/sdk");
    return {
        ...actual,
        Wallet: {
            create: vi.fn(),
        },
        RestArkProvider: vi.fn(),
        RestIndexerProvider: vi.fn(),
    };
});

// Mock WebSocket
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

                            // Simulate transaction.server.mempool status
                            process.nextTick(() => {
                                if (mockWs.onmessage) {
                                    mockWs.onmessage({
                                        data: JSON.stringify({
                                            event: "update",
                                            args: [
                                                {
                                                    id: message.args[0],
                                                    status: "transaction.server.mempool",
                                                },
                                            ],
                                        }),
                                    });
                                }
                            });

                            // Simulate transaction.claimed status
                            process.nextTick(() => {
                                if (mockWs.onmessage) {
                                    mockWs.onmessage({
                                        data: JSON.stringify({
                                            event: "update",
                                            args: [
                                                {
                                                    id: message.args[0],
                                                    status: "transaction.claimed",
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

describe("ArkadeChainSwap", () => {
    let indexerProvider: RestIndexerProvider;
    let swapProvider: BoltzSwapProvider;
    let arkProvider: RestArkProvider;
    let chainSwap: ArkadeChainSwap;
    let identity: Identity;
    let wallet: Wallet;

    const seckeys = {
        alice: schnorr.utils.randomSecretKey(),
        boltz: schnorr.utils.randomSecretKey(),
        server: schnorr.utils.randomSecretKey(),
        fulmine: schnorr.utils.randomSecretKey(),
        ephemeral: schnorr.utils.randomSecretKey(),
    };

    const compressedPubkeys = {
        alice: hex.encode(pubECDSA(seckeys.alice, true)),
        boltz: hex.encode(pubECDSA(seckeys.boltz, true)),
        server: hex.encode(pubECDSA(seckeys.server, true)),
        fulmine: hex.encode(pubECDSA(seckeys.fulmine, true)),
        ephemeral: hex.encode(pubECDSA(seckeys.ephemeral, true)),
    };

    const mockPreimage = randomBytes(32);
    const mockPreimageHash = sha256(mockPreimage);

    const mock = {
        address: {
            ark: "tark1qr340xg400jtxat9hdd0ungyu6s05zjtdf85uj9smyzxshf98ndak8ytjppry3wwkavtm5lu2clrlr6rwq32ryqamwnzy5xncrjz4s62mw5yyx",
            btc: "bcrt1pqh9z96ct2zr95zs8a8ezfugu9dl08u3g2420aap2ngsg0f4s3z7s77hh3q",
        },
        amount: 50000,
        hex: "mock-hex",
        id: "mock-id",
        pubkeys: {
            alice: schnorr.getPublicKey(seckeys.alice),
            boltz: schnorr.getPublicKey(seckeys.boltz),
            server: schnorr.getPublicKey(seckeys.server),
            fulmine: schnorr.getPublicKey(seckeys.fulmine),
            ephemeral: schnorr.getPublicKey(seckeys.ephemeral),
        },
        txid: hex.encode(randomBytes(32)),
    };

    const createArkBtcChainSwapRequest: CreateChainSwapRequest = {
        to: "BTC",
        from: "ARK",
        feeSatsPerByte: 1,
        userLockAmount: mock.amount,
        claimPublicKey: compressedPubkeys.ephemeral,
        refundPublicKey: compressedPubkeys.alice,
        preimageHash: hex.encode(mockPreimageHash),
    };

    const createBtcArkChainSwapRequest: CreateChainSwapRequest = {
        to: "ARK",
        from: "BTC",
        feeSatsPerByte: 1,
        userLockAmount: mock.amount,
        claimPublicKey: compressedPubkeys.alice,
        refundPublicKey: compressedPubkeys.ephemeral,
        preimageHash: hex.encode(mockPreimageHash),
    };

    const createArkBtcChainSwapResponse: CreateChainSwapResponse = {
        id: mock.id,
        claimDetails: {
            lockupAddress: mock.address.btc,
            amount: mock.amount,
            serverPublicKey: compressedPubkeys.boltz,
            swapTree: {
                claimLeaf: {
                    version: 0,
                    output: "",
                },
                refundLeaf: {
                    version: 0,
                    output: "",
                },
            },
            timeoutBlockHeight: 21,
        },
        lockupDetails: {
            serverPublicKey: compressedPubkeys.fulmine,
            lockupAddress: mock.address.ark,
            amount: mock.amount,
            timeoutBlockHeight: 21,
            timeouts: {
                refund: 17,
                unilateralClaim: 21,
                unilateralRefund: 42,
                unilateralRefundWithoutReceiver: 63,
            },
        },
    };

    const createBtcArkChainSwapResponse: CreateChainSwapResponse = {
        id: mock.id,
        claimDetails: {
            serverPublicKey: compressedPubkeys.fulmine,
            lockupAddress: mock.address.ark,
            amount: mock.amount,
            timeoutBlockHeight: 21,
            timeouts: {
                refund: 17,
                unilateralClaim: 21,
                unilateralRefund: 42,
                unilateralRefundWithoutReceiver: 63,
            },
        },
        lockupDetails: {
            lockupAddress: mock.address.btc,
            amount: mock.amount,
            serverPublicKey: compressedPubkeys.boltz,
            swapTree: {
                claimLeaf: {
                    version: 0,
                    output: "",
                },
                refundLeaf: {
                    version: 0,
                    output: "",
                },
            },
            timeoutBlockHeight: 21,
        },
    };

    const mockArkBtcChainSwap: PendingChainSwap = {
        id: mock.id,
        type: "chain",
        feeSatsPerByte: 1,
        preimage: hex.encode(randomBytes(32)),
        request: createArkBtcChainSwapRequest,
        response: createArkBtcChainSwapResponse,
        createdAt: Math.floor(Date.now() / 1000),
        ephemeralKey: hex.encode(randomBytes(32)),
        toAddress: mock.address.btc,
        status: "swap.created",
    };

    const mockBtcArkChainSwap: PendingChainSwap = {
        id: mock.id,
        type: "chain",
        feeSatsPerByte: 1,
        preimage: hex.encode(randomBytes(32)),
        request: createBtcArkChainSwapRequest,
        response: createBtcArkChainSwapResponse,
        createdAt: Math.floor(Date.now() / 1000),
        ephemeralKey: hex.encode(randomBytes(32)),
        toAddress: mock.address.ark,
        status: "swap.created",
    };

    const mockFeeInfo = {
        txFeeRate: "",
        intentFee: {
            offchainInput: "",
            offchainOutput: "",
            onchainInput: "",
            onchainOutput: "",
        },
    };

    const mockArkInfo: ArkInfo = {
        boardingExitDelay: 604800n,
        checkpointTapscript: "",
        deprecatedSigners: [],
        digest: "",
        dust: 333n,
        fees: mockFeeInfo,
        forfeitAddress: "mock-forfeit-address",
        forfeitPubkey: "mock-forfeit-pubkey",
        network: "regtest",
        scheduledSession: {
            duration: BigInt(0),
            fees: mockFeeInfo,
            nextEndTime: BigInt(0),
            nextStartTime: BigInt(0),
            period: BigInt(0),
        },
        serviceStatus: {},
        sessionDuration: 604800n,
        signerPubkey: hex.encode(mock.pubkeys.server),
        unilateralExitDelay: 604800n,
        version: "1.0.0",
        vtxoMaxAmount: 21000000n * 100_000_000n,
        utxoMaxAmount: 21000000n * 100_000_000n,
        vtxoMinAmount: -1n,
        utxoMinAmount: -1n,
    };

    const mockArkBtcVHTLC = {
        vhtlcScript: new VHTLC.Script({
            preimageHash: ripemd160(sha256(randomBytes(32))),
            sender: mock.pubkeys.alice,
            receiver: mock.pubkeys.boltz,
            server: mock.pubkeys.server,
            refundLocktime: BigInt(21000),
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
        vhtlcAddress: mock.address.ark,
    };

    const mockBtcArkVHTLC = {
        vhtlcScript: new VHTLC.Script({
            preimageHash: ripemd160(sha256(randomBytes(32))),
            receiver: mock.pubkeys.alice,
            sender: mock.pubkeys.boltz,
            server: mock.pubkeys.server,
            refundLocktime: BigInt(21000),
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
        vhtlcAddress: mock.address.ark,
    };

    const mockGetChainQuoteResponse = {
        amount: mock.amount,
    };

    beforeEach(async () => {
        vi.clearAllMocks();

        // Create mock instances
        identity = SingleKey.fromPrivateKey(seckeys.alice);

        // Create mock providers first
        arkProvider = {
            getInfo: vi.fn(),
            submitTx: vi.fn(),
            finalizeTx: vi.fn(),
        } as any;

        indexerProvider = {
            getVtxos: vi.fn(),
        } as any;

        // Mock wallet with necessary methods and providers
        wallet = {
            identity,
            arkProvider,
            indexerProvider,
            contractRepository: {
                saveToContractCollection: vi.fn(),
                getContractCollection: vi.fn(),
            },
            sendBitcoin: vi.fn(),
            getAddress: vi.fn().mockResolvedValue("mock-address"),
        } as any;

        // Mock the Wallet.create method
        vi.mocked(Wallet.create).mockResolvedValue(wallet);

        swapProvider = new BoltzSwapProvider({ network: "regtest" });

        chainSwap = new ArkadeChainSwap({
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
            expect(chainSwap).toBeInstanceOf(ArkadeChainSwap);
        });

        it("should fail to instantiate without required config", async () => {
            const params: ArkadeChainSwapConfig = {
                wallet,
                swapProvider,
                arkProvider,
                indexerProvider,
            };
            expect(
                () =>
                    new ArkadeChainSwap({
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
            expect(() => new ArkadeChainSwap({ ...params })).not.toThrow();
            expect(
                () =>
                    new ArkadeChainSwap({ ...params, arkProvider: null as any })
            ).not.toThrow();
            expect(
                () =>
                    new ArkadeChainSwap({
                        ...params,
                        indexerProvider: null as any,
                    })
            ).not.toThrow();
        });

        it("should have expected interface methods", () => {
            expect(chainSwap.arkToBtc).toBeInstanceOf(Function);
            expect(chainSwap.btcToArk).toBeInstanceOf(Function);
            expect(chainSwap.createChainSwap).toBeInstanceOf(Function);
            expect(chainSwap.verifyChainSwap).toBeInstanceOf(Function);
            expect(chainSwap.waitAndClaimArk).toBeInstanceOf(Function);
            expect(chainSwap.waitAndClaimBtc).toBeInstanceOf(Function);
            expect(chainSwap.claimBtc).toBeInstanceOf(Function);
            expect(chainSwap.claimArk).toBeInstanceOf(Function);
            expect(chainSwap.createVHTLCScript).toBeInstanceOf(Function);
            expect(chainSwap.getFees).toBeInstanceOf(Function);
            expect(chainSwap.getLimits).toBeInstanceOf(Function);
            expect(chainSwap.getSwapStatus).toBeInstanceOf(Function);
            expect(chainSwap.getPendingChainSwaps).toBeInstanceOf(Function);
            expect(chainSwap.getSwapHistory).toBeInstanceOf(Function);
            expect(chainSwap.refreshSwapsStatus).toBeInstanceOf(Function);
        });
    });

    describe("Ark to Btc", () => {
        describe("arkToBtc", () => {
            it("should throw if amount is not > 0", async () => {
                // act & assert
                await expect(
                    chainSwap.arkToBtc({
                        toAddress: mock.address.btc,
                        amountSats: 0,
                    })
                ).rejects.toThrow("Invalid amount in arkToBtc");
                await expect(
                    chainSwap.arkToBtc({
                        toAddress: mock.address.btc,
                        amountSats: -1,
                    })
                ).rejects.toThrow("Invalid amount in arkToBtc");
            });

            it("should throw if toAddress is empty", async () => {
                // act & assert
                await expect(
                    chainSwap.arkToBtc({
                        toAddress: "",
                        amountSats: mock.amount,
                    })
                ).rejects.toThrow("Invalid Btc address in arkToBtc");
            });
        });

        describe("claimBtc", () => {
            it("should throw error when toAddress is missing", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockArkBtcChainSwap,
                    toAddress: undefined,
                };

                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );

                // act & assert
                await expect(
                    chainSwap.claimBtc(pendingSwap, {
                        transaction: { id: "some-id", hex: "" },
                    })
                ).rejects.toThrow("Destination address is required");
            });

            it("should throw error when swap tree in claim details is missing", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockArkBtcChainSwap,
                    response: {
                        ...mockArkBtcChainSwap.response,
                        claimDetails: {
                            ...mockArkBtcChainSwap.response.claimDetails,
                            swapTree: undefined,
                        },
                    },
                };

                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );

                // act & assert
                await expect(
                    chainSwap.claimBtc(pendingSwap, {
                        transaction: { id: "some-id", hex: "" },
                    })
                ).rejects.toThrow("Missing swap tree in claim details");
            });

            it("should throw error when server public key in claim details is missing", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockArkBtcChainSwap,
                    response: {
                        ...mockArkBtcChainSwap.response,
                        claimDetails: {
                            ...mockArkBtcChainSwap.response.claimDetails,
                            serverPublicKey: "",
                        },
                    },
                };

                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );

                // act & assert
                await expect(
                    chainSwap.claimBtc(pendingSwap, {
                        transaction: { id: "some-id", hex: "" },
                    })
                ).rejects.toThrow("Missing server public key in claim details");
            });
        });

        describe("createChainSwap", () => {
            it("should create a chain swap from Ark to Btc", async () => {
                // arrange
                vi.spyOn(swapProvider, "createChainSwap").mockResolvedValueOnce(
                    createArkBtcChainSwapResponse
                );

                // act
                const pendingSwap = await chainSwap.createChainSwap({
                    to: "BTC",
                    from: "ARK",
                    feeSatsPerByte: 1,
                    userLockAmount: mock.amount,
                    toAddress: mock.address.btc,
                });

                // assert
                expect(pendingSwap.request.from).toBe("ARK");
                expect(pendingSwap.request.to).toBe("BTC");
                expect(pendingSwap.request.userLockAmount).toBe(mock.amount);
                expect(pendingSwap.request.preimageHash).toHaveLength(64);
                expect(pendingSwap.response.id).toBe(mock.id);
                expect(pendingSwap.response.lockupDetails.lockupAddress).toBe(
                    mock.address.ark
                );
                expect(pendingSwap.status).toEqual("swap.created");
                expect(pendingSwap.toAddress).toBe(mock.address.btc);
            });
        });

        describe("createVHTLCScript", () => {
            it("should create a VHTLC script", () => {
                // act
                const { vhtlcScript, vhtlcAddress } =
                    chainSwap.createVHTLCScript({
                        network: "regtest",
                        preimageHash: mockPreimageHash,
                        receiverPubkey: compressedPubkeys.boltz,
                        senderPubkey: compressedPubkeys.alice,
                        serverPubkey: hex.encode(mock.pubkeys.server),
                        timeoutBlockHeights: {
                            refund: 17,
                            unilateralClaim: 21,
                            unilateralRefund: 42,
                            unilateralRefundWithoutReceiver: 63,
                        },
                    });

                // assert
                expect(vhtlcScript).toBeDefined();
                expect(vhtlcScript.pkScript).toBeDefined();
                expect(vhtlcAddress).toBeDefined();
                expect(vhtlcAddress).toContain("tark");
            });
        });

        describe("getFees", () => {
            it("should get fees for a Ark to Btc chain swap", async () => {
                // arrange
                const mockFees: ChainFeesResponse = {
                    minerFees: {
                        server: 50,
                        user: {
                            claim: 21,
                            lockup: 30,
                        },
                    },
                    percentage: 0.5,
                };
                vi.spyOn(swapProvider, "getChainFees").mockResolvedValueOnce(
                    mockFees
                );

                // act
                const fees = await chainSwap.getFees("ARK", "BTC");

                // assert
                expect(fees).toEqual(mockFees);
                expect(swapProvider.getChainFees).toHaveBeenCalledWith(
                    "ARK",
                    "BTC"
                );
            });
        });

        describe("getLimits", () => {
            it("should get limits for a Ark to Btc chain swap", async () => {
                // arrange
                const mockLimits: LimitsResponse = {
                    min: 10000,
                    max: 1000000,
                };
                vi.spyOn(swapProvider, "getChainLimits").mockResolvedValueOnce(
                    mockLimits
                );

                // act
                const limits = await chainSwap.getLimits("ARK", "BTC");

                // assert
                expect(limits).toEqual(mockLimits);
                expect(swapProvider.getChainLimits).toHaveBeenCalledWith(
                    "ARK",
                    "BTC"
                );
            });
        });

        describe("getSwapStatus", () => {
            it("should get correct swap status", async () => {
                // arrange
                vi.spyOn(swapProvider, "getSwapStatus").mockResolvedValueOnce({
                    status: "swap.created",
                });

                // act
                const status = await chainSwap.getSwapStatus(mock.id);

                // assert
                expect(status.status).toBe("swap.created");
            });
        });

        describe("quoteSwap", () => {
            it("should quote a chain swap", async () => {
                // arrange
                vi.spyOn(swapProvider, "getChainQuote").mockResolvedValueOnce({
                    amount: mock.amount,
                });
                vi.spyOn(swapProvider, "postChainQuote").mockResolvedValueOnce(
                    {}
                );

                // act
                const amount = await chainSwap.quoteSwap(mock.id);

                // assert
                expect(amount).toEqual(mock.amount);
            });
        });

        describe("verifyChainSwap", () => {
            it("should verify a chain swap successfully", async () => {
                // arrange
                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );
                vi.spyOn(chainSwap, "createVHTLCScript").mockReturnValueOnce({
                    vhtlcScript: {} as any,
                    vhtlcAddress: mock.address.ark,
                });

                const pendingSwap: PendingChainSwap = {
                    ...mockArkBtcChainSwap,
                    response: createArkBtcChainSwapResponse,
                };

                // act & assert
                await expect(
                    chainSwap.verifyChainSwap({
                        to: "BTC",
                        from: "ARK",
                        swap: pendingSwap,
                        arkInfo: mockArkInfo,
                    })
                ).resolves.toBe(true);
            });

            it("should throw error if lockup address doesn't match", async () => {
                // arrange
                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );
                vi.spyOn(chainSwap, "createVHTLCScript").mockReturnValueOnce({
                    vhtlcScript: {} as any,
                    vhtlcAddress: "different-address",
                });

                const pendingSwap: PendingChainSwap = {
                    ...mockArkBtcChainSwap,
                    response: createArkBtcChainSwapResponse,
                };

                // act & assert
                await expect(
                    chainSwap.verifyChainSwap({
                        to: "BTC",
                        from: "ARK",
                        swap: pendingSwap,
                        arkInfo: mockArkInfo,
                    })
                ).rejects.toThrow(
                    "Boltz is trying to scam us (invalid address)"
                );
            });
        });

        describe("waitAndClaimBtc", () => {
            it("should resolve with txid when transaction is claimed", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockArkBtcChainSwap,
                };
                vi.spyOn(chainSwap, "claimBtc").mockResolvedValue();
                vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                    async (_id, callback) => {
                        // Simulate status updates
                        setTimeout(
                            () => callback("transaction.server.mempool", {}),
                            10
                        );
                        setTimeout(
                            () => callback("transaction.claimed", {}),
                            20
                        );
                    }
                );

                // act
                const resultPromise = chainSwap.waitAndClaimBtc(pendingSwap);

                // assert
                await expect(resultPromise).resolves.toEqual({
                    txid: mock.id,
                });
            });

            it("should reject with SwapExpiredError when swap expires", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockArkBtcChainSwap,
                };
                vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                    async (_id, callback) => {
                        // Simulate swap expiration
                        setTimeout(() => callback("swap.expired", {}), 10);
                    }
                );

                // act
                const resultPromise = chainSwap.waitAndClaimBtc(pendingSwap);

                // assert
                await expect(resultPromise).rejects.toThrow(
                    "The swap has expired"
                );
            });

            it("should reject with TransactionFailedError when transaction fails", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockArkBtcChainSwap,
                };
                vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                    async (_id, callback) => {
                        // Simulate transaction failure
                        setTimeout(
                            () => callback("transaction.failed", {}),
                            10
                        );
                    }
                );

                // act
                const resultPromise = chainSwap.waitAndClaimBtc(pendingSwap);

                // assert
                await expect(resultPromise).rejects.toThrow(
                    "Error during swap."
                );
            });

            it("should reject with TransactionRefundedError when transaction is refunded", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockArkBtcChainSwap,
                };
                vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                    async (_id, callback) => {
                        // Simulate transaction refund
                        setTimeout(
                            () => callback("transaction.refunded", {}),
                            10
                        );
                    }
                );

                // act
                const resultPromise = chainSwap.waitAndClaimBtc(pendingSwap);

                // assert
                await expect(resultPromise).rejects.toThrow(
                    "The transaction has been refunded."
                );
            });
        });
    });

    describe("Btc to Ark", () => {
        describe("btcToArk", () => {
            const toAddress = mock.address.ark;
            it("should throw on invalid Ark address", async () => {
                // act & assert
                await expect(
                    chainSwap.btcToArk({
                        amountSats: 0,
                        toAddress: "",
                        onAddressGenerated: vi.fn(),
                    })
                ).rejects.toThrow("Invalid Ark address in btcToArk");
            });

            it("should throw if amount is 0", async () => {
                // act & assert
                await expect(
                    chainSwap.btcToArk({
                        amountSats: 0,
                        toAddress: toAddress,
                        onAddressGenerated: vi.fn(),
                    })
                ).rejects.toThrow("Invalid amount in btcToArk");
            });

            it("should throw if amount is < 0", async () => {
                // act & assert
                await expect(
                    chainSwap.btcToArk({
                        amountSats: -1,
                        toAddress: toAddress,
                        onAddressGenerated: vi.fn(),
                    })
                ).rejects.toThrow("Invalid amount in btcToArk");
            });

            it("should call onAddressGenerated with lockup address", async () => {
                // arrange
                const onAddressGenerated = vi.fn();
                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );
                vi.spyOn(swapProvider, "createChainSwap").mockResolvedValueOnce(
                    createBtcArkChainSwapResponse
                );
                vi.spyOn(chainSwap, "verifyChainSwap").mockResolvedValueOnce(
                    true
                );
                vi.spyOn(chainSwap, "waitAndClaimArk").mockResolvedValueOnce({
                    txid: mock.txid,
                });
                vi.spyOn(chainSwap, "getSwapStatus").mockResolvedValueOnce({
                    status: "transaction.claimed",
                });

                // act
                await chainSwap.btcToArk({
                    toAddress: mock.address.ark,
                    amountSats: mock.amount,
                    onAddressGenerated,
                });

                // assert
                expect(onAddressGenerated).toHaveBeenCalledWith(
                    mock.address.btc,
                    mock.amount
                );
            });
        });

        describe("claimArk", () => {
            it("should throw error when toAddress is missing", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockBtcArkChainSwap,
                    toAddress: undefined,
                };

                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );

                // act & assert
                await expect(chainSwap.claimArk(pendingSwap)).rejects.toThrow(
                    "Destination address is required"
                );
            });

            it("should throw error when timeouts in claim details is missing", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockBtcArkChainSwap,
                    response: {
                        ...mockBtcArkChainSwap.response,
                        claimDetails: {
                            ...mockBtcArkChainSwap.response.claimDetails,
                            timeouts: undefined,
                        },
                    },
                };

                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );

                // act & assert
                await expect(chainSwap.claimArk(pendingSwap)).rejects.toThrow(
                    "Missing timeouts in claim details"
                );
            });

            it("should throw error when server public key in claim details is missing", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockBtcArkChainSwap,
                    response: {
                        ...mockBtcArkChainSwap.response,
                        claimDetails: {
                            ...mockBtcArkChainSwap.response.claimDetails,
                            serverPublicKey: "",
                        },
                    },
                };

                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );

                // act & assert
                await expect(chainSwap.claimArk(pendingSwap)).rejects.toThrow(
                    "Missing server public key in claim details"
                );
            });

            it("should throw error when no spendable VTXOs found", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockBtcArkChainSwap,
                    preimage: hex.encode(mockPreimage),
                };
                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );
                vi.spyOn(chainSwap, "createVHTLCScript").mockReturnValueOnce(
                    mockBtcArkVHTLC
                );
                vi.spyOn(indexerProvider, "getVtxos").mockResolvedValueOnce({
                    vtxos: [],
                });

                // act & assert
                await expect(chainSwap.claimArk(pendingSwap)).rejects.toThrow(
                    "No spendable virtual coins found"
                );
            });
        });

        describe("createChainSwap", () => {
            it("should create a chain swap from Btc to Ark", async () => {
                // arrange
                const btcToArkResponse = {
                    ...createBtcArkChainSwapResponse,
                    lockupDetails: {
                        ...createBtcArkChainSwapResponse.lockupDetails,
                        lockupAddress: "bc1q-mock-btc-address",
                    },
                };
                vi.spyOn(swapProvider, "createChainSwap").mockResolvedValueOnce(
                    btcToArkResponse
                );

                // act
                const pendingSwap = await chainSwap.createChainSwap({
                    to: "ARK",
                    from: "BTC",
                    feeSatsPerByte: 1,
                    userLockAmount: mock.amount,
                });

                // assert
                expect(pendingSwap.request.to).toBe("ARK");
                expect(pendingSwap.request.from).toBe("BTC");
                expect(pendingSwap.request.userLockAmount).toBe(mock.amount);
                expect(pendingSwap.response.lockupDetails.lockupAddress).toBe(
                    "bc1q-mock-btc-address"
                );
            });
        });

        describe("createVHTLCScript", () => {
            it("should create a VHTLC script", () => {
                // act
                const { vhtlcScript, vhtlcAddress } =
                    chainSwap.createVHTLCScript({
                        network: "regtest",
                        preimageHash: mockPreimageHash,
                        receiverPubkey: compressedPubkeys.alice,
                        senderPubkey: compressedPubkeys.boltz,
                        serverPubkey: hex.encode(mock.pubkeys.server),
                        timeoutBlockHeights: {
                            refund: 17,
                            unilateralClaim: 21,
                            unilateralRefund: 42,
                            unilateralRefundWithoutReceiver: 63,
                        },
                    });

                // assert
                expect(vhtlcScript).toBeDefined();
                expect(vhtlcScript.pkScript).toBeDefined();
                expect(vhtlcAddress).toBeDefined();
                expect(vhtlcAddress).toContain("tark");
            });
        });

        describe("getFees", () => {
            it("should get fees for a Btc to Ark chain swap", async () => {
                // arrange
                const mockFees: ChainFeesResponse = {
                    minerFees: {
                        server: 50,
                        user: {
                            claim: 21,
                            lockup: 30,
                        },
                    },
                    percentage: 0.5,
                };
                vi.spyOn(swapProvider, "getChainFees").mockResolvedValueOnce(
                    mockFees
                );

                // act
                const fees = await chainSwap.getFees("BTC", "ARK");

                // assert
                expect(fees).toEqual(mockFees);
                expect(swapProvider.getChainFees).toHaveBeenCalledWith(
                    "BTC",
                    "ARK"
                );
            });
        });

        describe("getLimits", () => {
            it("should get limits for a Btc to Ark chain swap", async () => {
                // arrange
                const mockLimits: LimitsResponse = {
                    min: 10000,
                    max: 1000000,
                };
                vi.spyOn(swapProvider, "getChainLimits").mockResolvedValueOnce(
                    mockLimits
                );

                // act
                const limits = await chainSwap.getLimits("BTC", "ARK");

                // assert
                expect(limits).toEqual(mockLimits);
                expect(swapProvider.getChainLimits).toHaveBeenCalledWith(
                    "BTC",
                    "ARK"
                );
            });
        });

        describe("quoteSwap", () => {
            it("should quote a chain swap", async () => {
                // arrange
                vi.spyOn(swapProvider, "getChainQuote").mockResolvedValueOnce({
                    amount: mock.amount,
                });
                vi.spyOn(swapProvider, "postChainQuote").mockResolvedValueOnce(
                    {}
                );

                // act
                const amount = await chainSwap.quoteSwap(mock.id);

                // assert
                expect(amount).toEqual(mock.amount);
            });
        });

        describe("verifyChainSwap", () => {
            it("should verify a chain swap successfully", async () => {
                // arrange
                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );
                vi.spyOn(chainSwap, "createVHTLCScript").mockReturnValueOnce({
                    vhtlcScript: {} as any,
                    vhtlcAddress: mock.address.ark,
                });

                const pendingSwap: PendingChainSwap = {
                    ...mockBtcArkChainSwap,
                    response: createBtcArkChainSwapResponse,
                };

                // act & assert
                await expect(
                    chainSwap.verifyChainSwap({
                        to: "ARK",
                        from: "BTC",
                        swap: pendingSwap,
                        arkInfo: mockArkInfo,
                    })
                ).resolves.toBe(true);
            });

            it("should throw error if claim address doesn't match", async () => {
                // arrange
                vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(
                    mockArkInfo
                );
                vi.spyOn(chainSwap, "createVHTLCScript").mockReturnValueOnce({
                    vhtlcScript: {} as any,
                    vhtlcAddress: mock.address.ark + "...",
                });

                const pendingSwap: PendingChainSwap = {
                    ...mockArkBtcChainSwap,
                    response: createArkBtcChainSwapResponse,
                };

                // act & assert
                await expect(
                    chainSwap.verifyChainSwap({
                        to: "BTC",
                        from: "ARK",
                        swap: pendingSwap,
                        arkInfo: mockArkInfo,
                    })
                ).rejects.toThrow(
                    "Boltz is trying to scam us (invalid address)"
                );
            });
        });

        describe("waitAndClaimArk", () => {
            it("should resolve with txid when transaction is claimed", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockBtcArkChainSwap,
                };
                vi.spyOn(chainSwap, "claimArk").mockResolvedValue();
                vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                    async (_id, callback) => {
                        // Simulate status updates
                        setTimeout(
                            () => callback("transaction.server.mempool", {}),
                            10
                        );
                        setTimeout(
                            () => callback("transaction.claimed", {}),
                            20
                        );
                    }
                );

                // act
                const resultPromise = chainSwap.waitAndClaimArk(pendingSwap);

                // assert
                await expect(resultPromise).resolves.toEqual({
                    txid: mock.id,
                });
            });

            it("should reject with SwapExpiredError when swap expires", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockBtcArkChainSwap,
                };
                vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                    async (_id, callback) => {
                        // Simulate swap expiration
                        setTimeout(() => callback("swap.expired", {}), 10);
                    }
                );

                // act
                const resultPromise = chainSwap.waitAndClaimArk(pendingSwap);

                // assert
                await expect(resultPromise).rejects.toThrow(
                    "The swap has expired"
                );
            });

            it("should reject with TransactionFailedError when transaction fails", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockBtcArkChainSwap,
                };
                vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                    async (_id, callback) => {
                        // Simulate transaction failure
                        setTimeout(
                            () => callback("transaction.failed", {}),
                            10
                        );
                    }
                );

                // act
                const resultPromise = chainSwap.waitAndClaimArk(pendingSwap);

                // assert
                await expect(resultPromise).rejects.toThrow(
                    "Error during swap."
                );
            });

            it("should reject with TransactionRefundedError when transaction is refunded", async () => {
                // arrange
                const pendingSwap: PendingChainSwap = {
                    ...mockBtcArkChainSwap,
                };
                vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                    async (_id, callback) => {
                        // Simulate transaction refund
                        setTimeout(
                            () => callback("transaction.refunded", {}),
                            10
                        );
                    }
                );

                // act
                const resultPromise = chainSwap.waitAndClaimArk(pendingSwap);

                // assert
                await expect(resultPromise).rejects.toThrow(
                    "The transaction has been refunded."
                );
            });
        });
    });

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
                if (collectionName === "chainSwaps") {
                    return [];
                }
                return [];
            });
        });

        describe("getSwapStatus", () => {
            it("should get correct swap status", async () => {
                // arrange
                vi.spyOn(swapProvider, "getSwapStatus").mockResolvedValueOnce({
                    status: "swap.created",
                });

                // act
                const status = await chainSwap.getSwapStatus(mock.id);

                // assert
                expect(status.status).toBe("swap.created");
            });
        });

        describe("getPendingChainSwaps", () => {
            it("should return empty array when no chain swaps exist", async () => {
                // act
                const result = await chainSwap.getPendingChainSwaps();

                // assert
                expect(result).toEqual([]);
                expect(
                    wallet.contractRepository.getContractCollection
                ).toHaveBeenCalledWith("chainSwaps");
            });

            it("should return only chain swaps with swap.created status", async () => {
                // arrange
                const mockChainSwaps: PendingChainSwap[] = [
                    {
                        ...mockArkBtcChainSwap,
                        id: "swap1",
                        status: "swap.created",
                    },
                    {
                        ...mockArkBtcChainSwap,
                        id: "swap2",
                        status: "transaction.claimed",
                    },
                    {
                        ...mockArkBtcChainSwap,
                        id: "swap3",
                        status: "swap.created",
                    },
                ];

                vi.spyOn(
                    wallet.contractRepository,
                    "getContractCollection"
                ).mockImplementation(async (collectionName) => {
                    if (collectionName === "chainSwaps") {
                        return mockChainSwaps;
                    }
                    return [];
                });

                // act
                const result = await chainSwap.getPendingChainSwaps();

                // assert
                expect(result).toHaveLength(2);
                expect(result[0].id).toBe("swap1");
                expect(result[1].id).toBe("swap3");
                expect(
                    result.every((swap) => swap.status === "swap.created")
                ).toBe(true);
            });
        });

        describe("getSwapHistory", () => {
            it("should return empty array when no swaps exist", async () => {
                // act
                const result = await chainSwap.getSwapHistory();

                // assert
                expect(result).toEqual([]);
            });

            it("should return all swaps sorted by creation date", async () => {
                // arrange
                const now = Math.floor(Date.now() / 1000);
                const mockChainSwaps: PendingChainSwap[] = [
                    {
                        ...mockArkBtcChainSwap,
                        id: "swap1",
                        createdAt: now - 100,
                    },
                    {
                        ...mockArkBtcChainSwap,
                        id: "swap2",
                        createdAt: now,
                    },
                    {
                        ...mockArkBtcChainSwap,
                        id: "swap3",
                        createdAt: now - 50,
                    },
                ];

                vi.spyOn(
                    wallet.contractRepository,
                    "getContractCollection"
                ).mockImplementation(async (collectionName) => {
                    if (collectionName === "chainSwaps") {
                        return mockChainSwaps;
                    }
                    return [];
                });

                // act
                const result = await chainSwap.getSwapHistory();

                // assert
                expect(result).toHaveLength(3);
                expect(result[0].id).toBe("swap2"); // newest first
                expect(result[1].id).toBe("swap3");
                expect(result[2].id).toBe("swap1");
            });
        });

        describe("refreshSwapsStatus", () => {
            it("should refresh status of all non-final swaps", async () => {
                // arrange
                const mockChainSwaps: PendingChainSwap[] = [
                    {
                        ...mockBtcArkChainSwap,
                        id: "swap1",
                        status: "swap.created",
                    },
                    {
                        ...mockBtcArkChainSwap,
                        id: "swap2",
                        status: "transaction.claimed",
                    },
                    {
                        ...mockBtcArkChainSwap,
                        id: "swap3",
                        status: "transaction.server.mempool",
                    },
                ];

                vi.spyOn(
                    wallet.contractRepository,
                    "getContractCollection"
                ).mockResolvedValue(mockChainSwaps);

                vi.spyOn(swapProvider, "getSwapStatus")
                    .mockResolvedValueOnce({
                        status: "transaction.server.confirmed",
                    })
                    .mockResolvedValueOnce({ status: "transaction.claimed" })
                    .mockResolvedValueOnce({ status: "transaction.claimed" });

                // act
                await chainSwap.refreshSwapsStatus();

                // wait for async operations to complete
                await new Promise((resolve) => setTimeout(resolve, 100));

                // assert
                expect(swapProvider.getSwapStatus).toHaveBeenCalledTimes(2);
                // swap2 should not be refreshed as it's already in final status
                expect(swapProvider.getSwapStatus).toHaveBeenCalledWith(
                    "swap1"
                );
                expect(swapProvider.getSwapStatus).toHaveBeenCalledWith(
                    "swap3"
                );
            });
        });
    });
});
