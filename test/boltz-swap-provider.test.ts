import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { BoltzSwapProvider } from "../src/boltz-swap-provider";
import { SchemaError } from "../src/errors";
import { hex } from "@scure/base";
import {
    extractTimeLockFromLeafOutput,
    extractRefundPublicKeyFromLeafOutput,
    extractClaimPublicKeyFromLeafOutput,
} from "../src/utils/restoration";

// Scaffolding test file for BoltzSwapProvider
// This file will be updated when implementing features from README.md

function createFetchResponse(mockData: any) {
    return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockData),
        status: 200,
        statusText: "OK",
        clone: function () {
            return { ...this };
        },
        headers: {
            get: (arg: string) => "mock-header-value",
        },
    });
}

function generateRandomUint8Array(size = 33): Uint8Array {
    const array = new Uint8Array(size);
    crypto.getRandomValues(array);
    return array;
}

function generateRandomHex(size = 33): string {
    return hex.encode(generateRandomUint8Array(size));
}

describe("BoltzSwapProvider", () => {
    let provider: BoltzSwapProvider;
    const mockRefundPublicKey = generateRandomHex();
    const mockClaimPublicKey = generateRandomHex();
    const invoice =
        "lntb30m1pw2f2yspp5s59w4a0kjecw3zyexm7zur8l8n4scw674w" +
        "8sftjhwec33km882gsdpa2pshjmt9de6zqun9w96k2um5ypmkjar" +
        "gypkh2mr5d9cxzun5ypeh2ursdae8gxqruyqvzddp68gup69uhnz" +
        "wfj9cejuvf3xshrwde68qcrswf0d46kcarfwpshyaplw3skw0tdw" +
        "4k8g6tsv9e8glzddp68gup69uhnzwfj9cejuvf3xshrwde68qcrs" +
        "wf0d46kcarfwpshyaplw3skw0tdw4k8g6tsv9e8gcqpfmy8keu46" +
        "zsrgtz8sxdym7yedew6v2jyfswg9zeqetpj2yw3f52ny77c5xsrg" +
        "53q9273vvmwhc6p0gucz2av5gtk3esevk0cfhyvzgxgpgyyavt";

    beforeEach(() => {
        provider = new BoltzSwapProvider({
            network: "regtest",
            apiUrl: "http://localhost:9090",
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should be instantiated with network config", () => {
        expect(provider).toBeInstanceOf(BoltzSwapProvider);
        expect(provider.getNetwork()).toBe("regtest");
    });

    describe("getFees", () => {
        it("should fetch fees from API", async () => {
            // arrange
            const mockSubmarineResponse = {
                ARK: {
                    BTC: {
                        hash: "mock-hash",
                        rate: 0.0001,
                        limits: {
                            maximal: 4294967,
                            minimal: 1000,
                            maximalZeroConf: 0,
                        },
                        fees: {
                            percentage: 0.01,
                            minerFees: 0,
                        },
                    },
                },
            };
            const mockReverseResponse = {
                BTC: {
                    ARK: {
                        hash: "mock-hash",
                        rate: 1,
                        limits: {
                            maximal: 4294967,
                            minimal: 1000,
                        },
                        fees: {
                            percentage: 0.4,
                            minerFees: {
                                claim: 0,
                                lockup: 0,
                            },
                        },
                    },
                },
            };
            // mock fetch response
            const mockFetch = vi.fn();
            vi.stubGlobal("fetch", mockFetch);
            mockFetch
                .mockReturnValueOnce(createFetchResponse(mockSubmarineResponse))
                .mockReturnValueOnce(createFetchResponse(mockReverseResponse));

            // act
            const fees = await provider.getFees();
            // assert
            expect(fetch).toHaveBeenCalledWith(
                "http://localhost:9090/v2/swap/submarine",
                {
                    method: "GET",
                    headers: { "Content-Type": "application/json" },
                }
            );
            expect(fetch).toHaveBeenCalledWith(
                "http://localhost:9090/v2/swap/reverse",
                {
                    method: "GET",
                    headers: { "Content-Type": "application/json" },
                }
            );
            expect(fetch).toHaveBeenCalledTimes(2);
            expect(fees).toEqual({
                submarine: {
                    percentage: 0.01,
                    minerFees: 0,
                },
                reverse: {
                    percentage: 0.4,
                    minerFees: {
                        claim: 0,
                        lockup: 0,
                    },
                },
            });
        });

        it("should throw on invalid fees response", async () => {
            // arrange
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse({ invalid: "response" }))
            );
            // act & assert
            await expect(provider.getFees()).rejects.toThrow(SchemaError);
        });
    });

    describe("getLimits", () => {
        it("should fetch limits from API", async () => {
            // arrange
            const mockResponse = {
                ARK: {
                    BTC: {
                        hash: "mock-hash",
                        rate: 0.0001,
                        limits: {
                            maximal: 1000000,
                            minimal: 1000,
                            maximalZeroConf: 500000,
                        },
                        fees: {
                            percentage: 0.01,
                            minerFees: 1000,
                        },
                    },
                },
            };
            // mock fetch response
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse(mockResponse))
            );

            // act
            const limits = await provider.getLimits();
            // assert
            expect(fetch).toHaveBeenCalledWith(
                "http://localhost:9090/v2/swap/submarine",
                {
                    method: "GET",
                    headers: { "Content-Type": "application/json" },
                }
            );
            expect(limits).toEqual({ min: 1000, max: 1000000 });
        });

        it("should throw on invalid limits response", async () => {
            // arrange
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse({ invalid: "response" }))
            );
            // act & assert
            await expect(provider.getLimits()).rejects.toThrow(SchemaError);
        });
    });

    describe("getSwapStatus", () => {
        it("should fetch swap status by ID", async () => {
            // arrange
            const mockResponse = {
                status: "swap.created",
                zeroConfRejected: false,
                transaction: {
                    id: "mock-txid",
                    hex: "mock-hex",
                    preimage: "mock-preimage",
                },
            };
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse(mockResponse))
            );
            // act
            const status = await provider.getSwapStatus("mock-id");
            // assert
            expect(fetch).toHaveBeenCalledWith(
                "http://localhost:9090/v2/swap/mock-id",
                {
                    method: "GET",
                    headers: { "Content-Type": "application/json" },
                }
            );
            expect(status).toEqual(mockResponse);
        });

        it("should throw on invalid swap status response", async () => {
            // arrange
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse({ invalid: "response" }))
            );
            // act & assert
            await expect(provider.getSwapStatus("mock-id")).rejects.toThrow(
                SchemaError
            );
        });
    });

    describe("submarine swaps", () => {
        it("should create a submarine swap", async () => {
            // arrange
            const mockResponse = {
                id: "mock-id",
                address: "mock-address",
                expectedAmount: 21000,
                claimPublicKey: mockClaimPublicKey,
                acceptZeroConf: true,
                timeoutBlockHeights: {
                    refund: 17,
                    unilateralClaim: 21,
                    unilateralRefund: 42,
                    unilateralRefundWithoutReceiver: 63,
                },
            };
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse(mockResponse))
            );
            // act
            const response = await provider.createSubmarineSwap({
                invoice,
                refundPublicKey: mockRefundPublicKey,
            });
            // assert
            expect(fetch).toHaveBeenCalledWith(
                "http://localhost:9090/v2/swap/submarine",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        from: "ARK",
                        to: "BTC",
                        invoice,
                        refundPublicKey: mockRefundPublicKey,
                    }),
                }
            );
            expect(response).toEqual(mockResponse);
        });

        it("should throw on invalid swap response", async () => {
            // arrange
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse({ invalid: "response" }))
            );
            // act & assert
            await expect(
                provider.createSubmarineSwap({
                    invoice,
                    refundPublicKey: mockRefundPublicKey,
                })
            ).rejects.toThrow(SchemaError);
        });
    });

    describe("reverse swaps", () => {
        it("should create a reverse swap", async () => {
            // arrange
            const mockResponse = {
                id: "mock-id",
                invoice: "mock-invoice",
                onchainAmount: 21000,
                lockupAddress: "mock-lockupAddress",
                refundPublicKey: mockRefundPublicKey,
                timeoutBlockHeights: {
                    refund: 17,
                    unilateralClaim: 21,
                    unilateralRefund: 42,
                    unilateralRefundWithoutReceiver: 63,
                },
            };
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse(mockResponse))
            );
            // act
            const response = await provider.createReverseSwap({
                invoiceAmount: 21000,
                claimPublicKey: mockClaimPublicKey,
                preimageHash: "mock-preimage-hash",
            });
            // assert
            expect(fetch).toHaveBeenCalledWith(
                "http://localhost:9090/v2/swap/reverse",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        from: "BTC",
                        to: "ARK",
                        invoiceAmount: 21000,
                        claimPublicKey: mockClaimPublicKey,
                        preimageHash: "mock-preimage-hash",
                    }),
                }
            );
            expect(response).toEqual(mockResponse);
        });

        it("should include description in reverse swap request when provided", async () => {
            // arrange
            const mockResponse = {
                id: "mock-swap-id",
                invoice: invoice,
                onchainAmount: 21000,
                lockupAddress: "mock-lockup-address",
                refundPublicKey: mockRefundPublicKey,
                timeoutBlockHeights: {
                    refund: 800000,
                    unilateralClaim: 800050,
                    unilateralRefund: 800100,
                    unilateralRefundWithoutReceiver: 800150,
                },
            };
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse(mockResponse))
            );
            // act
            const response = await provider.createReverseSwap({
                invoiceAmount: 21000,
                claimPublicKey: mockClaimPublicKey,
                preimageHash: "mock-preimage-hash",
                description: "Test payment for coffee",
            });
            // assert
            expect(fetch).toHaveBeenCalledWith(
                "http://localhost:9090/v2/swap/reverse",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        from: "BTC",
                        to: "ARK",
                        invoiceAmount: 21000,
                        claimPublicKey: mockClaimPublicKey,
                        preimageHash: "mock-preimage-hash",
                        description: "Test payment for coffee",
                    }),
                }
            );
            expect(response).toEqual(mockResponse);
        });

        it("should omit whitespace-only descriptions from reverse swap request", async () => {
            // arrange
            const mockResponse = {
                id: "mock-swap-id",
                invoice: invoice,
                onchainAmount: 21000,
                lockupAddress: "mock-lockup-address",
                refundPublicKey: mockRefundPublicKey,
                timeoutBlockHeights: {
                    refund: 800000,
                    unilateralClaim: 800050,
                    unilateralRefund: 800100,
                    unilateralRefundWithoutReceiver: 800150,
                },
            };
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse(mockResponse))
            );
            // act
            const response = await provider.createReverseSwap({
                invoiceAmount: 21000,
                claimPublicKey: mockClaimPublicKey,
                preimageHash: "mock-preimage-hash",
                description: "   ", // whitespace-only description
            });
            // assert
            expect(fetch).toHaveBeenCalledWith(
                "http://localhost:9090/v2/swap/reverse",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        from: "BTC",
                        to: "ARK",
                        invoiceAmount: 21000,
                        claimPublicKey: mockClaimPublicKey,
                        preimageHash: "mock-preimage-hash",
                        // description should be omitted when it's only whitespace
                    }),
                }
            );
            expect(response).toEqual(mockResponse);
        });

        it("should throw on invalid reverse swap response", async () => {
            // arrange
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse({ invalid: "response" }))
            );
            // act & assert
            await expect(
                provider.createReverseSwap({
                    invoiceAmount: 21000,
                    claimPublicKey: mockClaimPublicKey,
                    preimageHash: "mock-preimage-hash",
                })
            ).rejects.toThrow(SchemaError);
        });
    });

    describe("Swap restoration", () => {
        it("reverse swaps", () => {
            const expected = {
                refund: 1765366349,
                unilateralClaim: 9728,
                unilateralRefund: 19456,
                unilateralRefundWithoutReceiver: 38400,
                refundPublicKey:
                    "c432d8c2f7191f2ffe380cdcd995d53492aa1af60a92f1be6698971c03ee5d6d",
            };

            const tree = {
                claimLeaf: {
                    version: 0,
                    output: "a914709b098708fed95c0d8c19fda64f630887f4f4988769200da6a9cbcebd245df8ac2f7e6520f2fd46e2da3990a74f701db1df92ffe3a9daad20e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
                },
                refundLeaf: {
                    version: 0,
                    output: "20c432d8c2f7191f2ffe380cdcd995d53492aa1af60a92f1be6698971c03ee5d6dad200da6a9cbcebd245df8ac2f7e6520f2fd46e2da3990a74f701db1df92ffe3a9daad20e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
                },
                refundWithoutBoltzLeaf: {
                    version: 0,
                    output: "044d5a3969b17520c432d8c2f7191f2ffe380cdcd995d53492aa1af60a92f1be6698971c03ee5d6dad20e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
                },
                unilateralClaimLeaf: {
                    version: 0,
                    output: "a914709b098708fed95c0d8c19fda64f630887f4f498876903130040b275200da6a9cbcebd245df8ac2f7e6520f2fd46e2da3990a74f701db1df92ffe3a9daac",
                },
                unilateralRefundLeaf: {
                    version: 0,
                    output: "03260040b27520c432d8c2f7191f2ffe380cdcd995d53492aa1af60a92f1be6698971c03ee5d6dad200da6a9cbcebd245df8ac2f7e6520f2fd46e2da3990a74f701db1df92ffe3a9daac",
                },
                unilateralRefundWithoutBoltzLeaf: {
                    version: 0,
                    output: "034b0040b27520c432d8c2f7191f2ffe380cdcd995d53492aa1af60a92f1be6698971c03ee5d6dac",
                },
            };

            expect(
                extractTimeLockFromLeafOutput(
                    tree.refundWithoutBoltzLeaf.output
                )
            ).toBe(expected.refund);

            expect(
                extractTimeLockFromLeafOutput(tree.unilateralClaimLeaf.output)
            ).toBe(expected.unilateralClaim);

            expect(
                extractTimeLockFromLeafOutput(tree.unilateralRefundLeaf.output)
            ).toBe(expected.unilateralRefund);

            expect(
                extractTimeLockFromLeafOutput(
                    tree.unilateralRefundWithoutBoltzLeaf.output
                )
            ).toBe(expected.unilateralRefundWithoutReceiver);

            expect(
                extractRefundPublicKeyFromLeafOutput(tree.refundLeaf.output)
            ).toBe(expected.refundPublicKey);
        });

        it("submarine swaps", () => {
            const expected = {
                refund: 1765885005,
                unilateralClaim: 9728,
                unilateralRefund: 19456,
                unilateralRefundWithoutReceiver: 38400,
                claimPublicKey:
                    "c432d8c2f7191f2ffe380cdcd995d53492aa1af60a92f1be6698971c03ee5d6d",
            };

            const tree = {
                claimLeaf: {
                    version: 0,
                    output: "a914685ba29acce5320ab1ed90cd24e6a125b88835ce876920c432d8c2f7191f2ffe380cdcd995d53492aa1af60a92f1be6698971c03ee5d6dad20e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
                },
                refundLeaf: {
                    version: 0,
                    output: "200da6a9cbcebd245df8ac2f7e6520f2fd46e2da3990a74f701db1df92ffe3a9daad20c432d8c2f7191f2ffe380cdcd995d53492aa1af60a92f1be6698971c03ee5d6dad20e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
                },
                refundWithoutBoltzLeaf: {
                    version: 0,
                    output: "044d444169b175200da6a9cbcebd245df8ac2f7e6520f2fd46e2da3990a74f701db1df92ffe3a9daad20e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
                },
                unilateralClaimLeaf: {
                    version: 0,
                    output: "a914685ba29acce5320ab1ed90cd24e6a125b88835ce876903130040b27520c432d8c2f7191f2ffe380cdcd995d53492aa1af60a92f1be6698971c03ee5d6dac",
                },
                unilateralRefundLeaf: {
                    version: 0,
                    output: "03260040b275200da6a9cbcebd245df8ac2f7e6520f2fd46e2da3990a74f701db1df92ffe3a9daad20c432d8c2f7191f2ffe380cdcd995d53492aa1af60a92f1be6698971c03ee5d6dac",
                },
                unilateralRefundWithoutBoltzLeaf: {
                    version: 0,
                    output: "034b0040b275200da6a9cbcebd245df8ac2f7e6520f2fd46e2da3990a74f701db1df92ffe3a9daac",
                },
            };

            expect(
                extractTimeLockFromLeafOutput(
                    tree.refundWithoutBoltzLeaf.output
                )
            ).toBe(expected.refund);

            expect(
                extractTimeLockFromLeafOutput(tree.unilateralClaimLeaf.output)
            ).toBe(expected.unilateralClaim);

            expect(
                extractTimeLockFromLeafOutput(tree.unilateralRefundLeaf.output)
            ).toBe(expected.unilateralRefund);

            expect(
                extractTimeLockFromLeafOutput(
                    tree.unilateralRefundWithoutBoltzLeaf.output
                )
            ).toBe(expected.unilateralRefundWithoutReceiver);

            expect(
                extractClaimPublicKeyFromLeafOutput(tree.refundLeaf.output)
            ).toBe(expected.claimPublicKey);
        });
    });

    // TODO: Implement tests for features shown in README.md
    // Basic operations:
    // - Creating submarine swaps
    // - Creating reverse submarine swaps
    // - Getting swap status
    // - Getting trading pairs
    // - Fee estimation
    // - Invoice validation

    // Error handling:
    // - Network errors
    // - Invalid responses
    // - Rate limiting
    // - Timeouts

    // Configuration:
    // - Default vs custom API URL
    // - Network selection (mainnet/signet/regtest)
    // - Custom request timeouts
    // - Custom retry logic

    it("should have expected interface methods", () => {
        expect(provider.createSubmarineSwap).toBeInstanceOf(Function);
        expect(provider.getSwapStatus).toBeInstanceOf(Function);
        expect(provider.getNetwork).toBeInstanceOf(Function);
    });
});
