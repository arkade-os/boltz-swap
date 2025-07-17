import localForage from 'localforage';
import { CreateInvoiceResult, PayInvoiceResult } from './types';

const KEY_REVERSE_SWAPS = 'reverseSwaps';
const KEY_SUBMARINE_SWAPS = 'submarineSwaps';

export class StorageManager {
  private storageInstance: any;

  constructor() {
    this.storageInstance = localForage.createInstance({
      name: 'arkade-lightning',
      storeName: 'arkade-lightning-store',
      driver: [localForage.INDEXEDDB, localForage.LOCALSTORAGE],
      version: 1.0,
      description: 'Arkade lightning pkg storage',
    });
  }

  async saveReverseSwap(swapInfo: CreateInvoiceResult) {
    return this.saveSwap(KEY_REVERSE_SWAPS, swapInfo);
  }

  async deleteReverseSwap(swapInfo: CreateInvoiceResult) {
    return this.deleteSwaps(KEY_REVERSE_SWAPS, swapInfo);
  }

  async getReverseSwaps(): Promise<CreateInvoiceResult[]> {
    return this.getSwaps(KEY_REVERSE_SWAPS) as Promise<CreateInvoiceResult[]>;
  }

  async saveSubmarineSwap(swapInfo: PayInvoiceResult) {
    return this.saveSwap(KEY_SUBMARINE_SWAPS, swapInfo);
  }

  async deleteSubmarineSwap(swapInfo: PayInvoiceResult) {
    return this.deleteSwaps(KEY_SUBMARINE_SWAPS, swapInfo);
  }

  async getSubmarineSwaps(): Promise<PayInvoiceResult[]> {
    return this.getSwaps(KEY_SUBMARINE_SWAPS) as Promise<PayInvoiceResult[]>;
  }

  private async deleteSwaps(kind: string, swap: PayInvoiceResult | CreateInvoiceResult) {
    const swaps = await this.getSwaps(kind);
    const updatedSwaps = swaps.filter((s) => s.swapInfo.id !== swap.swapInfo.id);
    return this.set(kind, updatedSwaps);
  }

  private async getSwaps(kind: string): Promise<PayInvoiceResult[] | CreateInvoiceResult[]> {
    return this.get(kind) || [];
  }

  private async saveSwap(kind: string, swap: CreateInvoiceResult | PayInvoiceResult) {
    const swaps = await this.getSwaps(kind);
    const updatedSwaps = swaps.find((s) => s.swapInfo.id === swap.swapInfo.id)
      ? swaps.map((s) => (s.swapInfo.id === swap.swapInfo.id ? swap : s))
      : [...swaps, swap];
    return this.set(kind, updatedSwaps);
  }

  private async set(key: string, value: any): Promise<void> {
    const val = value ? JSON.stringify(value) : '';
    await this.storageInstance.setItem(key, val);
  }

  private async get(key: string): Promise<any> {
    const item = await this.storageInstance.getItem(key);
    return item ? JSON.parse(item) : null;
  }
}

export const storage = new StorageManager();
