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
import { VHTLC } from '@arkade-os/sdk';
import { hex } from '@scure/base';
import { randomBytes } from 'crypto';
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { ripemd160 } from '@noble/hashes/legacy';
import { decodeInvoice } from '../src/utils/decoding';

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

  const seckeys = {
    alice: schnorr.utils.randomSecretKey(),
    boltz: schnorr.utils.randomSecretKey(),
    server: schnorr.utils.randomSecretKey(),
  };

  const mock = {
    address: 'mock-address',
    amount: 21000,
    hex: 'mock-hex',
    id: 'mock-id',
    invoice: {
      amount: 3000000, // amount in satoshis
      description: 'Payment request with multipart support',
      paymentHash: '850aeaf5f69670e8889936fc2e0cff3ceb0c3b5eab8f04ae57767118db673a91',
      expiry: 28800, // 8 hours in seconds
      address:
        'lntb30m1pw2f2yspp5s59w4a0kjecw3zyexm7zur8l8n4scw674w' +
        '8sftjhwec33km882gsdpa2pshjmt9de6zqun9w96k2um5ypmkjar' +
        'gypkh2mr5d9cxzun5ypeh2ursdae8gxqruyqvzddp68gup69uhnz' +
        'wfj9cejuvf3xshrwde68qcrswf0d46kcarfwpshyaplw3skw0tdw' +
        '4k8g6tsv9e8glzddp68gup69uhnzwfj9cejuvf3xshrwde68qcrs' +
        'wf0d46kcarfwpshyaplw3skw0tdw4k8g6tsv9e8gcqpfmy8keu46' +
        'zsrgtz8sxdym7yedew6v2jyfswg9zeqetpj2yw3f52ny77c5xsrg' +
        '53q9273vvmwhc6p0gucz2av5gtk3esevk0cfhyvzgxgpgyyavt',
    },
    lockupAddress: 'mock-lockup-address',
    preimage: 'mock-preimage',
    pubkeys: {
      alice: schnorr.getPublicKey(seckeys.alice),
      boltz: schnorr.getPublicKey(seckeys.boltz),
      server: schnorr.getPublicKey(seckeys.server),
    },
    txid: 'mock-txid',
  };

  const createSubmarineSwapRequest: CreateSubmarineSwapRequest = {
    invoice: mock.invoice.address,
    refundPublicKey: hex.encode(mock.pubkeys.alice),
  };

  const createSubmarineSwapResponse: CreateSubmarineSwapResponse = {
    id: mock.id,
    address: mock.address,
    expectedAmount: mock.invoice.amount,
    acceptZeroConf: true,
    claimPublicKey: hex.encode(mock.pubkeys.boltz),
    timeoutBlockHeights: {
      refund: 17,
      unilateralClaim: 21,
      unilateralRefund: 42,
      unilateralRefundWithoutReceiver: 63,
    },
  };

  const createReverseSwapRequest: CreateReverseSwapRequest = {
    claimPublicKey: hex.encode(mock.pubkeys.alice),
    preimageHash: mock.invoice.paymentHash,
    invoiceAmount: mock.invoice.amount,
  };

  const createReverseSwapResponse: CreateReverseSwapResponse = {
    id: mock.id,
    invoice: mock.invoice.address,
    onchainAmount: mock.invoice.amount,
    lockupAddress: mock.lockupAddress,
    refundPublicKey: hex.encode(mock.pubkeys.boltz),
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
      getAddress: vi.fn().mockResolvedValue(mock.address),
      getBalance: vi.fn().mockResolvedValue(mock.invoice.amount),
      getBoardingAddress: vi.fn().mockResolvedValue(mock.address),
      getBoardingUtxos: vi.fn().mockResolvedValue([]),
      getTransactionHistory: vi.fn().mockResolvedValue([]),
      sendBitcoin: vi.fn().mockResolvedValue(mock.txid),
      settle: vi.fn().mockResolvedValue(undefined),
      signerSession: vi.fn().mockReturnValue({
        sign: vi.fn().mockResolvedValue({ txid: mock.txid, hex: mock.hex }),
      }),
      xOnlyPublicKey: vi.fn().mockReturnValue(mock.pubkeys.alice),
      getVtxos: vi.fn().mockResolvedValue([]),
      sign: vi.fn(),
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

  describe('Initialization', () => {
    it('should be instantiated with wallet and swap provider', () => {
      expect(lightning).toBeInstanceOf(ArkadeLightning);
    });

    it('should fail to instantiate without required config', async () => {
      const params = { wallet: mockWallet, swapProvider, arkProvider, indexerProvider } as any;
      expect(() => new ArkadeLightning({ ...params })).not.toThrow();
      expect(() => new ArkadeLightning({ ...params, storageProvider })).not.toThrow();
      expect(() => new ArkadeLightning({ ...params, arkProvider: null })).toThrow('Ark provider is required either in wallet or config.');
      expect(() => new ArkadeLightning({ ...params, swapProvider: null })).toThrow('Swap provider is required.');
      expect(() => new ArkadeLightning({ ...params, indexerProvider: null })).toThrow('Indexer provider is required either in wallet or config.');
    });

    it('should have expected interface methods', () => {
      expect(lightning.claimVHTLC).toBeInstanceOf(Function);
      expect(lightning.createLightningInvoice).toBeInstanceOf(Function);
      expect(lightning.createReverseSwap).toBeInstanceOf(Function);
      expect(lightning.createSubmarineSwap).toBeInstanceOf(Function);
      expect(lightning.refundVHTLC).toBeInstanceOf(Function);
      expect(lightning.sendLightningPayment).toBeInstanceOf(Function);
      expect(lightning.waitAndClaim).toBeInstanceOf(Function);
      expect(lightning.waitForSwapSettlement).toBeInstanceOf(Function);
    });
  });

  describe('VHTLC Operations', () => {
    const preimage = randomBytes(20);
    const mockVHTLC = {
      vhtlcAddress: mock.address,
      vhtlcScript: new VHTLC.Script({
        preimageHash: ripemd160(sha256(preimage)),
        sender: mock.pubkeys.alice,
        receiver: mock.pubkeys.boltz,
        server: mock.pubkeys.server,
        refundLocktime: BigInt(17),
        unilateralClaimDelay: {
          type: 'blocks',
          value: BigInt(21),
        },
        unilateralRefundDelay: {
          type: 'blocks',
          value: BigInt(42),
        },
        unilateralRefundWithoutReceiverDelay: {
          type: 'blocks',
          value: BigInt(63),
        },
      }),
    };
    it('should claim a VHTLC', async () => {
      // arrange
      const pendingSwap: PendingReverseSwap = {
        type: 'reverse',
        createdAt: Date.now(),
        preimage: hex.encode(preimage),
        request: createReverseSwapRequest,
        response: createReverseSwapResponse,
        status: 'swap.created',
      };
      vi.spyOn(arkProvider, 'getInfo').mockResolvedValueOnce({ signerPubkey: hex.encode(mock.pubkeys.server) } as any);
      vi.spyOn(lightning, 'createVHTLCScript').mockReturnValueOnce(mockVHTLC);
      vi.spyOn(indexerProvider, 'getVtxos').mockResolvedValueOnce({ vtxos: [] });
      vi.spyOn(arkProvider, 'submitTx').mockResolvedValueOnce({ arkTxid: '', finalArkTx: '', signedCheckpointTxs: [] });
      vi.spyOn(arkProvider, 'finalizeTx').mockResolvedValueOnce();
      await expect(lightning.claimVHTLC(pendingSwap)).rejects.toThrow('Boltz is trying to scam us');
    });
  });

  describe('Create Lightning Invoice', () => {
    it('should throw if amount is not > 0', async () => {
      // act & assert
      await expect(lightning.createLightningInvoice({ amount: 0 })).rejects.toThrow('Amount must be greater than 0');
      await expect(lightning.createLightningInvoice({ amount: -1 })).rejects.toThrow('Amount must be greater than 0');
    });

    it('should create a Lightning invoice', async () => {
      // arrange
      const pendingSwap: PendingReverseSwap = {
        type: 'reverse',
        createdAt: Date.now(),
        preimage: mock.preimage,
        request: createReverseSwapRequest,
        response: createReverseSwapResponse,
        status: 'swap.created',
      };
      vi.spyOn(lightning, 'createReverseSwap').mockResolvedValueOnce(pendingSwap);

      // act
      const result = await lightning.createLightningInvoice({ amount: mock.amount });

      // assert
      expect(result.expiry).toBe(mock.invoice.expiry);
      expect(result.invoice).toBe(mock.invoice.address);
      expect(result.paymentHash).toBe(mock.invoice.paymentHash);
      expect(result.preimage).toBe(mock.preimage);
      expect(result.pendingSwap.request.claimPublicKey).toBe(hex.encode(mock.pubkeys.alice));
    });
  });

  describe('Reverse Swaps', () => {
    it('should create a reverse swap', async () => {
      // arrange
      vi.spyOn(swapProvider, 'createReverseSwap').mockResolvedValueOnce(createReverseSwapResponse);

      // act
      const pendingSwap = await lightning.createReverseSwap({ amount: mock.invoice.amount });

      // assert
      expect(pendingSwap.request.invoiceAmount).toBe(mock.invoice.amount);
      expect(pendingSwap.request.preimageHash).toHaveLength(64);
      expect(pendingSwap.response.invoice).toBe(mock.invoice.address);
      expect(pendingSwap.response.lockupAddress).toBe(mock.lockupAddress);
      expect(pendingSwap.response.onchainAmount).toBe(mock.invoice.amount);
      expect(pendingSwap.response.refundPublicKey).toBe(hex.encode(mock.pubkeys.boltz));
      expect(pendingSwap.status).toEqual('swap.created');
    });
  });

  describe('Submarine Swaps', () => {
    it('should create a submarine swap', async () => {
      // arrange
      vi.spyOn(swapProvider, 'createSubmarineSwap').mockResolvedValueOnce(createSubmarineSwapResponse);

      // act
      const pendingSwap = await lightning.createSubmarineSwap({ invoice: mock.invoice.address });

      // assert
      expect(pendingSwap.status).toEqual('invoice.set');
      expect(pendingSwap.request).toEqual(createSubmarineSwapRequest);
      expect(pendingSwap.response).toEqual(createSubmarineSwapResponse);
    });
  });

  describe('Decoding lightning invoices', () => {
    it('should decode a lightning invoice', async () => {
      // act
      const decoded = decodeInvoice(mock.invoice.address);
      // assert
      expect(decoded.expiry).toBe(mock.invoice.expiry);
      expect(decoded.amountSats).toBe(mock.invoice.amount);
      expect(decoded.description).toBe(mock.invoice.description);
      expect(decoded.paymentHash).toBe(mock.invoice.paymentHash);
    });

    it('should throw on invalid Lightning invoice', async () => {
      // act
      const invoice = 'lntb30m1invalid';
      // assert
      expect(() => decodeInvoice(invoice)).toThrow();
    });
  });

  describe('Sending Lightning Payments', () => {
    it('should send a Lightning payment', async () => {
      // arrange
      const pendingSwap: PendingSubmarineSwap = {
        type: 'submarine',
        createdAt: Date.now(),
        request: createSubmarineSwapRequest,
        response: createSubmarineSwapResponse,
        status: 'swap.created',
      };
      vi.spyOn(lightning, 'createSubmarineSwap').mockResolvedValueOnce(pendingSwap);
      vi.spyOn(lightning, 'waitForSwapSettlement').mockResolvedValueOnce({ preimage: mock.preimage });
      // act
      const result = await lightning.sendLightningPayment({ invoice: mock.invoice.address });
      // assert
      expect(mockWallet.sendBitcoin).toHaveBeenCalledWith({ address: mock.address, amount: mock.invoice.amount });
      expect(result.amount).toBe(mock.invoice.amount);
      expect(result.preimage).toBe(mock.preimage);
      expect(result.txid).toBe(mock.txid);
    });
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
