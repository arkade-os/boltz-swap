import { describe, it, expect } from 'vitest';
import { MemoryStorage } from '../src/storage';

describe('MemoryStorage', () => {
  it('should store and retrieve values', async () => {
    const storage = new MemoryStorage();
    
    await storage.setItem('key1', 'value1');
    const result = await storage.getItem('key1');
    
    expect(result).toBe('value1');
  });

  it('should return null for non-existent keys', async () => {
    const storage = new MemoryStorage();
    
    const result = await storage.getItem('non-existent');
    
    expect(result).toBe(null);
  });

  it('should remove items', async () => {
    const storage = new MemoryStorage();
    
    await storage.setItem('key1', 'value1');
    await storage.removeItem('key1');
    const result = await storage.getItem('key1');
    
    expect(result).toBe(null);
  });

  it('should clear all items', async () => {
    const storage = new MemoryStorage();
    
    await storage.setItem('key1', 'value1');
    await storage.setItem('key2', 'value2');
    await storage.clear();
    
    const result1 = await storage.getItem('key1');
    const result2 = await storage.getItem('key2');
    
    expect(result1).toBe(null);
    expect(result2).toBe(null);
  });

  it('should overwrite existing values', async () => {
    const storage = new MemoryStorage();
    
    await storage.setItem('key1', 'value1');
    await storage.setItem('key1', 'value2');
    const result = await storage.getItem('key1');
    
    expect(result).toBe('value2');
  });
});
