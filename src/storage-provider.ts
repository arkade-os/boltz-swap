import { PendingReverseSwap, PendingSubmarineSwap } from './types';
import * as fs from 'fs/promises';

type KEY = 'reverseSwaps' | 'submarineSwaps';
const KEY_REVERSE_SWAPS: KEY = 'reverseSwaps';
const KEY_SUBMARINE_SWAPS: KEY = 'submarineSwaps';

export type StoredSwaps = {
  reverseSwaps: PendingReverseSwap[];
  submarineSwaps: PendingSubmarineSwap[];
};

interface StorageOptions {
  storagePath?: string;
}

class Storage {
  private storage: any;
  private isBrowser: boolean;
  private storagePath: string;
  private localStorage: any;
  private initPromise?: Promise<void>;

  private constructor(options: StorageOptions = {}) {
    this.storage = null;
    this.storagePath = options.storagePath || './storage.json';
    this.isBrowser =
      typeof globalThis !== 'undefined' &&
      typeof (globalThis as any).window !== 'undefined' &&
      typeof (globalThis as any).window.localStorage !== 'undefined';

    if (this.isBrowser) {
      this.localStorage = (globalThis as any).window.localStorage;
    }
  }

  static async create(options: StorageOptions = {}): Promise<Storage> {
    const storage = new Storage(options);
    if (!storage.isBrowser) await storage.initializeFileStorage();
    return storage;
  }

  async initializeFileStorage() {
    try {
      await fs.access(this.storagePath);
      const data = await fs.readFile(this.storagePath, 'utf8');
      this.storage = JSON.parse(data);
    } catch {
      this.storage = {};
      await this.save();
    }
  }

  async getItem(key: string) {
    if (this.isBrowser) {
      return this.localStorage.getItem(key);
    } else {
      await this.ensureInitialized();
      return this.storage[key] || null;
    }
  }

  async setItem(key: string, value: any) {
    if (this.isBrowser) {
      this.localStorage.setItem(key, value);
    } else {
      await this.ensureInitialized();
      this.storage[key] = value;
      await this.save();
    }
  }

  async removeItem(key: string) {
    if (this.isBrowser) {
      this.localStorage.removeItem(key);
    } else {
      await this.ensureInitialized();
      delete this.storage[key];
      await this.save();
    }
  }

  async clear() {
    if (this.isBrowser) {
      this.localStorage.clear();
    } else {
      await this.ensureInitialized();
      this.storage = {};
      await this.save();
    }
  }

  async save() {
    if (!this.isBrowser) {
      try {
        await fs.writeFile(this.storagePath, JSON.stringify(this.storage, null, 2));
      } catch (error) {
        throw new Error(`Failed to save storage: ${error}`);
      }
    }
  }

  async ensureInitialized() {
    if (!this.isBrowser && !this.storage) {
      if (!this.initPromise) {
        this.initPromise = this.initializeFileStorage();
      }
      await this.initPromise;
    }
  }
}

export class StorageProvider {
  private storageInstance: Storage;
  private storage: StoredSwaps;

  constructor(instance: Storage) {
    this.storageInstance = instance;
    this.storage = {
      reverseSwaps: [],
      submarineSwaps: [],
    };
  }

  static async create(options: StorageOptions = {}): Promise<StorageProvider> {
    const storageInstance = await Storage.create(options);
    const storage = new StorageProvider(storageInstance);
    await storage.initializeStorage();
    return storage;
  }

  getPendingReverseSwaps(): PendingReverseSwap[] {
    return this.storage[KEY_REVERSE_SWAPS] as PendingReverseSwap[];
  }

  async savePendingReverseSwap(swap: PendingReverseSwap): Promise<void> {
    return this.savePendingSwap(KEY_REVERSE_SWAPS, swap);
  }

  async deletePendingReverseSwap(id: string): Promise<void> {
    return this.deletePendingSwap(KEY_REVERSE_SWAPS, id);
  }

  getPendingSubmarineSwaps(): PendingSubmarineSwap[] {
    return this.storage[KEY_SUBMARINE_SWAPS] as PendingSubmarineSwap[];
  }

  async savePendingSubmarineSwap(swap: PendingSubmarineSwap): Promise<void> {
    return this.savePendingSwap(KEY_SUBMARINE_SWAPS, swap);
  }

  async deletePendingSubmarineSwap(id: string): Promise<void> {
    return this.deletePendingSwap(KEY_SUBMARINE_SWAPS, id);
  }

  getSwapHistory() {
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
      const swaps = JSON.parse(item as string);
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
