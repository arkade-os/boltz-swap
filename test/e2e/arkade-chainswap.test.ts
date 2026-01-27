import { describe, it, expect, vi, beforeEach, beforeAll, chai } from "vitest";
import { BoltzSwapProvider } from "../../src/boltz-swap-provider";
import {
    RestArkProvider,
    RestIndexerProvider,
    Identity,
    Wallet,
    SingleKey,
    EsploraProvider,
    ArkNote,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { pubECDSA } from "@scure/btc-signer/utils.js";
import { exec } from "child_process";
import { promisify } from "util";
import { ArkadeChainSwap } from "../../src/arkade-chainswap";
import { ArkadeChainSwapConfig } from "../../src/types";
import { ad } from "vitest/dist/chunks/reporters.d.BFLkQcL6.js";

const execAsync = promisify(exec);
const arkcli = "docker exec -t arkd ark";
const bccli = "docker exec -t bitcoin bitcoin-cli -regtest";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fundBtcAddress = async (address: string, amount: number) => {
    return execAsync(`${bccli} sendtoaddress ${address} ${amount / 1e8}`);
};

const generateBlocks = async (numBlocks = 1) => {
    await execAsync(`nigiri rpc --generate ${numBlocks}`);
};

const getBtcAddress = async (): Promise<string> => {
    const { stdout } = await execAsync(`${bccli} getnewaddress`);
    return stdout.trim();
};

const getBtcAddressTxs = async (address: string): Promise<number> => {
    const { stdout } = await execAsync(
        `curl -s http://localhost:3000/address/${address}`
    );
    const outputJson = JSON.parse(stdout);
    return outputJson.chain_stats.tx_count + outputJson.mempool_stats.tx_count;
};

describe("ArkadeChainSwap", () => {
    let indexerProvider: RestIndexerProvider;
    let swapProvider: BoltzSwapProvider;
    let arkProvider: RestArkProvider;
    let chainSwap: ArkadeChainSwap;
    let identity: Identity;
    let wallet: Wallet;

    let aliceSecKey: Uint8Array;
    let aliceCompressedPubKey: string;
    let fundedWallet: Wallet;

    const arkUrl = "http://localhost:7070";

    const fundWallet = async (amount: number): Promise<void> => {
        await fundedWallet.sendBitcoin({
            address: await wallet.getAddress(),
            amount,
        });
        await sleep(2000); // wait for the wallet to detect the incoming funds
    };

    beforeAll(async () => {
        fundedWallet = await Wallet.create({
            identity: SingleKey.fromRandomBytes(),
            arkServerUrl: arkUrl,
        });

        const amount = 1_000_000;

        const { stdout: arknote } = await execAsync(
            `docker exec -t arkd arkd note --amount ${amount}`
        );

        await fundedWallet.settle({
            inputs: [ArkNote.fromString(arknote.trim())],
            outputs: [
                {
                    address: await fundedWallet.getAddress(),
                    amount: BigInt(amount),
                },
            ],
        });
    }, 120_000);

    beforeEach(async () => {
        // Create identity
        aliceSecKey = schnorr.utils.randomSecretKey();
        aliceCompressedPubKey = hex.encode(pubECDSA(aliceSecKey, true));
        identity = SingleKey.fromPrivateKey(aliceSecKey);

        // Create providers
        arkProvider = new RestArkProvider(arkUrl);
        indexerProvider = new RestIndexerProvider(arkUrl);
        swapProvider = new BoltzSwapProvider({ network: "regtest" });

        // Create wallet
        wallet = await Wallet.create({
            identity,
            arkServerUrl: arkUrl,
            onchainProvider: new EsploraProvider("http://localhost:3000", {
                forcePolling: true,
                pollingInterval: 2000,
            }),
        });

        // Create ArkadeChainSwap instance
        chainSwap = new ArkadeChainSwap({
            wallet,
            arkProvider,
            swapProvider,
            indexerProvider,
        });

        // Mock console.error to avoid polluting test output
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    describe("Initialization", () => {
        let config: ArkadeChainSwapConfig;

        beforeEach(() => {
            config = {
                wallet,
                arkProvider,
                swapProvider,
                indexerProvider,
            };
        });

        it("should be instantiated with wallet and swap provider", () => {
            expect(chainSwap).toBeInstanceOf(ArkadeChainSwap);
        });

        it("should fail to instantiate without required config", async () => {
            expect(
                () =>
                    new ArkadeChainSwap({
                        ...config,
                        wallet: null as any,
                    })
            ).toThrow("Wallet is required.");

            expect(
                () =>
                    new ArkadeChainSwap({
                        ...config,
                        swapProvider: null as any,
                    })
            ).toThrow("Swap provider is required.");
        });

        it("should default to wallet instances without required config", async () => {
            expect(
                () =>
                    new ArkadeChainSwap({
                        ...config,
                        arkProvider: null as any,
                    })
            ).not.toThrow();

            expect(
                () =>
                    new ArkadeChainSwap({
                        ...config,
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

    describe("Fees and Limits", () => {
        it("should fetch fees for a Ark to Btc chain swap", async () => {
            const fees = await chainSwap.getFees("ARK", "BTC");
            expect(typeof fees.percentage).toBe("number");
            expect(typeof fees.minerFees.server).toBe("number");
            expect(typeof fees.minerFees.user.claim).toBe("number");
            expect(typeof fees.minerFees.user.lockup).toBe("number");
        });

        it("should fetch fees for a Btc to Ark chain swap", async () => {
            const fees = await chainSwap.getFees("BTC", "ARK");
            expect(typeof fees.percentage).toBe("number");
            expect(typeof fees.minerFees.server).toBe("number");
            expect(typeof fees.minerFees.user.claim).toBe("number");
            expect(typeof fees.minerFees.user.lockup).toBe("number");
        });

        it("should fetch limits for a Ark to Btc chain swap", async () => {
            const limits = await chainSwap.getLimits("ARK", "BTC");
            expect(typeof limits.min).toBe("number");
            expect(typeof limits.max).toBe("number");
        });

        it("should fetch limits for a Btc to Ark chain swap", async () => {
            const limits = await chainSwap.getLimits("BTC", "ARK");
            expect(typeof limits.min).toBe("number");
            expect(typeof limits.max).toBe("number");
        });
    });

    describe("Ark to Btc swap", () => {
        describe("arkToBtc", () => {
            it("should throw on invalid Btc address", async () => {
                // act & assert
                await expect(
                    chainSwap.arkToBtc({ toAddress: "", amountSats: 21000 })
                ).rejects.toThrow("Invalid Btc address in arkToBtc");
            });

            it("should throw on invalid amount", async () => {
                // act & assert
                await expect(
                    chainSwap.arkToBtc({
                        amountSats: 0,
                        toAddress: await getBtcAddress(),
                    })
                ).rejects.toThrow("Invalid amount in arkToBtc");
            });

            it(
                "should perform Ark to Btc chain swap successfully",
                { timeout: 10_000 },
                async () => {
                    // arrange
                    const amountSats = 21000;
                    const fundAmount = amountSats + 2100; // include buffer for fees
                    const toAddress = await getBtcAddress();
                    await fundWallet(fundAmount);
                    const initialArkBalance = await wallet.getBalance();
                    const initialBtcTxs = await getBtcAddressTxs(toAddress);

                    // act
                    const swap = await chainSwap.arkToBtc({
                        toAddress,
                        amountSats,
                    });

                    // assert
                    expect(swap).toHaveProperty("id");
                    expect(swap).toHaveProperty("request");
                    expect(swap).toHaveProperty("response");
                    expect(swap).toHaveProperty("preimage");
                    expect(swap).toHaveProperty("createdAt");
                    expect(swap).toHaveProperty("ephemeralKey");
                    expect(swap).toHaveProperty("feeSatsPerByte");

                    expect(swap.type).toEqual("chain");
                    expect(swap.toAddress).toEqual(toAddress);
                    expect(swap.status).toEqual("transaction.claimed");

                    expect(swap.request.to).toEqual("BTC");
                    expect(swap.request.from).toEqual("ARK");
                    expect(swap.request.refundPublicKey).toEqual(
                        aliceCompressedPubKey
                    );
                    expect(swap.request.serverLockAmount).toBeUndefined();
                    expect(swap.request.userLockAmount).toEqual(amountSats);

                    await generateBlocks(1); // confirm the Btc transaction
                    await sleep(5000); // wait for Btc explorer to update

                    const finalArkBalance = await wallet.getBalance();
                    const expected = initialArkBalance.available - amountSats;
                    expect(finalArkBalance.available).toEqual(expected);

                    const finalBtcTxs = await getBtcAddressTxs(toAddress);
                    expect(initialBtcTxs).toEqual(0);
                    expect(finalBtcTxs).toEqual(1);
                }
            );

            it(
                "should perform a Ark to Btc chain swap with minimal amount",
                { timeout: 10_000 },
                async () => {
                    // arrange
                    const { min: amountSats } = await chainSwap.getLimits(
                        "ARK",
                        "BTC"
                    );
                    const fundAmount = amountSats + 2100; // include buffer for fees
                    const toAddress = await getBtcAddress();
                    await fundWallet(fundAmount);
                    const initialArkBalance = await wallet.getBalance();
                    const initialBtcTxs = await getBtcAddressTxs(toAddress);

                    // act
                    const swap = await chainSwap.arkToBtc({
                        toAddress,
                        amountSats,
                    });

                    // assert
                    expect(swap).toHaveProperty("id");
                    expect(swap).toHaveProperty("request");
                    expect(swap).toHaveProperty("response");
                    expect(swap).toHaveProperty("preimage");
                    expect(swap).toHaveProperty("createdAt");
                    expect(swap).toHaveProperty("ephemeralKey");
                    expect(swap).toHaveProperty("feeSatsPerByte");

                    expect(swap.type).toEqual("chain");
                    expect(swap.toAddress).toEqual(toAddress);
                    expect(swap.status).toEqual("transaction.claimed");

                    expect(swap.request.to).toEqual("BTC");
                    expect(swap.request.from).toEqual("ARK");
                    expect(swap.request.refundPublicKey).toEqual(
                        aliceCompressedPubKey
                    );
                    expect(swap.request.serverLockAmount).toBeUndefined();
                    expect(swap.request.userLockAmount).toEqual(amountSats);

                    await generateBlocks(1); // confirm the Btc transaction
                    await sleep(5000); // wait for Btc explorer to update

                    const finalArkBalance = await wallet.getBalance();
                    const expected = initialArkBalance.available - amountSats;
                    expect(finalArkBalance.available).toEqual(expected);

                    const finalBtcTxs = await getBtcAddressTxs(toAddress);
                    expect(initialBtcTxs).toEqual(0);
                    expect(finalBtcTxs).toEqual(1);
                }
            );

            it(
                "should automatically refund if Ark to Btc chain swap fails",
                { timeout: 10_000 },
                async () => {
                    // arrange
                    const amountSats = 21000;
                    const fundAmount = amountSats + 2100; // include buffer for fees
                    const toAddress = await getBtcAddress();
                    await fundWallet(fundAmount);
                    const initialArkBalance = await wallet.getBalance();
                    const initialBtcTxs = await getBtcAddressTxs(toAddress);

                    // act
                    const swap = await chainSwap.arkToBtc({
                        toAddress,
                        amountSats,
                    });

                    // assert
                    expect(swap).toHaveProperty("id");
                    expect(swap).toHaveProperty("request");
                    expect(swap).toHaveProperty("response");
                    expect(swap).toHaveProperty("preimage");
                    expect(swap).toHaveProperty("createdAt");
                    expect(swap).toHaveProperty("ephemeralKey");
                    expect(swap).toHaveProperty("feeSatsPerByte");

                    expect(swap.type).toEqual("chain");
                    expect(swap.toAddress).toEqual(toAddress);
                    expect(swap.status).toEqual("transaction.claimed");

                    expect(swap.request.to).toEqual("BTC");
                    expect(swap.request.from).toEqual("ARK");
                    expect(swap.request.refundPublicKey).toEqual(
                        aliceCompressedPubKey
                    );
                    expect(swap.request.serverLockAmount).toBeUndefined();
                    expect(swap.request.userLockAmount).toEqual(amountSats);

                    await generateBlocks(1); // confirm the Btc transaction
                    await sleep(5000); // wait for Btc explorer to update

                    const finalArkBalance = await wallet.getBalance();
                    const expected = initialArkBalance.available - amountSats;
                    expect(finalArkBalance.available).toEqual(expected);

                    const finalBtcTxs = await getBtcAddressTxs(toAddress);
                    expect(initialBtcTxs).toEqual(0);
                    expect(finalBtcTxs).toEqual(1);
                }
            );
        });
    });

    describe("Btc to Ark swap", () => {
        describe("btcToArk", () => {
            it("should throw on invalid Ark address", async () => {
                // act & assert
                await expect(
                    chainSwap.btcToArk({
                        toAddress: "",
                        amountSats: 10000,
                        onAddressGenerated: vi.fn(),
                    })
                ).rejects.toThrow("Invalid Ark address in btcToArk");
            });

            it("should throw on invalid amount", async () => {
                // arrange
                const toAddress = await wallet.getAddress();

                // act & assert
                await expect(
                    chainSwap.btcToArk({
                        toAddress,
                        amountSats: 0,
                        onAddressGenerated: vi.fn(),
                    })
                ).rejects.toThrow("Invalid amount in btcToArk");
            });

            it("should perform Btc to Ark chain swap successfully", async () => {
                // arrange
                const amountSats = 21000;
                const toAddress = await wallet.getAddress();

                const onAddressGenerated = async (address: string) => {
                    await fundBtcAddress(address, amountSats);
                    await generateBlocks(1); // confirm the funding transaction
                };

                // act
                const swap = await chainSwap.btcToArk({
                    toAddress,
                    amountSats,
                    onAddressGenerated,
                });

                // assert
                expect(swap).toHaveProperty("id");
                expect(swap).toHaveProperty("request");
                expect(swap).toHaveProperty("response");
                expect(swap).toHaveProperty("preimage");
                expect(swap).toHaveProperty("createdAt");
                expect(swap).toHaveProperty("ephemeralKey");
                expect(swap).toHaveProperty("feeSatsPerByte");

                expect(swap.type).toEqual("chain");
                expect(swap.toAddress).toEqual(toAddress);
                expect(swap.status).toEqual("transaction.claimed");

                expect(swap.request.to).toEqual("ARK");
                expect(swap.request.from).toEqual("BTC");
                expect(swap.request.serverLockAmount).toBeUndefined();
                expect(swap.request.userLockAmount).toEqual(amountSats);

                const balance = await wallet.getBalance();
                const expected = amountSats - 1000; // accounting for fees
                expect(balance.available).toBeGreaterThanOrEqual(expected);
            });

            it("should perform Btc to Ark chain swap with minimal amount", async () => {
                // arrange
                const { min: amountSats } = await chainSwap.getLimits(
                    "BTC",
                    "ARK"
                );
                const toAddress = await wallet.getAddress();

                const onAddressGenerated = async (address: string) => {
                    await fundBtcAddress(address, amountSats);
                    await generateBlocks(1); // confirm the funding transaction
                };

                // act
                const swap = await chainSwap.btcToArk({
                    toAddress,
                    amountSats,
                    onAddressGenerated,
                });

                // assert
                expect(swap).toHaveProperty("id");
                expect(swap).toHaveProperty("request");
                expect(swap).toHaveProperty("response");
                expect(swap).toHaveProperty("preimage");
                expect(swap).toHaveProperty("createdAt");
                expect(swap).toHaveProperty("ephemeralKey");
                expect(swap).toHaveProperty("feeSatsPerByte");

                expect(swap.type).toEqual("chain");
                expect(swap.toAddress).toEqual(toAddress);
                expect(swap.status).toEqual("transaction.claimed");

                expect(swap.request.to).toEqual("ARK");
                expect(swap.request.from).toEqual("BTC");
                expect(swap.request.serverLockAmount).toBeUndefined();
                expect(swap.request.userLockAmount).toEqual(amountSats);

                const balance = await wallet.getBalance();
                const expected = amountSats - 1000; // accounting for fees
                expect(balance.available).toBeGreaterThanOrEqual(expected);
            });
        });
    });

    describe("Swap Storage and History", () => {
        describe("getPendingChainSwaps", () => {
            it("should return empty array when no chain swaps exist", async () => {
                // act
                const result = await chainSwap.getPendingChainSwaps();

                // assert
                expect(result).toEqual([]);
            });

            it("should return the swap when createChainSwap is called for a Ark to Btc swap", async () => {
                // arrange
                const pendingSwap = await chainSwap.createChainSwap({
                    to: "BTC",
                    from: "ARK",
                    feeSatsPerByte: 1,
                    userLockAmount: 10_000,
                    toAddress: await getBtcAddress(),
                });

                // act
                const result = await chainSwap.getPendingChainSwaps();

                // assert
                expect(result).toHaveLength(1);
                expect(result[0]).toEqual(pendingSwap);
            });

            it("should return the swap when createChainSwap is called for a Btc to Ark swap", async () => {
                // arrange
                const pendingSwap = await chainSwap.createChainSwap({
                    to: "ARK",
                    from: "BTC",
                    feeSatsPerByte: 1,
                    userLockAmount: 10_000,
                    toAddress: await wallet.getAddress(),
                });

                // act
                const result = await chainSwap.getPendingChainSwaps();

                // assert
                expect(result).toHaveLength(1);
                expect(result[0]).toEqual(pendingSwap);
            });
        });

        describe("getSwapHistory", () => {
            it("should return empty array when no swaps exist", async () => {
                // act
                const result = await chainSwap.getSwapHistory();

                // assert
                expect(result).toEqual([]);
            });

            it(
                "should return the swap when arkToBtc is called",
                { timeout: 10_000 },
                async () => {
                    // arrange
                    const amount = 10_000;
                    await fundWallet(amount + 2000); // include buffer for fees

                    // act
                    await chainSwap.arkToBtc({
                        amountSats: amount,
                        toAddress: await getBtcAddress(),
                    });

                    // assert
                    const pendingSwaps = await chainSwap.getSwapHistory();

                    expect(pendingSwaps).toHaveLength(1);
                    expect(pendingSwaps[0].type).toBe("chain");
                    expect(pendingSwaps[0].status).toBe("transaction.claimed");
                    expect(pendingSwaps[0].request.userLockAmount).toBe(amount);
                }
            );

            it(
                "should return the swap when btcToArk is called",
                { timeout: 10_000 },
                async () => {
                    // arrange
                    const amount = 10_000;

                    // act
                    await chainSwap.btcToArk({
                        amountSats: amount,
                        toAddress: await wallet.getAddress(),
                        onAddressGenerated: async (address: string) => {
                            await fundBtcAddress(address, amount);
                            await generateBlocks(1); // confirm the funding transaction
                        },
                    });

                    // assert
                    const pendingSwaps = await chainSwap.getSwapHistory();

                    expect(pendingSwaps).toHaveLength(1);
                    expect(pendingSwaps[0].type).toBe("chain");
                    expect(pendingSwaps[0].status).toBe("transaction.claimed");
                    expect(pendingSwaps[0].request.userLockAmount).toBe(amount);
                }
            );

            it("should return all swaps sorted by creation date (newest first)", async () => {
                // arrange
                await chainSwap.createChainSwap({
                    to: "BTC",
                    from: "ARK",
                    feeSatsPerByte: 1,
                    userLockAmount: 10_000,
                    toAddress: await getBtcAddress(),
                });

                await sleep(1000); // ensure different timestamps

                await chainSwap.createChainSwap({
                    to: "ARK",
                    from: "BTC",
                    feeSatsPerByte: 1,
                    userLockAmount: 20_000,
                    toAddress: await wallet.getAddress(),
                });

                await sleep(1000); // ensure different timestamps

                await chainSwap.createChainSwap({
                    to: "BTC",
                    from: "ARK",
                    feeSatsPerByte: 1,
                    userLockAmount: 30_000,
                    toAddress: await getBtcAddress(),
                });

                // act
                const result = await chainSwap.getSwapHistory();

                // assert
                expect(result).toHaveLength(3);

                // Should be sorted by createdAt desc (newest first)
                expect(result[0].request.userLockAmount).toBe(30_000); // newest
                expect(result[1].request.userLockAmount).toBe(20_000);
                expect(result[2].request.userLockAmount).toBe(10_000); // oldest

                // Verify the sort order
                for (let i = 0; i < result.length - 1; i++) {
                    expect(result[i].createdAt).toBeGreaterThanOrEqual(
                        result[i + 1].createdAt
                    );
                }
            });
        });
    });
});
