import { PendingReverseSwap, PendingSubmarineSwap } from './types';
import * as fs from 'fs/promises';

const KEY_REVERSE_SWAPS = 'reverseSwaps';
const KEY_SUBMARINE_SWAPS = 'submarineSwaps';

interface StorageOptions {
  storagePath?: string;
}

class Storage {
  private storage: any;
  private isBrowser: boolean;
  private storagePath: string;
  private localStorage: any;

  constructor(options: StorageOptions = {}) {
    this.storage = null;
    this.storagePath = options.storagePath || './storage.json';
    this.isBrowser =
      typeof globalThis !== 'undefined' &&
      typeof (globalThis as any).window !== 'undefined' &&
      typeof (globalThis as any).window.localStorage !== 'undefined';

    if (this.isBrowser) {
      this.localStorage = (globalThis as any).window.localStorage;
    } else {
      this.initializeFileStorage();
    }
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
      await this.initializeFileStorage();
    }
  }
}

export class StorageProvider {
  private storageInstance: Storage;

  constructor() {
    this.storageInstance = new Storage();
  }

  async savePendingReverseSwap(swapInfo: PendingReverseSwap) {
    return this.savePendingSwap(KEY_REVERSE_SWAPS, swapInfo);
  }

  async deletePendingReverseSwap(id: string) {
    return this.deletePendingSwap(KEY_REVERSE_SWAPS, id);
  }

  async getPendingReverseSwaps(): Promise<PendingReverseSwap[]> {
    return this.getPendingSwaps(KEY_REVERSE_SWAPS) as Promise<PendingReverseSwap[]>;
  }

  async savePendingSubmarineSwap(swapInfo: PendingSubmarineSwap) {
    return this.savePendingSwap(KEY_SUBMARINE_SWAPS, swapInfo);
  }

  async deletePendingSubmarineSwap(id: string) {
    return this.deletePendingSwap(KEY_SUBMARINE_SWAPS, id);
  }

  async getPendingSubmarineSwaps(): Promise<PendingSubmarineSwap[]> {
    return this.getPendingSwaps(KEY_SUBMARINE_SWAPS) as Promise<PendingSubmarineSwap[]>;
  }

  private async deletePendingSwap(kind: string, id: string) {
    const swaps = await this.getPendingSwaps(kind);
    const updatedSwaps = swaps.filter((s) => s.response.id !== id);
    return this.set(kind, updatedSwaps);
  }

  private async getPendingSwaps(kind: string): Promise<PendingSubmarineSwap[] | PendingReverseSwap[]> {
    return (await this.get(kind)) || [];
  }

  private async savePendingSwap(kind: string, swap: PendingSubmarineSwap | PendingReverseSwap) {
    const swaps = await this.getPendingSwaps(kind);
    const found = swaps.findIndex((s) => s.response.id === swap.response.id);
    if (found !== -1) {
      swaps[found].status = swap.status; // Update status
      return this.set(kind, swaps);
    } else {
      return this.set(kind, [...swaps, swap]);
    }
  }

  private async set(key: string, value: any): Promise<void> {
    const val = value ? JSON.stringify(value) : '';
    await this.storageInstance.setItem(key, val);
  }

  private async get(key: string): Promise<any> {
    const item = await this.storageInstance.getItem(key);
    if (!item) return null;
    try {
      return JSON.parse(item as string);
    } catch (error) {
      console.error(`Failed to parse stored data for key ${key}:`, error);
      return null;
    }
  }
}
