# Lightning Swaps

> Integrate Lightning Network with Arkade using Submarine Swaps

Arkade provides seamless integration with the Lightning Network through Boltz submarine swaps, allowing users to move funds between Arkade and Lightning channels.

## Overview

The `BoltzSwapProvider` library extends Arkade's functionality by enabling:

1. **Lightning to Arkade swaps** - Receive funds from Lightning payments into your Arkade wallet
2. **Arkade to Lightning swaps** - Send funds from your Arkade wallet to Lightning invoices

This integration is built on top of the Boltz submarine swap protocol, providing a reliable and secure way to bridge the gap between Arkade and the Lightning Network.

## Installation

```bash
npm install @arkade-os/sdk @arkade-os/boltz-swap
```

## Quick Start

### Simple Setup (No Persistence)

For testing and development, you can get started quickly without configuring storage. Swap data will be kept in memory only:

```typescript
import { Wallet } from '@arkade-os/sdk';
import { ArkadeLightning, BoltzSwapProvider } from '@arkade-os/boltz-swap';

// Initialize your Arkade wallet
const wallet = await Wallet.create({
  identity,
  arkServerUrl: 'https://mutinynet.arkade.sh',
});

// Initialize the Lightning swap provider
const swapProvider = new BoltzSwapProvider({
  apiUrl: 'https://api.boltz.mutinynet.arkade.sh',
  network: 'mutinynet',
});

// Create the ArkadeLightning instance (uses in-memory storage by default)
const arkadeLightning = new ArkadeLightning({
  wallet,
  swapProvider,
});
```

### Production Setup (With Persistent Storage)

For production applications, configure storage to persist swap state across restarts:

```typescript
import { ArkadeLightning, BoltzSwapProvider, FileSystemStorage, StorageProvider } from '@arkade-os/boltz-swap';

// Choose storage based on your environment:
const storage = new FileSystemStorage('./swaps.json');           // Node.js
// const storage = new BrowserStorage();                         // Web browsers  
// const storage = new AsyncStorage(AsyncStorageLib);            // React Native

const storageProvider = new StorageProvider(storage);

const arkadeLightning = new ArkadeLightning({
  wallet,
  swapProvider,
  storageProvider, // Persist swaps across restarts
});
```

```

## Receiving Lightning Payments

To receive a Lightning payment into your Arkade wallet:

```typescript
// Create a Lightning invoice that will deposit funds to your Arkade wallet
const result = await arkadeLightning.createLightningInvoice({
  amount: 50000, // 50,000 sats
  description: 'Payment to my Arkade wallet',
});

console.log('Receive amount:', result.amount);
console.log('Expiry (seconds):', result.expiry);
console.log('Lightning Invoice:', result.invoice);
console.log('Payment Hash:', result.paymentHash);
console.log('Pending swap', result.pendingSwap);
console.log('Preimage', result.preimage);

// The invoice can now be shared with the payer
// When paid, funds will appear in your Arkade wallet
```

### Monitoring Incoming Lightning Payments

You must monitor the status of incoming Lightning payments.
It will automatically claim the payment when it's available.

```typescript
// Monitor the payment, it will resolve when the payment is received
const receivalResult = await arkadeLightning.waitAndClaim(result.pendingSwap);
console.log('Receival successful!');
console.log('Transaction ID:', receivalResult.txid);
```

## Sending Lightning Payments

To send a payment from your Arkade wallet to a Lightning invoice:

```typescript
import { decodeInvoice } from '@arkade-os/boltz-swap';

// Parse a Lightning invoice
const invoiceDetails = decodeInvoice(
  'lnbc500u1pj...' // Lightning invoice string
);

console.log('Invoice amount:', invoiceDetails.amountSats, 'sats');
console.log('Description:', invoiceDetails.description);
console.log('Payment Hash:', invoiceDetails.paymentHash);

// Pay the Lightning invoice from your Arkade wallet
const paymentResult = await arkadeLightning.sendLightningPayment({
  invoice: 'lnbc500u1pj...', // Lightning invoice string
  maxFeeSats: 1000, // Optional: Maximum fee you're willing to pay (in sats)
});

console.log('Payment successful!');
console.log('Amount:', paymentResult.amount);
console.log('Preimage:', paymentResult.preimage);
console.log('Transaction ID:', paymentResult.txid);
```

## Error Handling

The library provides detailed error types to help you handle different failure scenarios:

```typescript
import {
  SwapError,
  SchemaError,
  NetworkError,
  SwapExpiredError,
  InvoiceExpiredError,
  InvoiceFailedToPayError,
  InsufficientFundsError,
  TransactionFailedError,
  decodeInvoice,
} from '@arkade-os/boltz-swap';

