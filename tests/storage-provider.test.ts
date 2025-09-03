import { describe, it, expect, beforeEach } from 'vitest';
import { CreateSubmarineSwapRequest, CreateSubmarineSwapResponse } from '../src/boltz-swap-provider';
import { StorageProvider } from '../src/storage-provider';
import { FileSystemStorage } from '../src/storage';

describe('Storage provider', () => {
  const storage = new FileSystemStorage('./test-storage.json');
  const storageProvider = new StorageProvider(storage);

  describe('submarine swaps', () => {
    // mock request and response
    const mockRequest: CreateSubmarineSwapRequest = {
      invoice: 'mock-invoice',
      refundPublicKey: 'mock-refundPublicKey',
    };
    const mockResponse: CreateSubmarineSwapResponse = {
      id: 'mock-submarine-swap-id',
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

    it('should store a pending submarine swap', async () => {
      // save swap
      await storageProvider.savePendingSubmarineSwap({
        type: 'submarine',
        createdAt: Date.now(),
        request: mockRequest,
        response: mockResponse,
        status: 'swap.created',
      });
      // get swaps
      const swaps = await storageProvider.getPendingSubmarineSwaps();
      expect(swaps.length).toBeGreaterThan(0);
      // find saved swap
      const found = swaps.find((s) => s.response.id === mockResponse.id);
      // assert
      expect(found).toBeDefined();
      expect(found?.request.invoice).toBe('mock-invoice');
      expect(found?.request.refundPublicKey).toBe(mockRequest.refundPublicKey);
      expect(found?.response.id).toBe(mockResponse.id);
      expect(found?.status).toBe('swap.created');
    });

    it('should update a pending submarine swap', async () => {
      // get pending swaps
      const swaps = await storageProvider.getPendingSubmarineSwaps();
      expect(swaps.length).toBeGreaterThan(0);
      // find swap to delete
      const swapToUpdate = swaps.find((s) => s.response.id === mockResponse.id);
      expect(swapToUpdate).toBeDefined();
      // update swap
      await storageProvider.savePendingSubmarineSwap({ ...swapToUpdate!, status: 'transaction.claimed' });
      // verify swap is updated
      const updateSwaps = await storageProvider.getPendingSubmarineSwaps();
      expect(updateSwaps.length).toBe(swaps.length);
      const updatedSwap = updateSwaps.find((s) => s.response.id === swapToUpdate!.response.id);
      expect(updatedSwap?.status).toBe('transaction.claimed');
    });

    it('should remove a pending submarine swap', async () => {
      // get pending swaps
      const swaps = await storageProvider.getPendingSubmarineSwaps();
      expect(swaps.length).toBeGreaterThan(0);
      // find swap to delete
      const swapToDelete = swaps.find((s) => s.response.id === mockResponse.id);
      expect(swapToDelete).toBeDefined();
      // delete swap
      await storageProvider.deletePendingSubmarineSwap(swapToDelete!.response.id);
      // verify swap is deleted
      const updateSwaps = await storageProvider.getPendingSubmarineSwaps();
      expect(updateSwaps.length).toBe(swaps.length - 1);
      const deletedSwap = updateSwaps.find((s) => s.response.id === swapToDelete!.response.id);
      expect(deletedSwap).toBeUndefined();
    });
  });

  describe('reverse swaps', () => {
    // mock request and response
    const mockRequest = {
      invoiceAmount: 21000,
      claimPublicKey: 'mock-claimPublicKey',
      preimageHash: 'mock-preimage-hash',
    };
    const mockResponse = {
      id: 'mock-reverse-swap-id',
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

    it('should store a reverse swap', async () => {
      // save swap
      await storageProvider.savePendingReverseSwap({
        type: 'reverse',
        createdAt: Date.now(),
        preimage: 'mock-preimage',
        request: mockRequest,
        response: mockResponse,
        status: 'swap.created',
      });
      // get swaps
      const swaps = await storageProvider.getPendingReverseSwaps();
      expect(swaps.length).toBeGreaterThan(0);
      // find saved swap
      const found = swaps.find((s) => s.response.id === mockResponse.id);
      expect(found).toBeDefined();
      // assert
      expect(found?.preimage).toBe('mock-preimage');
      expect(found?.request.preimageHash).toBe(mockRequest.preimageHash);
      expect(found?.request.claimPublicKey).toBe(mockRequest.claimPublicKey);
      expect(found?.response.id).toBe(mockResponse.id);
      expect(found?.status).toBe('swap.created');
    });

    it('should update a pending reverse swap', async () => {
      // get pending swaps
      const swaps = await storageProvider.getPendingReverseSwaps();
      expect(swaps.length).toBeGreaterThan(0);
      // find swap to delete
      const swapToUpdate = swaps.find((s) => s.response.id === mockResponse.id);
      expect(swapToUpdate).toBeDefined();
      // update swap
      await storageProvider.savePendingReverseSwap({ ...swapToUpdate!, status: 'invoice.settled' });
      // verify swap is updated
      const updateSwaps = await storageProvider.getPendingReverseSwaps();
      expect(updateSwaps.length).toBe(swaps.length);
      const updatedSwap = updateSwaps.find((s) => s.response.id === swapToUpdate!.response.id);
      expect(updatedSwap?.status).toBe('invoice.settled');
    });

    it('should remove a pending reverse swap', async () => {
      // get pending swaps
      const swaps = await storageProvider.getPendingReverseSwaps();
      expect(swaps.length).toBeGreaterThan(0);
      // find swap to delete
      const swapToDelete = swaps.find((s) => s.response.id === mockResponse.id);
      expect(swapToDelete).toBeDefined();
      // delete swap
      await storageProvider.deletePendingReverseSwap(swapToDelete!.response.id);
      // verify swap is deleted
      const updateSwaps = await storageProvider.getPendingReverseSwaps();
      expect(updateSwaps.length).toBe(swaps.length - 1);
      // verify deleted swap
      const deletedSwap = updateSwaps.find((s) => s.response.id === swapToDelete!.response.id);
      expect(deletedSwap).toBeUndefined();
    });
  });
});
