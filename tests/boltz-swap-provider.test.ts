import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { BoltzSwapProvider } from "../src/boltz-swap-provider";
import { SchemaError, NetworkError } from "../src/errors";

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

describe("BoltzSwapProvider", () => {
    let provider: BoltzSwapProvider;
    const mockHexCompressedPubKey =
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
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
                claimPublicKey: mockHexCompressedPubKey,
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
                refundPublicKey: mockHexCompressedPubKey,
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
                        refundPublicKey: mockHexCompressedPubKey,
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
                    refundPublicKey: mockHexCompressedPubKey,
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
                refundPublicKey: mockHexCompressedPubKey,
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
                claimPublicKey: mockHexCompressedPubKey,
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
                        claimPublicKey: mockHexCompressedPubKey,
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
                refundPublicKey: "mock-refund-public-key",
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
                claimPublicKey: mockHexCompressedPubKey,
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
                        claimPublicKey: mockHexCompressedPubKey,
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
                refundPublicKey: "mock-refund-public-key",
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
                claimPublicKey: mockHexCompressedPubKey,
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
                        claimPublicKey: mockHexCompressedPubKey,
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
                    claimPublicKey: mockHexCompressedPubKey,
                    preimageHash: "mock-preimage-hash",
                })
            ).rejects.toThrow(SchemaError);
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

    describe("error handling", () => {
        it("should parse JSON error responses from Boltz API", async () => {
            // arrange
            const errorResponse = {
                error: "27 is less than minimal of 333",
            };
            vi.stubGlobal(
                "fetch",
                vi.fn(() =>
                    Promise.resolve({
                        ok: false,
                        status: 400,
                        text: () =>
                            Promise.resolve(JSON.stringify(errorResponse)),
                        headers: {
                            get: () => null,
                        },
                    })
                )
            );

            // act & assert
            try {
                await provider.getLimits();
                expect.fail("Should have thrown NetworkError");
            } catch (error) {
                expect(error).toBeInstanceOf(NetworkError);
                expect((error as NetworkError).statusCode).toBe(400);
                expect((error as NetworkError).errorData).toEqual(
                    errorResponse
                );
                expect((error as NetworkError).message).toBe(
                    "Boltz API error: 400"
                );
            }
        });

        it("should handle non-JSON error responses from Boltz API", async () => {
            // arrange
            const errorText = "Internal Server Error";
            vi.stubGlobal(
                "fetch",
                vi.fn(() =>
                    Promise.resolve({
                        ok: false,
                        status: 500,
                        text: () => Promise.resolve(errorText),
                        headers: {
                            get: () => null,
                        },
                    })
                )
            );

            // act & assert
            try {
                await provider.getLimits();
                expect.fail("Should have thrown NetworkError");
            } catch (error) {
                expect(error).toBeInstanceOf(NetworkError);
                expect((error as NetworkError).statusCode).toBe(500);
                expect((error as NetworkError).errorData).toBeUndefined();
                expect((error as NetworkError).message).toBe(
                    "Boltz API error: 500 Internal Server Error"
                );
            }
        });

        it("should handle malformed JSON error responses from Boltz API", async () => {
            // arrange
            const malformedJson = "{invalid json}";
            vi.stubGlobal(
                "fetch",
                vi.fn(() =>
                    Promise.resolve({
                        ok: false,
                        status: 400,
                        text: () => Promise.resolve(malformedJson),
                        headers: {
                            get: () => null,
                        },
                    })
                )
            );

            // act & assert
            try {
                await provider.getLimits();
                expect.fail("Should have thrown NetworkError");
            } catch (error) {
                expect(error).toBeInstanceOf(NetworkError);
                expect((error as NetworkError).statusCode).toBe(400);
                expect((error as NetworkError).errorData).toBeUndefined();
                expect((error as NetworkError).message).toBe(
                    "Boltz API error: 400 {invalid json}"
                );
            }
        });
    });
});