try {
  await arkadeLightning.sendLightningPayment({
    invoice: 'lnbc500u1pj...',
  });
} catch (error) {
  if (error instanceof InvoiceExpiredError) {
    console.error('The invoice has expired. Please request a new one.');
  } else if (error instanceof InvoiceFailedToPayError) {
    console.error('The provider failed to pay the invoice. Please request a new one.');
  } else if (error instanceof InsufficientFundsError) {
    console.error('Not enough funds available:', error.message);
  } else if (error instanceof NetworkError) {
    console.error('Network issue. Please try again later:', error.message);
  } else if (error instanceof SchemaError) {
    console.error('Invalid response from API. Please try again later.');
  } else if (error instanceof SwapExpiredError) {
    console.error('The swap has expired. Please request a new invoice.');
  } else if (error instanceof SwapError) {
    console.error('Swap failed:', error.message);
  } else if (error instanceof TransactionFailedError) {
    console.error('Transaction failed. Please try again later');
  } else {
    console.error('Unknown error:', error);
  }

  // You might be able to claim a refund
  if (error.isRefundable && error.pendingSwap) {
    const refundResult = await arkadeLightning.refundVHTLC(error.pendingSwap);
    console.log('Refund claimed:', refundResult.txid);
  }
}
```

---

## Advanced Configuration

<details>
<summary><strong>Storage Configuration</strong></summary>

By default, this library uses in-memory storage (swaps are lost on restart). For production applications, you should configure persistent storage.

### Storage Implementations

The library provides three storage implementations for different environments:

#### File System Storage (Node.js)

For Node.js applications, use `FileSystemStorage` to persist swaps to a JSON file:

```typescript
import { ArkadeLightning, FileSystemStorage, StorageProvider } from '@arkade-os/boltz-swap';

// Create file system storage
const storage = new FileSystemStorage('./my-swaps.json');
const storageProvider = new StorageProvider(storage);

// Create ArkadeLightning instance with storage
const arkadeLightning = new ArkadeLightning({
  wallet,
  swapProvider,
  storageProvider,
});
```

#### Browser Storage (Web Applications)

For web applications, use `BrowserStorage` to persist swaps in localStorage:

```typescript
import { ArkadeLightning, BrowserStorage, StorageProvider } from '@arkade-os/boltz-swap';

// Create browser storage (uses localStorage)
const storage = new BrowserStorage();
const storageProvider = new StorageProvider(storage);

// Create ArkadeLightning instance with storage
const arkadeLightning = new ArkadeLightning({
  wallet,
  swapProvider,
  storageProvider,
});
```

#### React Native / Expo Storage

For React Native or Expo applications, use `AsyncStorage`. You'll need to install the AsyncStorage package:

```bash
npm install @react-native-async-storage/async-storage
```

```typescript
import AsyncStorageLib from '@react-native-async-storage/async-storage';
import { ArkadeLightning, AsyncStorage, StorageProvider } from '@arkade-os/boltz-swap';

// Create AsyncStorage instance
const storage = new AsyncStorage(AsyncStorageLib);
const storageProvider = new StorageProvider(storage);

// Create ArkadeLightning instance with storage
const arkadeLightning = new ArkadeLightning({
  wallet,
  swapProvider,
  storageProvider,
});
```

### Custom Storage Implementation

You can also create your own storage implementation by implementing the `Storage` interface:

```typescript
import { Storage } from '@arkade-os/boltz-swap';

class MyCustomStorage implements Storage {
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

// Use your custom storage
const storage = new MyCustomStorage();
const storageProvider = new StorageProvider(storage);
const arkadeLightning = new ArkadeLightning({
  wallet,
  swapProvider,
  storageProvider,
});
```

### Accessing Stored Swaps

When storage is configured, you can access pending and completed swaps. **Note:** These methods are async because they interact with storage:

```typescript
// Get pending submarine swaps (Arkade → Lightning payments)
const pendingPaymentsToLightning = await arkadeLightning.getPendingSubmarineSwaps();

// Get pending reverse swaps (Lightning → Arkade payments)  
const pendingPaymentsFromLightning = await arkadeLightning.getPendingReverseSwaps();

// Get complete swap history (sorted by creation date)
const swapHistory = await arkadeLightning.getSwapHistory();

console.log('Pending Lightning payments:', pendingPaymentsToLightning);
console.log('Pending Arkade receipts:', pendingPaymentsFromLightning);
console.log('All swap history:', swapHistory);
```

### Storage Operations Are Async

**Important:** All operations that read from or write to storage are asynchronous.

</details>

<details>
<summary><strong>Wallet Compatibility</strong></summary>

This library supports both wallet interface patterns:

### Wallet (with optional nested identity and providers)

```typescript
import { Wallet } from '@arkade-os/sdk';

const wallet = await Wallet.create({
  identity,
  arkServerUrl: 'https://mutinynet.arkade.sh',
});

// Wallet may have built-in providers
const arkadeLightning = new ArkadeLightning({
  wallet,
  swapProvider,
  // arkProvider and indexerProvider can be provided here if wallet doesn't have them
  // storageProvider can be added for persistence
});
```

### ServiceWorkerWallet (legacy interface)

```typescript
import { RestArkProvider, RestIndexerProvider } from '@arkade-os/sdk';

// ServiceWorkerWallet has identity methods spread directly (no nested identity)
const serviceWorkerWallet = new ServiceWorkerWallet(serviceWorker);
await serviceWorkerWallet.init({
  privateKey: 'your_private_key_hex',
  arkServerUrl: 'https://ark.example.com'
});

// Must provide external providers for ServiceWorkerWallet (it doesn't have them)
const arkadeLightning = new ArkadeLightning({
  wallet: serviceWorkerWallet,
  arkProvider: new RestArkProvider('https://ark.example.com'),
  indexerProvider: new RestIndexerProvider('https://indexer.example.com'),
  swapProvider,
  // storageProvider can be added for persistence
});
```

</details>
