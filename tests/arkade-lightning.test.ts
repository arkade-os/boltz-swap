import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ArkadeLightning } from '../src/arkade-lightning';
import {
  BoltzSwapProvider,
  CreateReverseSwapRequest,
  CreateReverseSwapResponse,
  CreateSubmarineSwapRequest,
  CreateSubmarineSwapResponse,
} from '../src/boltz-swap-provider';
import type { PendingReverseSwap, PendingSubmarineSwap, Wallet } from '../src/types';
import { RestArkProvider, RestIndexerProvider } from '@arkade-os/sdk';
import { StorageProvider } from '../src';

// Mock WebSocket - this needs to be at the top level
vi.mock('ws', () => {
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
            if (mockWs.onmessage && message.op === 'subscribe') {
              // Simulate swap.created status
              mockWs.onmessage({
                data: JSON.stringify({
                  event: 'update',
                  args: [
                    {
                      id: message.args[0],
                      status: 'swap.created',
                    },
                  ],
                }),
              });

              // Simulate transaction.confirmed status
              process.nextTick(() => {
                if (mockWs.onmessage) {
                  mockWs.onmessage({
                    data: JSON.stringify({
                      event: 'update',
                      args: [
                        {
                          id: message.args[0],
                          status: 'transaction.confirmed',
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
                      event: 'update',
                      args: [
                        {
                          id: message.args[0],
                          status: 'invoice.settled',
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
            mockWs.onclose({ type: 'close' });
          }
        }),
      };

      // Simulate connection opening
      process.nextTick(() => {
        if (mockWs.onopen) {
          mockWs.onopen({ type: 'open' });
        }
      });

      return mockWs;
    }),
  };
});

// Scaffolding test file for ArkadeLightning
// This file will be updated when implementing features from README.md

describe('ArkadeLightning', () => {
  let indexerProvider: RestIndexerProvider;
  let storageProvider: StorageProvider;
  let swapProvider: BoltzSwapProvider;
  let arkProvider: RestArkProvider;
  let lightning: ArkadeLightning;
  let mockWallet: Wallet;
  const invoice =
    'lntb30m1pw2f2yspp5s59w4a0kjecw3zyexm7zur8l8n4scw674w' +
    '8sftjhwec33km882gsdpa2pshjmt9de6zqun9w96k2um5ypmkjar' +
    'gypkh2mr5d9cxzun5ypeh2ursdae8gxqruyqvzddp68gup69uhnz' +
    'wfj9cejuvf3xshrwde68qcrswf0d46kcarfwpshyaplw3skw0tdw' +
    '4k8g6tsv9e8glzddp68gup69uhnzwfj9cejuvf3xshrwde68qcrs' +
    'wf0d46kcarfwpshyaplw3skw0tdw4k8g6tsv9e8gcqpfmy8keu46' +
    'zsrgtz8sxdym7yedew6v2jyfswg9zeqetpj2yw3f52ny77c5xsrg' +
    '53q9273vvmwhc6p0gucz2av5gtk3esevk0cfhyvzgxgpgyyavt';

  const createSubmarineSwapRequest: CreateSubmarineSwapRequest = {
    invoice,
    refundPublicKey: 'wallet-public-key',
  };

  const createSubmarineSwapResponse: CreateSubmarineSwapResponse = {
    id: 'mock-swap-id',
    address: 'mock-address',
    expectedAmount: 21000,
    acceptZeroConf: true,
    claimPublicKey: 'mock-claim-public-key',
    timeoutBlockHeights: {
      refund: 17,
      unilateralClaim: 21,
      unilateralRefund: 42,
      unilateralRefundWithoutReceiver: 63,
    },
  };

  const createReverseSwapRequest: CreateReverseSwapRequest = {
    claimPublicKey: 'wallet-public-key',
    preimageHash: 'mock-preimage-hash',
    invoiceAmount: 21000,
  };

  const createReverseSwapResponse: CreateReverseSwapResponse = {
    id: 'mock-swap-id',
    invoice: 'mock-invoice',
    onchainAmount: 21000,
    lockupAddress: 'mock-lockup-address',
    refundPublicKey: 'wallet-public-key',
    timeoutBlockHeights: {
      refund: 17,
      unilateralClaim: 21,
      unilateralRefund: 42,
      unilateralRefundWithoutReceiver: 63,
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Basic mock wallet implementation
    mockWallet = {
      getAddress: vi.fn().mockResolvedValue('mock-address'),
      sendBitcoin: vi.fn().mockResolvedValue('mock-txid'),
      signerSession: vi.fn().mockReturnValue({
        sign: vi.fn().mockResolvedValue({ txid: 'mock-signed-txid', hex: 'mock-tx-hex' }),
      }),
      getPublicKey: vi.fn().mockResolvedValue('wallet-public-key'),
      getVtxos: vi.fn().mockResolvedValue([]),
      sign: vi.fn(),
      broadcastTx: vi.fn(),
    };

    // Basic mock swap provider
    arkProvider = new RestArkProvider('http://localhost:7070');
    swapProvider = new BoltzSwapProvider({ network: 'regtest' });
    indexerProvider = new RestIndexerProvider('http://localhost:7070');
    storageProvider = await StorageProvider.create({ storagePath: './test-storage.json' });
    lightning = new ArkadeLightning({ wallet: mockWallet, arkProvider, swapProvider, indexerProvider });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should be instantiated with wallet and swap provider', () => {
    expect(lightning).toBeInstanceOf(ArkadeLightning);
  });

  it('should fail to instantiate without required config', async () => {
    const params = { wallet: mockWallet, swapProvider, arkProvider, indexerProvider } as any;
    expect(() => new ArkadeLightning({ ...params })).not.toThrow();
    expect(() => new ArkadeLightning({ ...params, storageProvider })).not.toThrow();
    expect(() => new ArkadeLightning({ ...params, arkProvider: null })).toThrow('Ark provider is required.');
    expect(() => new ArkadeLightning({ ...params, swapProvider: null })).toThrow('Swap provider is required.');
    expect(() => new ArkadeLightning({ ...params, indexerProvider: null })).toThrow('Indexer provider is required.');
  });

  it('should have expected interface methods', () => {
    expect(lightning.decodeInvoice).toBeInstanceOf(Function);
    expect(lightning.sendLightningPayment).toBeInstanceOf(Function);
    expect(lightning.createSubmarineSwap).toBeInstanceOf(Function);
    expect(lightning.waitForSwapSettlement).toBeInstanceOf(Function);
    expect(lightning.refundVHTLC).toBeInstanceOf(Function);
    expect(lightning.createLightningInvoice).toBeInstanceOf(Function);
    expect(lightning.createReverseSwap).toBeInstanceOf(Function);
    expect(lightning.waitAndClaim).toBeInstanceOf(Function);
    expect(lightning.claimVHTLC).toBeInstanceOf(Function);
  });

  it('should decode a Lightning invoice', async () => {
    // act
    const decoded = lightning.decodeInvoice(invoice);
    // assert
    expect(decoded).toHaveProperty('amountSats');
    expect(decoded).toHaveProperty('description');
    expect(decoded).toHaveProperty('paymentHash');
    expect(decoded).toHaveProperty('expiry');
    expect(decoded.expiry).toBe(28800);
    expect(decoded.amountSats).toBe(3000000);
    expect(decoded.description).toBe('Payment request with multipart support');
    expect(decoded.paymentHash).toBe('850aeaf5f69670e8889936fc2e0cff3ceb0c3b5eab8f04ae57767118db673a91');
  });

  it('should throw on invalid Lightning invoice', async () => {
    // act
    const invoice = 'lntb30m1invalid';
    // assert
    expect(() => lightning.decodeInvoice(invoice)).toThrow();
  });

  it('should send a Lightning payment', async () => {
    // arrange
    const pendingSwap: PendingSubmarineSwap = {
      request: createSubmarineSwapRequest,
      response: createSubmarineSwapResponse,
      status: 'swap.created',
    };
    vi.spyOn(lightning, 'createSubmarineSwap').mockResolvedValueOnce(pendingSwap);
    vi.spyOn(lightning, 'waitForSwapSettlement').mockResolvedValueOnce();
    vi.spyOn(swapProvider, 'getSwapStatus').mockResolvedValueOnce({
      status: 'transaction.claimed',
      transaction: {
        id: 'mock-txid',
        hex: 'mock-tx-hex',
        preimage: 'mock-preimage',
      },
    });
    // act
    const result = await lightning.sendLightningPayment({ invoice });
    // assert
    expect(mockWallet.sendBitcoin).toHaveBeenCalledWith('mock-address', 21000);
    expect(result).toHaveProperty('preimage');
    expect(result).toHaveProperty('amount');
    expect(result).toHaveProperty('txid');
    expect(result.amount).toBe(21000);
    expect(result.txid).toBe('mock-txid');
    expect(result.preimage).toBe('mock-preimage');
  });

  it('should receive a Lightning payment', async () => {
    // arrange
    const pendingSwap: PendingReverseSwap = {
      preimage: 'mock-preimage-hex',
      request: createReverseSwapRequest,
      response: createReverseSwapResponse,
      status: 'swap.created',
    };
    vi.spyOn(lightning, 'createReverseSwap').mockResolvedValueOnce(pendingSwap);
    vi.spyOn(lightning, 'waitAndClaim').mockResolvedValueOnce();
    vi.spyOn(swapProvider, 'getSwapStatus').mockResolvedValueOnce({
      status: 'transaction.claimed',
      transaction: {
        id: 'mock-txid',
        hex: 'mock-tx-hex',
        preimage: 'mock-preimage',
      },
    });

    // act
    const onUpdate = vi.fn();
    const result = await lightning.createLightningInvoice({ amount: 21000 }, onUpdate);

    // assert
    expect(result).toHaveProperty('invoice');
    expect(result).toHaveProperty('preimage');
    expect(result.invoice).toBe('mock-invoice');
    expect(result.preimage).toBe('mock-preimage-hex');
    expect(onUpdate).toHaveBeenCalledWith({
      invoice: 'mock-invoice',
      amountSats: 21000,
      preimage: 'mock-preimage-hex',
    });
  });

  it('should create a submarine swap', async () => {
    // arrange
    vi.spyOn(swapProvider, 'createSubmarineSwap').mockResolvedValueOnce(createSubmarineSwapResponse);

    // act
    const pendingSwap = await lightning.createSubmarineSwap({ invoice });

    // assert
    expect(pendingSwap).toHaveProperty('status');
    expect(pendingSwap).toHaveProperty('request');
    expect(pendingSwap).toHaveProperty('response');
    expect(pendingSwap.status).toEqual('invoice.set');
    expect(pendingSwap.request).toEqual(createSubmarineSwapRequest);
    expect(pendingSwap.response).toEqual(createSubmarineSwapResponse);
  });

  it('should create a reverse swap', async () => {
    // arrange
    vi.spyOn(swapProvider, 'createReverseSwap').mockResolvedValueOnce(createReverseSwapResponse);

    // act
    const pendingSwap = await lightning.createReverseSwap({ amount: 21000 });

    // assert
    expect(pendingSwap.request).toBeDefined();
    expect(pendingSwap.response).toBeDefined();
    expect(pendingSwap.status).toEqual('swap.created');
    expect(pendingSwap.request.invoiceAmount).toBe(21000);
    expect(pendingSwap.request.preimageHash).toHaveLength(64);
    expect(pendingSwap.response.lockupAddress).toBe('mock-lockup-address');
    expect(pendingSwap.response.refundPublicKey).toBe('wallet-public-key');
    expect(pendingSwap.response.invoice).toBe('mock-invoice');
    expect(pendingSwap.response.onchainAmount).toBe(21000);
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
});
