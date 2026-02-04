import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { ArkadeLightning } from "../../src/arkade-lightning";
import {
    BoltzSwapProvider,
    CreateSubmarineSwapRequest,
} from "../../src/boltz-swap-provider";
import type { PendingReverseSwap, PendingSubmarineSwap } from "../../src/types";
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
import { decodeInvoice } from "../../src/utils/decoding";
import { pubECDSA, sha256 } from "@scure/btc-signer/utils.js";
import { exec } from "child_process";
import { promisify } from "util";

// Scaffolding test file for ArkadeLightning
// This file will be updated when implementing features from README.md

// Helper to check if regtest environment is running

const execAsync = promisify(exec);
const arkcli = "docker exec -t arkd ark";
const lncli = "docker exec -i lnd lncli --network=regtest";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// cancel invoice, useful for testing failed swaps
const cancelInvoice = async (r_hash: string) => {
    return execAsync(`${lncli} cancelinvoice ${r_hash}`);
};

// pay invoice, useful for testing reverse swaps
const payInvoice = async (invoice: string) => {
    return execAsync(`${lncli} payinvoice --force ${invoice}`);
};

// get a new lightning invoice from lnd docker container
const getNewLightningInvoice = async (
    amount: number
): Promise<{ invoice: string; r_hash: string }> => {
    const { stdout } = await execAsync(`${lncli} addinvoice --amt ${amount}`);
    const output = stdout.trim();
    const { payment_request, r_hash } = JSON.parse(output);
    return { invoice: payment_request, r_hash };
};

