import { PendingReverseSwap, PendingSubmarineSwap } from './types';
import { Storage } from './storage';

type KEY = 'reverseSwaps' | 'submarineSwaps';
const KEY_REVERSE_SWAPS: KEY = 'reverseSwaps';
const KEY_SUBMARINE_SWAPS: KEY = 'submarineSwaps';

export type StoredSwaps = {
  reverseSwaps: PendingReverseSwap[];
  submarineSwaps: PendingSubmarineSwap[];
};

export class StorageProvider {
  private storageInstance: Storage;
  private storage: StoredSwaps = {
    reverseSwaps: [],
    submarineSwaps: [],
  };
  private initPromise: Promise<void> | null = null;

  constructor(storageInstance: Storage) {
    this.storageInstance = storageInstance;
  }

  private async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    
    this.initPromise = this.initializeStorage();
    return this.initPromise;
  }

  async getPendingReverseSwaps(): Promise<PendingReverseSwap[]> {
    await this.initialize();
    return this.storage[KEY_REVERSE_SWAPS] as PendingReverseSwap[];
  }

  async savePendingReverseSwap(swap: PendingReverseSwap): Promise<void> {
    await this.initialize();
    return this.savePendingSwap(KEY_REVERSE_SWAPS, swap);
  }

  async deletePendingReverseSwap(id: string): Promise<void> {
    await this.initialize();
    return this.deletePendingSwap(KEY_REVERSE_SWAPS, id);
  }

  async getPendingSubmarineSwaps(): Promise<PendingSubmarineSwap[]> {
    await this.initialize();
    return this.storage[KEY_SUBMARINE_SWAPS] as PendingSubmarineSwap[];
  }

  async savePendingSubmarineSwap(swap: PendingSubmarineSwap): Promise<void> {
    await this.initialize();
    return this.savePendingSwap(KEY_SUBMARINE_SWAPS, swap);
  }

  async deletePendingSubmarineSwap(id: string): Promise<void> {
    await this.initialize();
    return this.deletePendingSwap(KEY_SUBMARINE_SWAPS, id);
  }

  async getSwapHistory(): Promise<(PendingReverseSwap | PendingSubmarineSwap)[]> {
    await this.initialize();
    const reverseSwaps = this.storage[KEY_REVERSE_SWAPS] as PendingReverseSwap[];
    const submarineSwaps = this.storage[KEY_SUBMARINE_SWAPS] as PendingSubmarineSwap[];
    return [...reverseSwaps, ...submarineSwaps].sort((a, b) => {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }

  private async savePendingSwap(kind: KEY, swap: PendingReverseSwap | PendingSubmarineSwap): Promise<void> {
    const swaps = this.storage[kind] as PendingReverseSwap[] | PendingSubmarineSwap[];
    const found = swaps.findIndex((s) => s.response.id === swap.response.id);
    if (found !== -1) {
      swaps[found] = swap; // Update swap
    } else {
      if (kind === KEY_REVERSE_SWAPS) {
        (swaps as PendingReverseSwap[]).push(swap as PendingReverseSwap);
      }
      if (kind === KEY_SUBMARINE_SWAPS) {
        (swaps as PendingSubmarineSwap[]).push(swap as PendingSubmarineSwap);
      }
    }
    await this.setSwaps(kind, swaps);
  }

  private async deletePendingSwap(kind: KEY, id: string): Promise<void> {
    const swaps = this.storage[kind] as PendingReverseSwap[] | PendingSubmarineSwap[];
    const updatedSwaps = swaps.filter((s) => s.response.id !== id);
    if (kind === KEY_REVERSE_SWAPS) {
      await this.setSwaps(kind, updatedSwaps as PendingReverseSwap[]);
    } else if (kind === KEY_SUBMARINE_SWAPS) {
      await this.setSwaps(kind, updatedSwaps as PendingSubmarineSwap[]);
    }
  }

  private async setSwaps(kind: KEY, swaps: PendingReverseSwap[] | PendingSubmarineSwap[]): Promise<void> {
    this.storage = { ...this.storage, [kind]: swaps };
    await this.set(kind, swaps);
  }

  private async set(kind: KEY, swaps: PendingReverseSwap[] | PendingSubmarineSwap[]): Promise<void> {
    const val = swaps ? JSON.stringify(swaps) : '';
    await this.storageInstance.setItem(kind, val);
  }

  private async get(kind: KEY): Promise<PendingReverseSwap[] | PendingSubmarineSwap[]> {
    const item = await this.storageInstance.getItem(kind);
    if (!item) return [];
    try {
      const swaps = JSON.parse(item);
      return swaps as PendingReverseSwap[] | PendingSubmarineSwap[];
    } catch (error) {
      console.error(`Failed to parse stored data for key ${kind}:`, error);
      return [];
    }
  }

  private async initializeStorage(): Promise<void> {
    try {
      this.storage = {
        reverseSwaps: (await this.get(KEY_REVERSE_SWAPS)) as PendingReverseSwap[],
        submarineSwaps: (await this.get(KEY_SUBMARINE_SWAPS)) as PendingSubmarineSwap[],
      };
    } catch (error) {
      console.error('Failed to initialize storage:', error);
      this.storage = {
        reverseSwaps: [],
        submarineSwaps: [],
      };
    }
  }
}
