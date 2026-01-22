import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { ArkadeLightning } from "../../src/arkade-lightning";
import { BoltzSwapProvider } from "../../src/boltz-swap-provider";
import {
    RestArkProvider,
    RestIndexerProvider,
    Identity,
    Wallet,
    SingleKey,
    EsploraProvider,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { pubECDSA, sha256 } from "@scure/btc-signer/utils.js";
import { exec } from "child_process";
import { promisify } from "util";
import { ArkadeChainSwap } from "../../src/arkade-chainswap";

const execAsync = promisify(exec);
const arkcli = "docker exec -t arkd ark";
const bccli = "docker exec -t bitcoin bitcoin-cli -regtest";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// fund an address using arkd docker container
const fundAddress = async (address: string, amount: number) => {
    return execAsync(
        `${arkcli} send --to ${address} --amount ${amount} --password secret`
    );
};

// fund a wallet by getting its address and funding it
const fundWallet = async (wallet: Wallet, amount: number) => {
    const address = await wallet.getAddress();
    return fundAddress(address, amount);
};

const generateBlocks = async (numBlocks = 1) => {
    await execAsync(`nigiri rpc --generate ${numBlocks}`);
};

const getBTCAddress = async (): Promise<string> => {
    const { stdout } = await execAsync(`${bccli} getnewaddress`);
    return stdout.trim();
};

const getBTCBalance = async (): Promise<number> => {
    const { stdout } = await execAsync(`${bccli} getbalance`);
    return parseFloat(stdout.trim());
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

    beforeAll(async () => {
        // make sure ark cli funds are not expired
        await execAsync(`${arkcli} settle --password secret`);
    });

    beforeEach(async () => {
        const arkUrl = "http://localhost:7070";

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
        it("should be instantiated with wallet and swap provider", () => {
            expect(chainSwap).toBeInstanceOf(ArkadeChainSwap);
        });

        it("should fail to instantiate without required config", async () => {
            expect(
                () =>
                    new ArkadeChainSwap({
                        arkProvider,
                        swapProvider,
                        indexerProvider,
                        wallet: null as any,
                    })
            ).toThrow("Wallet is required.");

            expect(
                () =>
                    new ArkadeChainSwap({
                        wallet,
                        arkProvider,
                        indexerProvider,
                        swapProvider: null as any,
                    })
            ).toThrow("Swap provider is required.");
        });

        it("should default to wallet instances without required config", async () => {
            expect(
                () =>
                    new ArkadeChainSwap({
                        wallet,
                        swapProvider,
                        indexerProvider,
                        arkProvider: null as any,
                    })
            ).not.toThrow();

            expect(
                () =>
                    new ArkadeChainSwap({
                        wallet,
                        arkProvider,
                        swapProvider,
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

    describe("ARK to BTC Swap", () => {
        describe("arkToBtc", () => {
            it("should throw on invalid BTC address", async () => {
                await expect(
                    chainSwap.arkToBtc({ toAddress: "", amountSats: 10000 })
                ).rejects.toThrow("Invalid BTC address in arkToBtc");
            });

            it("should throw on invalid amount", async () => {
                // assert
                const btcAddress = await getBTCAddress();
                await expect(
                    chainSwap.arkToBtc({
                        toAddress: btcAddress,
                        amountSats: 0,
                    })
                ).rejects.toThrow("Invalid amount in arkToBtc");
            });

            it(
                "should perform ARK to BTC chain swap successfully",
                { timeout: 12_000 },
                async () => {
                    // arrange
                    const amountSats = 21000;
                    const toAddress = await getBTCAddress();
                    await fundWallet(wallet, amountSats + 2100);
                    const initialBTCBalance = await getBTCBalance();
                    const initialArkBalance = await wallet.getBalance();

                    // act
                    setTimeout(async () => {
                        await generateBlocks(6);
                    }, 2000); // generate blocks to confirm BTC tx

                    const swap = await chainSwap.arkToBtc({
                        toAddress,
                        amountSats,
                    });

                    // assert
                    console.warn("pendingSwap:", swap);
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

                    const finalBTCBalance = await getBTCBalance();
                    expect(finalBTCBalance).toBeLessThan(initialBTCBalance);

                    const finalArkBalance = await wallet.getBalance();
                    const expected = initialArkBalance.available - amountSats;
                    expect(finalArkBalance.available).toEqual(expected);
                }
            );
        });
    });
});
