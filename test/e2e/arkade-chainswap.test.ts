import { describe, it, expect, vi, beforeEach, beforeAll, chai } from "vitest";
import {
    BoltzSwapProvider,
    BoltzSwapStatus,
} from "../../src/boltz-swap-provider";
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

const execAsync = promisify(exec);
const bccli = "docker exec -t bitcoin bitcoin-cli -regtest";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fundBtcAddress = async (address: string, amount: number) => {
    await execAsync(`${bccli} sendtoaddress ${address} ${amount / 1e8}`);
    await generateBlocks(1); // confirm the funding transaction
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

const waitForBtcTxConfirmation = async (address: string, timeout = 10_000) => {
    await generateBlocks(1); // confirm the Btc transaction
    await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            clearInterval(intervalId);
            reject(new Error("Timed out waiting for Btc explorer to update"));
        }, timeout);
        const intervalId = setInterval(async () => {
            const txs = await getBtcAddressTxs(address);
            if (txs === 1) {
                clearTimeout(timeoutId);
                clearInterval(intervalId);
                resolve(true);
            }
        }, 500);
    });
};

const waitForBalance = async (
    getBalance: () => Promise<{ available: number }>,
    minAmount: number,
    timeout = 5_000
): Promise<void> => {
    await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            clearInterval(intervalId);
            reject(new Error("Timed out waiting for balance to update"));
        }, timeout);
        const intervalId = setInterval(async () => {
            const balance = await getBalance();
            if (balance.available >= minAmount) {
                clearTimeout(timeoutId);
                clearInterval(intervalId);
                resolve(true);
            }
        }, 500);
    });
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

        // Wait until the funds are reflected in the wallet balance
        await waitForBalance(() => wallet.getBalance(), amount, 5_000);
    };

    const waitForSwapStatus = async (
        swapId: string,
        intendedStatus: BoltzSwapStatus,
        timeout = 3_000
    ): Promise<void> => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const { status } = await swapProvider.getSwapStatus(swapId);
            if (status === intendedStatus) return;
            await sleep(200);
        }
        throw new Error(
            `Swap did not reach status ${intendedStatus} within timeout`
        );
    };

    // Create a funded wallet to use as a source of funds
    beforeAll(async () => {
        fundedWallet = await Wallet.create({
            identity: SingleKey.fromRandomBytes(),
            arkServerUrl: arkUrl,
        });

        const amount = 1_000_000;

        // Generate a new Ark note in the arkd container
        const { stdout: arknote } = await execAsync(
            `docker exec -t arkd arkd note --amount ${amount}`
        );

        // Settle the note into the funded wallet
        await fundedWallet.settle({
            inputs: [ArkNote.fromString(arknote.trim())],
            outputs: [
                {
                    address: await fundedWallet.getAddress(),
                    amount: BigInt(amount),
                },
            ],
        });

        // Wait until the funds are reflected in the wallet balance
        await waitForBalance(() => fundedWallet.getBalance(), amount, 5_000);
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
            // act & assert
            expect(chainSwap).toBeInstanceOf(ArkadeChainSwap);
        });

        it("should fail to instantiate without required config", async () => {
            // act & assert
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
            // act & assert
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
            // act & assert
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
            expect(chainSwap.quoteSwap).toBeInstanceOf(Function);
            expect(chainSwap.refreshSwapsStatus).toBeInstanceOf(Function);
        });
    });

    describe("Fees", () => {
        it("should fetch fees for a Ark to Btc chain swap", async () => {
            // act & assert
            const fees = await chainSwap.getFees("ARK", "BTC");
            expect(typeof fees.percentage).toBe("number");
            expect(typeof fees.minerFees.server).toBe("number");
            expect(typeof fees.minerFees.user.claim).toBe("number");
            expect(typeof fees.minerFees.user.lockup).toBe("number");
        });

        it("should fetch fees for a Btc to Ark chain swap", async () => {
            // act & assert
            const fees = await chainSwap.getFees("BTC", "ARK");
            expect(typeof fees.percentage).toBe("number");
            expect(typeof fees.minerFees.server).toBe("number");
            expect(typeof fees.minerFees.user.claim).toBe("number");
            expect(typeof fees.minerFees.user.lockup).toBe("number");
        });
    });

    describe("Limits", () => {
        it("should fetch limits for a Ark to Btc chain swap", async () => {
            // act & assert
            const limits = await chainSwap.getLimits("ARK", "BTC");
            expect(typeof limits.min).toBe("number");
            expect(typeof limits.max).toBe("number");
        });

        it("should fetch limits for a Btc to Ark chain swap", async () => {
            // act & assert
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

                    await waitForBtcTxConfirmation(toAddress);

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

                    await waitForBtcTxConfirmation(toAddress);

                    const finalArkBalance = await wallet.getBalance();
                    const expected = initialArkBalance.available - amountSats;
                    expect(finalArkBalance.available).toEqual(expected);

                    const finalBtcTxs = await getBtcAddressTxs(toAddress);
                    expect(initialBtcTxs).toEqual(0);
                    expect(finalBtcTxs).toEqual(1);
                }
            );
        });

        describe("createChainSwap", () => {
            it(
                "should automatically quote if insufficient amount sent",
                { timeout: 21_000 },
                async () => {
                    // arrange
                    const amountSats = 21000;
                    const fundAmount = 23000; // include buffer for fees
                    const toAddress = await getBtcAddress();
                    const initialBtcTxs = await getBtcAddressTxs(toAddress);
                    const sendAmount = amountSats - 10000; // insufficient amount to trigger quote
                    await fundWallet(fundAmount);

                    // act
                    const swap = await chainSwap.createChainSwap({
                        to: "BTC",
                        from: "ARK",
                        feeSatsPerByte: 1,
                        userLockAmount: amountSats,
                        toAddress,
                    });

                    await wallet.sendBitcoin({
                        address: swap.response.lockupDetails.lockupAddress,
                        amount: sendAmount,
                    });

                    await chainSwap.waitAndClaimBtc(swap);

                    await waitForBtcTxConfirmation(toAddress);

                    // assert
                    const finalArkBalance = await wallet.getBalance();
                    const expected = fundAmount - sendAmount;
                    expect(finalArkBalance.available).toEqual(expected);

                    const { status } = await chainSwap.getSwapStatus(swap.id);
                    expect(status).toEqual("transaction.claimed");

                    const finalBtcTxs = await getBtcAddressTxs(toAddress);
                    expect(initialBtcTxs).toEqual(0);
                    expect(finalBtcTxs).toEqual(1);

                    expect(swap.request.serverLockAmount).toBeUndefined();
                    expect(swap.request.userLockAmount).toEqual(amountSats);
                }
            );

            it(
                "should automatically quote if too much amount sent",
                { timeout: 21_000 },
                async () => {
                    // arrange
                    const amountSats = 21000;
                    const fundAmount = 43000; // include buffer for fees
                    const toAddress = await getBtcAddress();
                    const initialBtcTxs = await getBtcAddressTxs(toAddress);
                    const sendAmount = amountSats + 10000; // too much amount to trigger quote
                    await fundWallet(fundAmount);

                    // act
                    const swap = await chainSwap.createChainSwap({
                        to: "BTC",
                        from: "ARK",
                        feeSatsPerByte: 1,
                        userLockAmount: amountSats,
                        toAddress,
                    });

                    await wallet.sendBitcoin({
                        address: swap.response.lockupDetails.lockupAddress,
                        amount: sendAmount,
                    });

                    await chainSwap.waitAndClaimBtc(swap);

                    await waitForBtcTxConfirmation(toAddress);

                    // assert
                    const finalArkBalance = await wallet.getBalance();
                    const expected = fundAmount - sendAmount;
                    expect(finalArkBalance.available).toEqual(expected);

                    const { status } = await chainSwap.getSwapStatus(swap.id);
                    expect(status).toEqual("transaction.claimed");

                    const finalBtcTxs = await getBtcAddressTxs(toAddress);
                    expect(initialBtcTxs).toEqual(0);
                    expect(finalBtcTxs).toEqual(1);

                    expect(swap.request.serverLockAmount).toBeUndefined();
                    expect(swap.request.userLockAmount).toEqual(amountSats);
                }
            );

            it(
                "should automatically refund if Ark to Btc chain swap fails",
                { timeout: 10_000 },
                async () => {
                    // arrange
                    const amountSats = 21000;
                    const fundAmount = 23000;
                    const sendAmount = 10000; // insufficient amount to trigger refund
                    await fundWallet(fundAmount);
                    const toAddress = await getBtcAddress();

                    // act
                    const swap = await chainSwap.createChainSwap({
                        to: "BTC",
                        from: "ARK",
                        feeSatsPerByte: 1,
                        userLockAmount: amountSats,
                        toAddress,
                    });

                    await wallet.sendBitcoin({
                        address: swap.response.lockupDetails.lockupAddress,
                        amount: sendAmount,
                    });

                    await waitForSwapStatus(
                        swap.id,
                        "transaction.lockupFailed"
                    );

                    const afterSwapBalance = await wallet.getBalance();

                    await chainSwap.refundArk(swap);

                    for (let i = 0; i < 10; i++) {
                        await sleep(200); // wait for wallet balance to update
                        const { available } = await wallet.getBalance();
                        if (available === fundAmount) break;
                    }

                    const afterRefundBalance = await wallet.getBalance();

                    // assert
                    expect(afterSwapBalance.available).toEqual(
                        fundAmount - sendAmount
                    );
                    expect(afterRefundBalance.available).toEqual(fundAmount);
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
                // act & assert
                await expect(
                    chainSwap.btcToArk({
                        amountSats: 0,
                        toAddress: await wallet.getAddress(),
                        onAddressGenerated: vi.fn(),
                    })
                ).rejects.toThrow("Invalid amount in btcToArk");
            });

            it("should perform Btc to Ark chain swap successfully", async () => {
                // arrange
                const amountSats = 21000;
                const toAddress = await wallet.getAddress();

                const onAddressGenerated = async (
                    address: string,
                    amount: number
                ) => {
                    await fundBtcAddress(address, amount);
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

                const onAddressGenerated = async (
                    address: string,
                    amount: number
                ) => {
                    await fundBtcAddress(address, amount);
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
        describe("createChainSwap", () => {
            it(
                "should automatically quote if insufficient amount sent",
                { timeout: 10_000 },
                async () => {
                    // arrange
                    const amountSats = 21000;
                    const sendAmount = 13000; // insufficient amount to trigger quote
                    const toAddress = await wallet.getAddress();

                    // act
                    const swap = await chainSwap.createChainSwap({
                        to: "ARK",
                        from: "BTC",
                        feeSatsPerByte: 1,
                        userLockAmount: amountSats,
                        toAddress,
                    });

                    const btcAddress =
                        swap.response.lockupDetails.lockupAddress;

                    await fundBtcAddress(btcAddress, sendAmount);

                    await waitForBtcTxConfirmation(btcAddress);

                    await chainSwap.waitAndClaimArk(swap);

                    // assert
                    const finalArkBalance = await wallet.getBalance();
                    const expected = sendAmount - 1000; // accounting for fees
                    expect(finalArkBalance.available).toBeLessThan(sendAmount);
                    expect(finalArkBalance.available).toBeGreaterThan(expected);

                    const { status } = await chainSwap.getSwapStatus(swap.id);
                    expect(status).toEqual("transaction.claimed");

                    const finalBtcTxs = await getBtcAddressTxs(btcAddress);
                    expect(finalBtcTxs).toEqual(1);

                    expect(swap.request.serverLockAmount).toBeUndefined();
                    expect(swap.request.userLockAmount).toEqual(amountSats);
                }
            );

            it(
                "should automatically quote if too much amount sent",
                { timeout: 10_000 },
                async () => {
                    // arrange
                    const amountSats = 21000;
                    const sendAmount = 22000; // too much amount to trigger quote
                    const toAddress = await wallet.getAddress();

                    // act
                    const swap = await chainSwap.createChainSwap({
                        to: "ARK",
                        from: "BTC",
                        feeSatsPerByte: 1,
                        userLockAmount: amountSats,
                        toAddress,
                    });

                    const btcAddress =
                        swap.response.lockupDetails.lockupAddress;

                    await fundBtcAddress(btcAddress, sendAmount);

                    await waitForBtcTxConfirmation(btcAddress);

                    await chainSwap.waitAndClaimArk(swap);

                    // assert
                    const finalArkBalance = await wallet.getBalance();
                    const expected = sendAmount - 1000; // accounting for fees
                    expect(finalArkBalance.available).toBeLessThan(sendAmount);
                    expect(finalArkBalance.available).toBeGreaterThan(expected);

                    const { status } = await chainSwap.getSwapStatus(swap.id);
                    expect(status).toEqual("transaction.claimed");

                    const finalBtcTxs = await getBtcAddressTxs(btcAddress);
                    expect(finalBtcTxs).toEqual(1);

                    expect(swap.request.serverLockAmount).toBeUndefined();
                    expect(swap.request.userLockAmount).toEqual(amountSats);
                }
            );
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
                    const amountSats = 10_000;

                    // act
                    await chainSwap.btcToArk({
                        amountSats,
                        toAddress: await wallet.getAddress(),
                        onAddressGenerated: async (
                            address: string,
                            amount: number
                        ) => {
                            await fundBtcAddress(address, amount);
                        },
                    });

                    // assert
                    const pendingSwaps = await chainSwap.getSwapHistory();

                    expect(pendingSwaps).toHaveLength(1);
                    expect(pendingSwaps[0].type).toBe("chain");
                    expect(pendingSwaps[0].status).toBe("transaction.claimed");
                    expect(pendingSwaps[0].request.userLockAmount).toBe(
                        amountSats
                    );
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
