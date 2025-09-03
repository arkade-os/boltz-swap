import { Storage } from './interface';

/**
 * Browser localStorage implementation
 */
export class BrowserStorage implements Storage {
  private localStorage: any;

  constructor() {
    if (typeof globalThis === 'undefined' || 
        typeof (globalThis as any).window === 'undefined' || 
        typeof (globalThis as any).window.localStorage === 'undefined') {
      throw new Error('localStorage is not available in this environment');
    }
    this.localStorage = (globalThis as any).window.localStorage;
  }

  async getItem(key: string): Promise<string | null> {
    try {
      return this.localStorage.getItem(key);
    } catch (error) {
      console.error('Error getting item from localStorage:', error);
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    try {
      this.localStorage.setItem(key, value);
    } catch (error) {
      throw new Error(`Failed to set item in localStorage: ${error}`);
    }
  }

  async removeItem(key: string): Promise<void> {
    try {
      this.localStorage.removeItem(key);
    } catch (error) {
      console.error('Error removing item from localStorage:', error);
    }
  }

  async clear(): Promise<void> {
    try {
      this.localStorage.clear();
    } catch (error) {
      console.error('Error clearing localStorage:', error);
    }
  }
}
