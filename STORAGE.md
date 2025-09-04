# In-Memory Storage Usage

This document shows how to use the boltz-swap library with different storage options, including the new default in-memory storage.

## Default In-Memory Storage

The simplest way to get started is without specifying any storage provider. The library will automatically use `MemoryStorage`:

```typescript
import { ArkadeLightning, BoltzSwapProvider } from '@arkade-os/boltz-swap';

const lightning = new ArkadeLightning({
  wallet: myWallet,
  swapProvider: new BoltzSwapProvider('https://api.boltz.exchange'),
  arkProvider: myArkProvider,
  indexerProvider: myIndexerProvider
  // No storageProvider needed - MemoryStorage is used by default
});
```

**Note**: MemoryStorage keeps data in memory only. All pending swaps and data will be lost when the application restarts.

## Persistent Storage Options

For production applications that need persistent storage:

### Node.js with FileSystem Storage

```typescript
import { ArkadeLightning, BoltzSwapProvider, StorageProvider, FileSystemStorage } from '@arkade-os/boltz-swap';

const storage = new FileSystemStorage('./swaps.json');
const storageProvider = new StorageProvider(storage);

const lightning = new ArkadeLightning({
  wallet: myWallet,
  swapProvider: new BoltzSwapProvider('https://api.boltz.exchange'),
  arkProvider: myArkProvider,
  indexerProvider: myIndexerProvider,
  storageProvider // Persistent file-based storage
});
```

### Browser with LocalStorage

```typescript
import { ArkadeLightning, BoltzSwapProvider, StorageProvider, BrowserStorage } from '@arkade-os/boltz-swap';

const storage = new BrowserStorage();
const storageProvider = new StorageProvider(storage);

const lightning = new ArkadeLightning({
  wallet: myWallet,
  swapProvider: new BoltzSwapProvider('https://api.boltz.exchange'),
  arkProvider: myArkProvider,
  indexerProvider: myIndexerProvider,
  storageProvider // Persistent browser localStorage
});
```

### React Native with AsyncStorage

```typescript
import { ArkadeLightning, BoltzSwapProvider, StorageProvider, AsyncStorage } from '@arkade-os/boltz-swap';
import RNAsyncStorage from '@react-native-async-storage/async-storage';

const storage = new AsyncStorage(RNAsyncStorage);
const storageProvider = new StorageProvider(storage);

const lightning = new ArkadeLightning({
  wallet: myWallet,
  swapProvider: new BoltzSwapProvider('https://api.boltz.exchange'),
  arkProvider: myArkProvider,
  indexerProvider: myIndexerProvider,
  storageProvider // Persistent React Native storage
});
```

## Custom Storage Implementation

You can also implement your own storage backend by implementing the `Storage` interface:

```typescript
import { Storage } from '@arkade-os/boltz-swap';

class CustomStorage implements Storage {
  async getItem(key: string): Promise<string | null> {
    // Your implementation
  }

  async setItem(key: string, value: string): Promise<void> {
    // Your implementation
  }

  async removeItem(key: string): Promise<void> {
    // Your implementation
  }

  async clear(): Promise<void> {
    // Your implementation
  }
}
```