describe("ArkadeLightning", () => {
    let indexerProvider: RestIndexerProvider;
    let swapProvider: BoltzSwapProvider;
    let arkProvider: RestArkProvider;
    let lightning: ArkadeLightning;
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

    // Funded wallet setup
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

        // Create ArkadeLightning instance
        lightning = new ArkadeLightning({
            wallet,
            swapProvider,
            arkProvider,
            indexerProvider,
        });

        // Mock console.error to avoid polluting test output
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    describe("Initialization", () => {
        it("should be instantiated with wallet and swap provider", () => {
            expect(
                () =>
                    new ArkadeLightning({
                        wallet,
                        arkProvider,
                        swapProvider,
                        indexerProvider,
                    })
            ).not.toThrow();
        });

        it("should fail to instantiate without required config", async () => {
            expect(
                () =>
                    new ArkadeLightning({
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
                    new ArkadeLightning({
                        wallet,
                        swapProvider,
                        indexerProvider,
                        arkProvider: null as any,
                    })
            ).not.toThrow();
            expect(
                () =>
                    new ArkadeLightning({
                        wallet,
                        arkProvider,
                        swapProvider,
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

    describe("Fees and Limits", () => {
        it("should fetch fees", async () => {
            const fees = await lightning.getFees();
            expect(typeof fees.reverse.percentage).toBe("number");
            expect(typeof fees.reverse.minerFees.claim).toBe("number");
            expect(typeof fees.reverse.minerFees.lockup).toBe("number");
            expect(typeof fees.submarine.percentage).toBe("number");
            expect(typeof fees.submarine.minerFees).toBe("number");
        });

        it("should fetch limits", async () => {
            const limits = await lightning.getLimits();
            expect(typeof limits.min).toBe("number");
            expect(typeof limits.max).toBe("number");
        });
    });

    describe("Receive from Lightning", () => {
        describe("createLightningInvoice", () => {
            it("should throw if amount is not > 0", async () => {
                // act & assert
                await expect(
                    lightning.createLightningInvoice({ amount: 0 })
                ).rejects.toThrow("Amount must be greater than 0");

                await expect(
                    lightning.createLightningInvoice({ amount: -1 })
                ).rejects.toThrow("Amount must be greater than 0");
            });

            it("should create a valid Lightning invoice", async () => {
                // arrange
                const amount = 2100;

                // act
                const result = await lightning.createLightningInvoice({
                    amount,
                });

                const decodeInvoiceResult = decodeInvoice(result.invoice);

                // assert
                expect(decodeInvoiceResult.amountSats).toBe(amount);
            });

            it("should create a Lightning invoice with description", async () => {
                // arrange
                const amount = 1000;
                const description = "Test payment description";

                // act
                const result = await lightning.createLightningInvoice({
                    amount,
                    description,
                });

                const decodeInvoiceResult = decodeInvoice(result.invoice);

                // assert
                expect(decodeInvoiceResult.amountSats).toBe(amount);
                expect(decodeInvoiceResult.description).toBe(description);
            });

            it("should return a valid response object", async () => {
                // arrange
                const amount = 1500;
                const description = "Another test payment";

                // act
                const result = await lightning.createLightningInvoice({
                    amount,
                    description,
                });

                // assert
                expect(result.expiry).toBeTypeOf("number");
                expect(result.invoice).toMatch(/^lnbcrt/);
                expect(result.paymentHash).toHaveLength(64);
                expect(result.preimage).toHaveLength(64);
            });

            it("should create a invoice with minimal amount", async () => {
                // arrange
                const { min: amount } = await lightning.getLimits();
                const description = "Another test payment";

                // act
                const result = await lightning.createLightningInvoice({
                    amount,
                    description,
                });

                // assert
                expect(result.expiry).toBeTypeOf("number");
                expect(result.invoice).toMatch(/^lnbcrt/);
                expect(result.paymentHash).toHaveLength(64);
                expect(result.preimage).toHaveLength(64);
            });
        });

        describe("createReverseSwap", () => {
            it("should create a reverse swap", async () => {
                // arrange
                const amount = 1000;
                const description = "Test reverse swap";

                // act
                const pendingSwap = await lightning.createReverseSwap({
                    amount,
                    description,
                });

                const preimageHash = hex.encode(
                    sha256(hex.decode(pendingSwap.preimage))
                );

                // assert
                expect(pendingSwap.status).toEqual("swap.created");
                expect(pendingSwap.preimage).toHaveLength(64);
                expect(pendingSwap.request.invoiceAmount).toEqual(amount);
                expect(pendingSwap.request.preimageHash).toBe(preimageHash);
                expect(pendingSwap.request.description).toEqual(description);
                expect(pendingSwap.request.claimPublicKey).toEqual(
                    aliceCompressedPubKey
                );
                expect(pendingSwap.response).toHaveProperty("id");
                expect(pendingSwap.response.invoice).toMatch(/^lnbcrt/);
                expect(pendingSwap.response.lockupAddress).toMatch(/^tark1/);
                expect(pendingSwap.response).toHaveProperty("refundPublicKey");
                expect(pendingSwap.response.onchainAmount).toBeLessThan(amount);
            });

            it("should get correct swap status", async () => {
                // arrange
                const amount = 1000;

                // act
                const pendingSwap = await lightning.createReverseSwap({
                    amount,
                });

                // assert
                expect(lightning.getSwapStatus).toBeInstanceOf(Function);
                const status = await lightning.getSwapStatus(pendingSwap.id);
                expect(status.status).toBe("swap.created");
            });

            it("should pass description to swap provider when creating reverse swap", async () => {
                // arrange
                const amount = 1000;
                const description = "Test reverse swap description";

                // act
                const pendingSwap = await lightning.createReverseSwap({
                    amount,
                    description,
                });

                const decodeInvoiceResult = decodeInvoice(
                    pendingSwap.response.invoice
                );

                // assert
                expect(decodeInvoiceResult.amountSats).toBe(amount);
                expect(decodeInvoiceResult.description).toBe(description);
            });

            it("should increase balance when invoice is paid", async () => {
                // arrange
                const amount = 1000;
                const balanceBefore = await wallet.getBalance();

                const pendingSwap = await lightning.createReverseSwap({
                    amount,
                });

                // act
                setTimeout(async () => {
                    await payInvoice(pendingSwap.response.invoice);
                }, 1000);

                await lightning.waitAndClaim(pendingSwap);

                // wait a bit for the wallet to detect the payment
                await sleep(2000);

                const balanceAfter = await wallet.getBalance();

                // assert
                expect(balanceAfter.available).toBeGreaterThan(
                    balanceBefore.available
                );
            });
        });

        describe("waitAndClaim", () => {
            it("should claim a reverse swap when invoice is settled", async () => {
                // arrange
                const pendingSwap = await lightning.createReverseSwap({
                    amount: 1000,
                });

                // act
                setTimeout(async () => {
                    await payInvoice(pendingSwap.response.invoice);
                }, 1000);

                const response = await lightning.waitAndClaim(pendingSwap);

                // assert
                expect(response).toHaveProperty("txid");
                expect(response.txid).toHaveLength(64);
            });
        });
    });

    describe("Send to Lightning", () => {
        describe("sendLightningPayment", () => {
            it("should send a Lightning payment", async () => {
                // arrange
                const amount = 1000;
                const fundAmount = amount + 10;
                await fundWallet(fundAmount);

                const balanceBefore = await wallet.getBalance();

                const { invoice, r_hash } =
                    await getNewLightningInvoice(amount);

                // act
                const result = await lightning.sendLightningPayment({
                    invoice,
                });

                const preimageHash = hex.encode(
                    sha256(hex.decode(result.preimage))
                );

                // assert
                expect(result.amount).toBeGreaterThan(amount);
                expect(result.txid).toHaveLength(64);
                expect(r_hash).toBe(preimageHash);

                expect(balanceBefore.available).toEqual(fundAmount);
                const balanceAfter = await wallet.getBalance();
                expect(balanceAfter.available).toBeLessThan(
                    balanceBefore.available - amount
                );
            });

            it("should send a Lightning payment with minimal amount", async () => {
                // arrange
                const { min: amount } = await lightning.getLimits();
                const fundAmount = amount + 10;
                await fundWallet(fundAmount);

                const balanceBefore = await wallet.getBalance();

                const { invoice, r_hash } =
                    await getNewLightningInvoice(amount);

                // act
                const result = await lightning.sendLightningPayment({
                    invoice,
                });

                const preimageHash = hex.encode(
                    sha256(hex.decode(result.preimage))
                );

                // assert
                expect(result.amount).toBeGreaterThan(amount);
                expect(result.txid).toHaveLength(64);
                expect(r_hash).toBe(preimageHash);

                expect(balanceBefore.available).toEqual(fundAmount);
                const balanceAfter = await wallet.getBalance();
                expect(balanceAfter.available).toBeLessThan(
                    balanceBefore.available - amount
                );
            });
        });

        describe("createSubmarineSwap", () => {
            it("should create a submarine swap", async () => {
                // arrange
                const amount = 1000;
                const expectedAmount = amount + 1; // adding 1 satoshi as fee for testing
                const { invoice } = await getNewLightningInvoice(amount);
                expect(invoice).toContain("lnbcrt");

                const expectedRequest: CreateSubmarineSwapRequest = {
                    refundPublicKey: aliceCompressedPubKey,
                    invoice,
                };

                // act
                const pendingSwap = await lightning.createSubmarineSwap({
                    invoice,
                });

                // assert
                const { request, response, status } = pendingSwap;
                expect(status).toEqual("invoice.set");
                expect(request).toEqual(expectedRequest);
                expect(response.address).toMatch(/^tark1/);
                expect(response.expectedAmount).toBe(expectedAmount);
                expect(response.timeoutBlockHeights).toBeDefined();
                expect(response.timeoutBlockHeights.refund).toBeTypeOf(
                    "number"
                );
                expect(response.timeoutBlockHeights.unilateralClaim).toBeTypeOf(
                    "number"
                );
                expect(
                    response.timeoutBlockHeights.unilateralRefund
                ).toBeTypeOf("number");
                expect(
                    response.timeoutBlockHeights.unilateralRefundWithoutReceiver
                ).toBeTypeOf("number");
            });

            it("should get correct swap status", async () => {
                // arrange
                const amount = 1000;
                const { invoice } = await getNewLightningInvoice(amount);

                // act
                const pendingSwap = await lightning.createSubmarineSwap({
                    invoice,
                });

                // assert
                const status = await lightning.getSwapStatus(pendingSwap.id);
                expect(status.status).toBe("invoice.set");
            });
        });

        describe("waitForSwapSettlement", () => {
            it("should return preimage", async () => {
                // arrange
                const amount = 1000;
                const fundAmount = amount + 10;
                await fundWallet(fundAmount);

                const { invoice, r_hash } =
                    await getNewLightningInvoice(amount);

                const pendingSwap = await lightning.createSubmarineSwap({
                    invoice,
                });

                // act
                await wallet.sendBitcoin({
                    address: pendingSwap.response.address,
                    amount: pendingSwap.response.expectedAmount,
                });

                const { preimage } =
                    await lightning.waitForSwapSettlement(pendingSwap);

                const preimageHash = hex.encode(sha256(hex.decode(preimage)));

                // assert
                expect(preimage).toBeDefined();
                expect(preimage).toHaveLength(64);
                expect(preimageHash).toBe(r_hash);
            });
        });

        describe("refundVHTLC", () => {
            it(
                "should automatically refund failed submarine swap",
                { timeout: 120_000 },
                async () => {
                    // arrange
                    const amount = 1000;
                    const fundAmount = amount + 10;
                    await fundWallet(fundAmount);

                    // create invoice
                    const res = await getNewLightningInvoice(amount);

                    // cancel invoice to make the swap fail
                    await cancelInvoice(res.r_hash);

                    // act
                    await expect(() =>
                        lightning.sendLightningPayment({
                            invoice: res.invoice,
                        })
                    ).rejects.toThrow();

                    await sleep(1000); // wait a bit for the swap to be marked as failed

                    // assert
                    const swapHistory = await lightning.getSwapHistory();
                    expect(swapHistory).toHaveLength(1);
                    const failedSwap = swapHistory[0] as PendingSubmarineSwap;
                    expect(failedSwap.status).toBe("invoice.failedToPay");
                }
            );

            it(
                "should recover swept VHTLCs",
                { timeout: 120_000 },
                async () => {
                    // arrange
                    const amount = 1000;
                    const fundAmount = 2 * amount;
                    await fundWallet(fundAmount);
                    const res = await getNewLightningInvoice(amount);
                    await cancelInvoice(res.r_hash); // cancel invoice to make the swap fail

                    // act
                    const pendingSwap = await lightning.createSubmarineSwap({
                        invoice: res.invoice,
                    });

                    // fund the vhtlc after invoice is canceled so it can be swept
                    await wallet.sendBitcoin({
                        address: pendingSwap.response.address,
                        amount: pendingSwap.response.expectedAmount,
                    });

                    // get intermediate balance after funding vhtlc
                    const intermediateBalance = await wallet.getBalance();

                    // generate blocks to expire the vhtlc
                    await execAsync("nigiri rpc --generate 21");

                    // sleep 30 seconds to let arkd sweep the vhtlc
                    await new Promise((resolve) => setTimeout(resolve, 30_000));

                    // try to refund (with vhtlc swept)
                    await lightning.refundVHTLC(pendingSwap);

                    await sleep(1500);

                    // assert
                    expect(intermediateBalance.available).toEqual(
                        amount * 2 - pendingSwap.response.expectedAmount
                    );
                    const balance = await wallet.getBalance();
                    expect(balance.available).toBe(
                        pendingSwap.response.expectedAmount
                    );
                }
            );
        });
    });

    describe("Swap Storage and History", () => {
        describe("getPendingReverseSwaps", () => {
            it("should return empty array when no reverse swaps exist", async () => {
                // act
                const result = await lightning.getPendingReverseSwaps();

                // assert
                expect(result).toEqual([]);
            });

            it("should return reverse swap", async () => {
                // arrange
                const pendingSwap = await lightning.createReverseSwap({
                    amount: 1000,
                });

                // act
                const result = await lightning.getPendingReverseSwaps();

                // assert
                expect(result).toHaveLength(1);
                expect(result[0]).toEqual(pendingSwap);
            });

            it("should save reverse swap when creating lightning invoice", async () => {
                // arrange
                const amount = 1000;

                // act
                await lightning.createLightningInvoice({ amount });

                // assert
                const pendingSwaps = await lightning.getPendingReverseSwaps();

                expect(pendingSwaps).toHaveLength(1);
                expect(pendingSwaps[0].type).toBe("reverse");
                expect(pendingSwaps[0].status).toBe("swap.created");
                expect(pendingSwaps[0].request.invoiceAmount).toBe(amount);
            });

            it("should save reverse swap when receiving on lightning", async () => {
                // arrange
                const amount = 1000;
                const pendingSwap = await lightning.createReverseSwap({
                    amount,
                });

                // act
                setTimeout(async () => {
                    await payInvoice(pendingSwap.response.invoice);
                }, 1000);

                await lightning.waitAndClaim(pendingSwap);

                // assert
                const pendingSwaps = await lightning.getPendingReverseSwaps();
                expect(pendingSwaps).toHaveLength(0); // payment completed, no pending swaps

                const swapHistory = await lightning.getSwapHistory();
                expect(swapHistory).toHaveLength(1); // one completed swap

                const swap = swapHistory[0] as PendingReverseSwap;
                expect(swap.request.invoiceAmount).toBe(amount);
                expect(swap.status).toBe("invoice.settled");
                expect(swap.type).toBe("reverse");
            });
        });

        describe("getPendingSubmarineSwaps", () => {
            it("should return empty array when no submarine swaps exist", async () => {
                // act
                const result = await lightning.getPendingSubmarineSwaps();

                // assert
                expect(result).toEqual([]);
            });

            it("should return only submarine swaps with invoice.set status", async () => {
                // arrange
                const { invoice } = await getNewLightningInvoice(1000);
                const pendingSwap = await lightning.createSubmarineSwap({
                    invoice,
                });

                // act
                const result = await lightning.getPendingSubmarineSwaps();

                // assert
                expect(result).toHaveLength(1);
                expect(result[0]).toEqual(pendingSwap);
            });

            it("should save submarine swap when sending lightning payment", async () => {
                // arrange
                const amount = 1000;
                const fundAmount = amount + 10;
                await fundWallet(fundAmount);
                const { invoice } = await getNewLightningInvoice(amount);

                // act
                await lightning.sendLightningPayment({ invoice });

                // assert
                const pendingSwaps = await lightning.getPendingSubmarineSwaps();
                expect(pendingSwaps).toHaveLength(0); // payment completed, no pending swaps

                const swapHistory = await lightning.getSwapHistory();
                expect(swapHistory).toHaveLength(1);

                const swap = swapHistory[0] as PendingSubmarineSwap;
                expect(swap.status).toBe("transaction.claimed");
                expect(swap.request.invoice).toBe(invoice);
                expect(swap.type).toBe("submarine");
            });
        });

        describe("getSwapHistory", () => {
            it("should return empty array when no swaps exist", async () => {
                // act
                const result = await lightning.getSwapHistory();

                // assert
                expect(result).toEqual([]);
            });

            it("should return all swaps sorted by creation date (newest first)", async () => {
                // arrange
                const { invoice: invoice1 } =
                    await getNewLightningInvoice(1000);

                await lightning.createSubmarineSwap({
                    invoice: invoice1,
                });

                await sleep(1000); // ensure different timestamps

                await lightning.createReverseSwap({
                    amount: 2000,
                });

                await sleep(1000); // ensure different timestamps

                await lightning.createReverseSwap({
                    amount: 3000,
                });

                // act
                const result = await lightning.getSwapHistory();

                // assert
                expect(result).toHaveLength(3);

                // Should be sorted by createdAt desc (newest first)
                expect(result[0].type).toBe("reverse"); // newest
                expect(result[1].type).toBe("reverse");
                expect(result[2].type).toBe("submarine"); // oldest

                // Verify the sort order
                for (let i = 0; i < result.length - 1; i++) {
                    expect(result[i].createdAt).toBeGreaterThanOrEqual(
                        result[i + 1].createdAt
                    );
                }
            });

            it("should handle mixed swap types and statuses correctly", async () => {
                // arrange
                const { invoice } = await getNewLightningInvoice(1000);
                await lightning.createSubmarineSwap({
                    invoice,
                });
                await sleep(10); // ensure different timestamps
                await lightning.createReverseSwap({
                    amount: 2000,
                });

                // act
                const result = await lightning.getSwapHistory();

                // assert
                expect(result).toHaveLength(2);
                expect(result[0].type).toBe("reverse");
                expect(result[1].type).toBe("submarine");
            });
        });
    });
});
