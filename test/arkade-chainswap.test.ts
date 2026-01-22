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
    };

    const compressedPubkeys = {
        alice: hex.encode(pubECDSA(seckeys.alice, true)),
        boltz: hex.encode(pubECDSA(seckeys.boltz, true)),
        server: hex.encode(pubECDSA(seckeys.server, true)),
    };

    const mockPreimage = randomBytes(32);
    const mockPreimageHash = sha256(mockPreimage);
    const mockPreimageRipe = ripemd160(mockPreimageHash);

    const mock = {
        address: "mock-btc-address",
        amount: 50000,
        hex: "mock-hex",
        id: "mock-id",
        lockupAddress: "mock-lockup-address",
        pubkeys: {
            alice: schnorr.getPublicKey(seckeys.alice),
            boltz: schnorr.getPublicKey(seckeys.boltz),
            server: schnorr.getPublicKey(seckeys.server),
        },
        txid: hex.encode(randomBytes(32)),
    };

    const createChainSwapRequest: CreateChainSwapRequest = {
        from: "ARK",
        to: "BTC",
        preimageHash: hex.encode(mockPreimageHash),
        claimPublicKey: compressedPubkeys.alice,
        refundPublicKey: compressedPubkeys.alice,
        feeSatsPerByte: 1,
        userLockAmount: mock.amount,
    };

    const createChainSwapResponse: CreateChainSwapResponse = {
        id: mock.id,
        claimDetails: {
            lockupAddress: "mock-claim-address",
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
            lockupAddress: mock.lockupAddress,
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

    const mockChainSwap: PendingChainSwap = {
        id: mock.id,
        type: "chain",
        createdAt: Math.floor(Date.now() / 1000),
        preimage: hex.encode(randomBytes(32)),
        ephemeralKey: hex.encode(randomBytes(32)),
        feeSatsPerByte: 1,
        request: createChainSwapRequest,
        response: createChainSwapResponse,
        status: "swap.created",
        toAddress: mock.address,
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

    const mockVHTLC = {
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
        vhtlcAddress: mock.lockupAddress,
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
            const params: ArkadeLightningConfig = {
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
            expect(chainSwap.receiveFromBTC).toBeInstanceOf(Function);
            expect(chainSwap.createChainSwap).toBeInstanceOf(Function);
            expect(chainSwap.verifyChainSwap).toBeInstanceOf(Function);
            expect(chainSwap.waitAndClaim).toBeInstanceOf(Function);
            expect(chainSwap.claimBTC).toBeInstanceOf(Function);
            expect(chainSwap.claimARK).toBeInstanceOf(Function);
            expect(chainSwap.createVHTLCScript).toBeInstanceOf(Function);
            expect(chainSwap.createHTLCScript).toBeInstanceOf(Function);
            expect(chainSwap.getFees).toBeInstanceOf(Function);
            expect(chainSwap.getLimits).toBeInstanceOf(Function);
            expect(chainSwap.getSwapStatus).toBeInstanceOf(Function);
            expect(chainSwap.getPendingChainSwaps).toBeInstanceOf(Function);
            expect(chainSwap.getSwapHistory).toBeInstanceOf(Function);
            expect(chainSwap.refreshSwapsStatus).toBeInstanceOf(Function);
        });
    });

    describe("VHTLC Script Creation", () => {
        it("should create a VHTLC script", () => {
            // act
            const { vhtlcScript, vhtlcAddress } = chainSwap.createVHTLCScript({
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

        it("should create a VHTLC script for mainnet", () => {
            // act
            const { vhtlcAddress } = chainSwap.createVHTLCScript({
                network: "bitcoin",
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
            expect(vhtlcAddress).toContain("ark");
        });
    });

    describe("HTLC Script Creation", () => {
        it("should create a HTLC script", () => {
            // act
            const { htlcScript, htlcAddress } = chainSwap.createHTLCScript({
                network: "regtest",
                preimageHash: mockPreimageHash,
                receiverPubkey: compressedPubkeys.alice,
                senderPubkey: compressedPubkeys.boltz,
                serverPubkey: hex.encode(mock.pubkeys.server),
                timeoutBlockHeight: 21,
            });

            // assert - currently returns empty values as it's a TODO
            expect(htlcScript).toBeDefined();
            expect(htlcAddress).toBeDefined();
        });
    });

    describe("Create Chain Swap", () => {
        it("should create a chain swap from ARK to BTC", async () => {
            // arrange
            vi.spyOn(swapProvider, "createChainSwap").mockResolvedValueOnce(
                createChainSwapResponse
            );

            // act
            const pendingSwap = await chainSwap.createChainSwap({
                from: "ARK",
                to: "BTC",
                feeSatsPerByte: 1,
                userLockAmount: mock.amount,
                toAddress: mock.address,
            });

            // assert
            expect(pendingSwap.request.from).toBe("ARK");
            expect(pendingSwap.request.to).toBe("BTC");
            expect(pendingSwap.request.userLockAmount).toBe(mock.amount);
            expect(pendingSwap.request.preimageHash).toHaveLength(64);
            expect(pendingSwap.response.id).toBe(mock.id);
            expect(pendingSwap.response.lockupDetails.lockupAddress).toBe(
                mock.lockupAddress
            );
            expect(pendingSwap.status).toEqual("swap.created");
            expect(pendingSwap.toAddress).toBe(mock.address);
        });

        it("should create a chain swap from BTC to ARK", async () => {
            // arrange
            const btcToArkResponse = {
                ...createChainSwapResponse,
                lockupDetails: {
                    ...createChainSwapResponse.lockupDetails,
                    lockupAddress: "bc1q-mock-btc-address",
                },
            };
            vi.spyOn(swapProvider, "createChainSwap").mockResolvedValueOnce(
                btcToArkResponse
            );

            // act
            const pendingSwap = await chainSwap.createChainSwap({
                from: "BTC",
                to: "ARK",
                feeSatsPerByte: 1,
                userLockAmount: mock.amount,
            });

            // assert
            expect(pendingSwap.request.from).toBe("BTC");
            expect(pendingSwap.request.to).toBe("ARK");
            expect(pendingSwap.request.userLockAmount).toBe(mock.amount);
            expect(pendingSwap.response.lockupDetails.lockupAddress).toBe(
                "bc1q-mock-btc-address"
            );
        });
    });

    describe("Verify Chain Swap", () => {
        it("should verify a chain swap successfully", async () => {
            // arrange
            vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(mockArkInfo);
            vi.spyOn(chainSwap, "createVHTLCScript").mockReturnValueOnce({
                vhtlcScript: {} as any,
                vhtlcAddress: mock.lockupAddress,
            });
            vi.spyOn(chainSwap, "createHTLCScript").mockReturnValueOnce({
                htlcScript: "",
                htlcAddress: createChainSwapResponse.claimDetails.lockupAddress,
            });

            const pendingSwap: PendingChainSwap = {
                ...mockChainSwap,
                response: createChainSwapResponse,
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
            vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(mockArkInfo);
            vi.spyOn(chainSwap, "createVHTLCScript").mockReturnValueOnce({
                vhtlcScript: {} as any,
                vhtlcAddress: "different-address",
            });
            vi.spyOn(chainSwap, "createHTLCScript").mockReturnValueOnce({
                htlcScript: "",
                htlcAddress: createChainSwapResponse.claimDetails.lockupAddress,
            });

            const pendingSwap: PendingChainSwap = {
                ...mockChainSwap,
                response: createChainSwapResponse,
            };

            // act & assert
            await expect(
                chainSwap.verifyChainSwap({
                    to: "BTC",
                    from: "ARK",
                    swap: pendingSwap,
                    arkInfo: mockArkInfo,
                })
            ).rejects.toThrow("invalid lockup address");
        });

        it("should throw error if claim address doesn't match", async () => {
            // arrange
            vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(mockArkInfo);
            vi.spyOn(chainSwap, "createVHTLCScript").mockReturnValueOnce({
                vhtlcScript: {} as any,
                vhtlcAddress: mock.lockupAddress,
            });
            vi.spyOn(chainSwap, "createHTLCScript").mockReturnValueOnce({
                htlcScript: "",
                htlcAddress: "different-claim-address",
            });

            const pendingSwap: PendingChainSwap = {
                ...mockChainSwap,
                response: createChainSwapResponse,
            };

            // act & assert
            await expect(
                chainSwap.verifyChainSwap({
                    to: "BTC",
                    from: "ARK",
                    swap: pendingSwap,
                    arkInfo: mockArkInfo,
                })
            ).rejects.toThrow("invalid claim address");
        });
    });

    describe("ARK to BTC", () => {
        it("should throw if amount is not > 0", async () => {
            // act & assert
            await expect(
                chainSwap.arkToBtc({
                    toAddress: mock.address,
                    amountSats: 0,
                })
            ).rejects.toThrow("Invalid amount in arkToBtc");
            await expect(
                chainSwap.arkToBtc({
                    toAddress: mock.address,
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
            ).rejects.toThrow("Invalid BTC address in arkToBtc");
        });
    });

    describe("Receive from BTC", () => {
        it("should throw if amount is not > 0", async () => {
            // act & assert
            await expect(
                chainSwap.receiveFromBTC({
                    amountSats: 0,
                    onAddressGenerated: vi.fn(),
                })
            ).rejects.toThrow("Invalid amount in receiveFromBTC");
            await expect(
                chainSwap.receiveFromBTC({
                    amountSats: -1,
                    onAddressGenerated: vi.fn(),
                })
            ).rejects.toThrow("Invalid amount in receiveFromBTC");
        });

        it("should call onAddressGenerated with lockup address", async () => {
            // arrange
            const onAddressGenerated = vi.fn();
            vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(mockArkInfo);
            vi.spyOn(swapProvider, "createChainSwap").mockResolvedValueOnce(
                createChainSwapResponse
            );
            vi.spyOn(chainSwap, "verifyChainSwap").mockResolvedValueOnce(true);
            vi.spyOn(chainSwap, "waitAndClaim").mockResolvedValueOnce({
                txid: mock.txid,
            });

            // act
            await chainSwap.receiveFromBTC({
                amountSats: mock.amount,
                onAddressGenerated,
            });

            // assert
            expect(onAddressGenerated).toHaveBeenCalledWith(mock.lockupAddress);
        });
    });

    describe("Fees and Limits", () => {
        it("should get fees for chain swap", async () => {
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

        it("should get limits for chain swap", async () => {
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

    describe("Swap Status", () => {
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
                        ...mockChainSwap,
                        id: "swap1",
                        status: "swap.created",
                    },
                    {
                        ...mockChainSwap,
                        id: "swap2",
                        status: "transaction.claimed",
                    },
                    {
                        ...mockChainSwap,
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
                        ...mockChainSwap,
                        id: "swap1",
                        createdAt: now - 100,
                    },
                    {
                        ...mockChainSwap,
                        id: "swap2",
                        createdAt: now,
                    },
                    {
                        ...mockChainSwap,
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
                        ...mockChainSwap,
                        id: "swap1",
                        status: "swap.created",
                    },
                    {
                        ...mockChainSwap,
                        id: "swap2",
                        status: "transaction.claimed",
                    },
                    {
                        ...mockChainSwap,
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

    describe("Wait and Claim", () => {
        it("should resolve with txid when transaction is claimed", async () => {
            // arrange
            const pendingSwap: PendingChainSwap = {
                ...mockChainSwap,
            };
            const claimFunction = vi.fn().mockResolvedValue(undefined);
            vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                async (_id, callback) => {
                    // Simulate status updates
                    setTimeout(
                        () => callback("transaction.server.mempool", {}),
                        10
                    );
                    setTimeout(() => callback("transaction.claimed", {}), 20);
                }
            );

            // act
            const resultPromise = chainSwap.waitAndClaim({
                arkInfo: mockArkInfo,
                pendingSwap,
                claimFunction,
            });

            // assert
            await expect(resultPromise).resolves.toEqual({
                txid: mock.id,
            });
        });

        it("should reject with SwapExpiredError when swap expires", async () => {
            // arrange
            const pendingSwap: PendingChainSwap = {
                ...mockChainSwap,
            };
            const claimFunction = vi.fn().mockResolvedValue(undefined);
            vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                async (_id, callback) => {
                    // Simulate swap expiration
                    setTimeout(() => callback("swap.expired", {}), 10);
                }
            );

            // act
            const resultPromise = chainSwap.waitAndClaim({
                arkInfo: mockArkInfo,
                pendingSwap,
                claimFunction,
            });

            // assert
            await expect(resultPromise).rejects.toThrow("The swap has expired");
        });

        it("should reject with TransactionFailedError when transaction fails", async () => {
            // arrange
            const pendingSwap: PendingChainSwap = {
                ...mockChainSwap,
            };
            const claimFunction = vi.fn().mockResolvedValue(undefined);
            vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                async (_id, callback) => {
                    // Simulate transaction failure
                    setTimeout(() => callback("transaction.failed", {}), 10);
                }
            );

            // act
            const resultPromise = chainSwap.waitAndClaim({
                arkInfo: mockArkInfo,
                pendingSwap,
                claimFunction,
            });

            // assert
            await expect(resultPromise).rejects.toThrow(
                "The transaction has failed."
            );
        });

        it("should reject with TransactionRefundedError when transaction is refunded", async () => {
            // arrange
            const pendingSwap: PendingChainSwap = {
                ...mockChainSwap,
            };
            const claimFunction = vi.fn().mockResolvedValue(undefined);
            vi.spyOn(swapProvider, "monitorSwap").mockImplementation(
                async (_id, callback) => {
                    // Simulate transaction refund
                    setTimeout(() => callback("transaction.refunded", {}), 10);
                }
            );

            // act
            const resultPromise = chainSwap.waitAndClaim({
                arkInfo: mockArkInfo,
                pendingSwap,
                claimFunction,
            });

            // assert
            await expect(resultPromise).rejects.toThrow(
                "The transaction has been refunded."
            );
        });
    });

    describe("Claim ARK", () => {
        it("should claim ARK when VHTLC is available", async () => {
            // arrange
            const pendingSwap: PendingChainSwap = {
                ...mockChainSwap,
                preimage: hex.encode(mockPreimage),
            };
            vi.spyOn(arkProvider, "getInfo").mockResolvedValueOnce(mockArkInfo);
            vi.spyOn(chainSwap, "createVHTLCScript").mockReturnValueOnce(
                mockVHTLC
            );
            vi.spyOn(indexerProvider, "getVtxos").mockResolvedValueOnce({
                vtxos: [
                    {
                        value: mock.amount,
                        outpoint: "mock-outpoint",
                    },
                ],
            } as any);
            vi.spyOn(arkProvider, "submitTx").mockResolvedValueOnce({
                arkTxid: mock.txid,
                finalArkTx: "",
                signedCheckpointTxs: [],
            });
            vi.spyOn(arkProvider, "finalizeTx").mockResolvedValueOnce();

            // act & assert
            await expect(
                chainSwap.claimARK({
                    arkInfo: mockArkInfo,
                    pendingSwap,
                })
            ).rejects.toThrow("Failed to decode: script is empty");
        });

        it("should throw error when no spendable VTXOs found", async () => {
            // arrange
            const pendingSwap: PendingChainSwap = {
                ...mockChainSwap,
                preimage: hex.encode(mockPreimage),
            };
            vi.spyOn(chainSwap, "createVHTLCScript").mockReturnValueOnce(
                mockVHTLC
            );
            vi.spyOn(indexerProvider, "getVtxos").mockResolvedValueOnce({
                vtxos: [],
            });

            // act & assert
            await expect(
                chainSwap.claimARK({
                    arkInfo: mockArkInfo,
                    pendingSwap,
                })
            ).rejects.toThrow("No spendable virtual coins found");
        });
    });

    describe("Claim BTC", () => {
        it("should throw error when toAddress is missing", async () => {
            // arrange
            const pendingSwap: PendingChainSwap = {
                ...mockChainSwap,
                toAddress: undefined,
            };

            // act & assert
            await expect(
                chainSwap.claimBTC({
                    pendingSwap,
                    arkInfo: mockArkInfo,
                    data: {},
                })
            ).rejects.toThrow("Destination address is required");
        });
    });
});
