import { Storage } from './interface';
import * as fs from 'fs/promises';

/**
 * File system storage implementation for Node.js environments
 */
export class FileSystemStorage implements Storage {
  private storage: Record<string, any> = {};
  private initPromise: Promise<void> | null = null;

  constructor(private storagePath: string = './storage.json') {}

  private async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    
    this.initPromise = (async () => {
      try {
        await fs.access(this.storagePath);
        const data = await fs.readFile(this.storagePath, 'utf8');
        this.storage = JSON.parse(data);
      } catch {
        // File doesn't exist or is corrupted, start with empty storage
        this.storage = {};
        await this.save();
      }
    })();
    
    return this.initPromise;
  }

  async getItem(key: string): Promise<string | null> {
    await this.initialize();
    return this.storage[key] || null;
  }

  async setItem(key: string, value: string): Promise<void> {
    await this.initialize();
    this.storage[key] = value;
    await this.save();
  }

  async removeItem(key: string): Promise<void> {
    await this.initialize();
    delete this.storage[key];
    await this.save();
  }

  async clear(): Promise<void> {
    await this.initialize();
    this.storage = {};
    await this.save();
  }

  private async save(): Promise<void> {
    try {
      await fs.writeFile(this.storagePath, JSON.stringify(this.storage, null, 2));
    } catch (error) {
      throw new Error(`Failed to save storage: ${error}`);
    }
  }
}
