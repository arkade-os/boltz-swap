import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BoltzSwapProvider } from '../src/boltz-swap-provider';
import { SchemaError } from '../src/errors';

// Scaffolding test file for BoltzSwapProvider
// This file will be updated when implementing features from README.md

// Mock fetch
const mockFetch = vi.fn();
vi.mock('undici', () => ({
  fetch: (...args) => mockFetch(...args),
}));

const headers = {
  get: (arg: string) => 'mock-header-value',
};

describe('BoltzSwapProvider', () => {
  let provider: BoltzSwapProvider;
  const invoice =
    'lntb30m1pw2f2yspp5s59w4a0kjecw3zyexm7zur8l8n4scw674w' +
    '8sftjhwec33km882gsdpa2pshjmt9de6zqun9w96k2um5ypmkjar' +
    'gypkh2mr5d9cxzun5ypeh2ursdae8gxqruyqvzddp68gup69uhnz' +
    'wfj9cejuvf3xshrwde68qcrswf0d46kcarfwpshyaplw3skw0tdw' +
    '4k8g6tsv9e8glzddp68gup69uhnzwfj9cejuvf3xshrwde68qcrs' +
    'wf0d46kcarfwpshyaplw3skw0tdw4k8g6tsv9e8gcqpfmy8keu46' +
    'zsrgtz8sxdym7yedew6v2jyfswg9zeqetpj2yw3f52ny77c5xsrg' +
    '53q9273vvmwhc6p0gucz2av5gtk3esevk0cfhyvzgxgpgyyavt';

  beforeEach(() => {
    provider = new BoltzSwapProvider({
      network: 'regtest',
      apiUrl: 'http://localhost:9090',
    });
  });

  it('should be instantiated with network config', () => {
    expect(provider).toBeInstanceOf(BoltzSwapProvider);
    expect(provider.getNetwork()).toBe('regtest');
  });

  describe('getLimits', () => {
    it('should fetch limits from API', async () => {
      // arrange
      const mockResponse = {
        ARK: {
          BTC: {
            hash: 'mock-hash',
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
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers,
        json: () => Promise.resolve(mockResponse),
      });
      // act
      const limits = await provider.getLimits();
      // assert
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:9090/v2/swap/submarine', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(limits).toEqual({ min: 1000, max: 1000000 });
    });

    it('should throw on invalid limits response', async () => {
      // arrange
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers,
        json: () => Promise.resolve({ invalid: 'response' }),
      });
      // act & assert
      await expect(provider.getLimits()).rejects.toThrow(SchemaError);
    });
  });

  describe('getSwapStatus', () => {
    it('should fetch swap status by ID', async () => {
      // arrange
      const mockResponse = {
        status: 'swap.created',
        zeroConfRejected: false,
        transaction: {
          id: 'mock-txid',
          hex: 'mock-hex',
          preimage: 'mock-preimage',
        },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers,
        json: () => Promise.resolve(mockResponse),
      });
      // act
      const status = await provider.getSwapStatus('mock-id');
      // assert
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:9090/swap/mock-id', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(status).toEqual(mockResponse);
    });

    it('should throw on invalid swap status response', async () => {
      // arrange
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers,
        json: () => Promise.resolve({ invalid: 'response' }),
      });
      // act & assert
      await expect(provider.getSwapStatus('mock-id')).rejects.toThrow(SchemaError);
    });
  });

  describe('submarine swaps', () => {
    it('should create a submarine swap', async () => {
      // arrange
      const mockResponse = {
        id: 'mock-id',
        address: 'mock-address',
        expectedAmount: 21000,
        claimPublicKey: 'mock-claimPublicKey',
        acceptZeroConf: true,
        timeoutBlockHeights: {
          refund: 17,
          unilateralClaim: 21,
          unilateralRefund: 42,
          unilateralRefundWithoutReceiver: 63,
        },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers,
        json: () => Promise.resolve(mockResponse),
      });
      // act
      const response = await provider.createSubmarineSwap({ invoice, refundPublicKey: 'mock-refundPublicKey' });
      // assert
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:9090/v2/swap/submarine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'ARK',
          to: 'BTC',
          invoice,
          refundPublicKey: 'mock-refundPublicKey',
        }),
      });
      expect(response).toEqual(mockResponse);
    });

    it('should throw on invalid swap response', async () => {
      // arrange
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers,
        json: () => Promise.resolve({ invalid: 'response' }),
      });
      // act & assert
      await expect(provider.createSubmarineSwap({ invoice, refundPublicKey: 'mock-refundPublicKey' })).rejects.toThrow(
        SchemaError
      );
    });
  });

  describe('reverse swaps', () => {
    it('should create a reverse swap', async () => {
      // arrange
      const mockResponse = {
        id: 'mock-id',
        invoice: 'mock-invoice',
        onchainAmount: 21000,
        lockupAddress: 'mock-lockupAddress',
        refundPublicKey: 'mock-refundPublicKey',
        timeoutBlockHeights: {
          refund: 17,
          unilateralClaim: 21,
          unilateralRefund: 42,
          unilateralRefundWithoutReceiver: 63,
        },
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers,
        json: () => Promise.resolve(mockResponse),
      });
      // act
      const response = await provider.createReverseSwap({
        invoiceAmount: 21000,
        claimPublicKey: 'mock-claimPublicKey',
        preimageHash: 'mock-preimage-hash',
      });
      // assert
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:9090/v2/swap/reverse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'BTC',
          to: 'ARK',
          invoiceAmount: 21000,
          claimPublicKey: 'mock-claimPublicKey',
          preimageHash: 'mock-preimage-hash',
        }),
      });
      expect(response).toEqual(mockResponse);
    });

    it('should throw on invalid reverse swap response', async () => {
      // arrange
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers,
        json: () => Promise.resolve({ invalid: 'response' }),
      });
      // act & assert
      await expect(
        provider.createReverseSwap({
          invoiceAmount: 21000,
          claimPublicKey: 'mock-claimPublicKey',
          preimageHash: 'mock-preimage-hash',
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
  // - Network selection (mainnet/testnet/regtest)
  // - Custom request timeouts
  // - Custom retry logic

  it('should have expected interface methods', () => {
    expect(provider.createSubmarineSwap).toBeInstanceOf(Function);
    expect(provider.getSwapStatus).toBeInstanceOf(Function);
    expect(provider.getNetwork).toBeInstanceOf(Function);
  });
});
