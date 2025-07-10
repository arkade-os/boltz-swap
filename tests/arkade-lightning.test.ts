import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ArkadeLightning } from '../src/arkade-lightning';
import { BoltzSwapProvider } from '../src/providers/boltz/provider';
import type { Wallet, Network } from '../src/types';
import { RestArkProvider } from '@arkade-os/sdk';

// Scaffolding test file for ArkadeLightning
// This file will be updated when implementing features from README.md

vi.mock('../src/providers/boltz/provider');

describe('ArkadeLightning', () => {
  let swapProvider: BoltzSwapProvider;
  let arkProvider: RestArkProvider;
  let lightning: ArkadeLightning;
  let mockWallet: Wallet;

  beforeEach(() => {
    vi.clearAllMocks();

    // Basic mock wallet implementation
    mockWallet = {
      getAddress: vi.fn().mockResolvedValue('mock-address'),
      sendBitcoin: vi.fn().mockResolvedValue('mock-txid'),
      signerSession: vi.fn().mockReturnValue({
        sign: vi.fn().mockResolvedValue({ txid: 'mock-signed-txid', hex: 'mock-tx-hex' }),
      }),
      getPublicKey: vi.fn().mockResolvedValue('pubkey'),
      getVtxos: vi.fn().mockResolvedValue([]),
      sign: vi.fn(),
      broadcastTx: vi.fn(),
    };

    // Basic mock swap provider
    arkProvider = new RestArkProvider('http://localhost:7070');
    swapProvider = new BoltzSwapProvider({ network: 'regtest' });
    lightning = new ArkadeLightning({ wallet: mockWallet, arkProvider, swapProvider });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should be instantiated with wallet and swap provider', () => {
    expect(lightning).toBeInstanceOf(ArkadeLightning);
  });

  it('should fail to instantiate without required config', () => {
    expect(() => new ArkadeLightning({} as any)).toThrow('Wallet is required.');
    expect(() => new ArkadeLightning({ wallet: mockWallet } as any)).toThrow('Swap provider is required.');
    expect(() => new ArkadeLightning({ wallet: mockWallet, swapProvider } as any)).toThrow('Ark provider is required.');
  });

  it('should have expected interface methods', () => {
    expect(lightning.decodeInvoice).toBeInstanceOf(Function);
    expect(lightning.sendLightningPayment).toBeInstanceOf(Function);
    expect(lightning.createLightningInvoice).toBeInstanceOf(Function);
    expect(lightning.monitorIncomingPayment).toBeInstanceOf(Function);
  });

  it('should decode a Lightning invoice', async () => {
    const invoice =
      'lntb30m1pw2f2yspp5s59w4a0kjecw3zyexm7zur8l8n4scw674w' +
      '8sftjhwec33km882gsdpa2pshjmt9de6zqun9w96k2um5ypmkjar' +
      'gypkh2mr5d9cxzun5ypeh2ursdae8gxqruyqvzddp68gup69uhnz' +
      'wfj9cejuvf3xshrwde68qcrswf0d46kcarfwpshyaplw3skw0tdw' +
      '4k8g6tsv9e8glzddp68gup69uhnzwfj9cejuvf3xshrwde68qcrs' +
      'wf0d46kcarfwpshyaplw3skw0tdw4k8g6tsv9e8gcqpfmy8keu46' +
      'zsrgtz8sxdym7yedew6v2jyfswg9zeqetpj2yw3f52ny77c5xsrg' +
      '53q9273vvmwhc6p0gucz2av5gtk3esevk0cfhyvzgxgpgyyavt';

    const decoded = lightning.decodeInvoice(invoice);

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
    const invoice = 'lntb30m1invalid';
    expect(() => lightning.decodeInvoice(invoice)).toThrow();
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
