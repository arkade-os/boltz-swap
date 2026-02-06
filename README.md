# Boltz Swaps

## Overview

The `BoltzSwapProvider` library extends Arkade's functionality by enabling:

1. **Lightning to Arkade swaps** - Receive funds from Lightning payments into your Arkade wallet
2. **Arkade to Lightning swaps** - Send funds from your Arkade wallet to Lightning invoices
3. **Bitcoin to Arkade swaps** - Receive funds from Bitcoin into your Arkade wallet
4. **Arkade to Bitcoin swaps** - Send funds from your Arkade wallet to a BTC address

## Installation

```bash
npm install @arkade-os/sdk @arkade-os/boltz-swap
```

## Lightning swaps

### Initializing the Lightning Swap Provider

```typescript
import { Wallet, SingleKey } from '@arkade-os/sdk';
import { ArkadeLightning, BoltzSwapProvider } from '@arkade-os/boltz-swap';

// Create an identity
const identity = SingleKey.fromHex('your_private_key_in_hex');

// Initialize your Arkade wallet
const wallet = await Wallet.create({
  identity,
  arkServerUrl: 'https://mutinynet.arkade.sh',
});

// Initialize the Lightning swap provider
const swapProvider = new BoltzSwapProvider({
  apiUrl: 'https://api.boltz.mutinynet.arkade.sh',
  network: 'mutinynet',
  referralId: 'arkade', // optional
});

// Create the ArkadeLightning instance
const arkadeLightning = new ArkadeLightning({
  wallet,
  swapProvider,
  // Optional: enable SwapManager with defaults
  // swapManager: true,
});
```

### ServiceWorkerWallet with IndexDB

```typescript
import { ServiceWorkerWallet, SingleKey, RestArkProvider, RestIndexerProvider } from '@arkade-os/sdk';
import { IndexedDBStorageAdapter } from '@arkade-os/sdk/storage';

// Create your identity
const identity = SingleKey.fromHex('your_private_key_hex');
// Or generate a new one:
// const identity = SingleKey.fromRandomBytes();

// Configure IndexedDB storage adapter for ServiceWorker
const storage = new IndexedDBStorageAdapter('arkade-service-worker-wallet', 1);

const wallet = await ServiceWorkerWallet.setup({
  serviceWorkerPath: '/service-worker.js',
  arkServerUrl: 'https://mutinynet.arkade.sh',
  identity,
  storage, // Pass the IndexedDB storage adapter
});

// Must provide external providers for ServiceWorkerWallet (it doesn't have them)
const arkadeLightning = new ArkadeLightning({
  wallet: serviceWorkerWallet,
  arkProvider: new RestArkProvider('https://mutinynet.arkade.sh'),
  indexerProvider: new RestIndexerProvider('https://mutinynet.arkade.sh'),
  swapProvider,
});
```

**Storage Adapters**: The Arkade SDK provides various storage adapters for different environments. For ServiceWorker environments, use `IndexedDBStorageAdapter`. For more storage options and adapters, see the [Arkade SDK storage adapters documentation](https://github.com/arkade-os/ts-sdk).


### Checking Swap Limits

Before creating Lightning invoices or sending payments, you can check the minimum and maximum swap amounts supported by the Boltz service. This is useful to validate that your invoice amount is within the acceptable range.

```typescript
// Get current swap limits (in satoshis)
const limits = await arkadeLightning.getLimits();

if (limits) {
  console.log('Minimum swap amount:', limits.min, 'sats');
  console.log('Maximum swap amount:', limits.max, 'sats');

  // Example: Validate invoice amount before creating
  const invoiceAmount = 50000; // 50,000 sats

  if (invoiceAmount < limits.min) {
    console.error(`Amount ${invoiceAmount} is below minimum ${limits.min} sats`);
  } else if (invoiceAmount > limits.max) {
    console.error(`Amount ${invoiceAmount} is above maximum ${limits.max} sats`);
  } else {
    console.log('Amount is within valid range');
    // Safe to proceed with creating invoice or payment
  }
} else {
  console.log('Unable to fetch limits - no swap provider configured');
}
```

### Checking Swap fees

You can check the fee to pay for different swap amounts supported by the Boltz service.
This is useful to validate the user is willing to pay the fees.

```typescript
// Get current swap fees
const fees: FeesResponse | null = await arkadeLightning.getFees();
if (!fees) throw new Error('something went wrong');

const calcSubmarineSwapFee = (satoshis: number): number => {
  if (!satoshis) return 0;
  const { percentage, minerFees } = fees.submarine;
  return Math.ceil((satoshis * percentage) / 100 + minerFees);
};

const calcReverseSwapFee = (satoshis: number): number => {
  if (!satoshis) return 0;
  const { percentage, minerFees } = fees.reverse;
  return Math.ceil((satoshis * percentage) / 100 + minerFees.claim + minerFees.lockup);
};
```

### Receiving Lightning Payments

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

**With SwapManager (recommended):**
```typescript
// SwapManager handles monitoring and claiming automatically
// Just listen to events for UI updates
const result = await arkadeLightning.createLightningInvoice({ amount: 50000 });
// Payment will be claimed automatically when received 
```

**Without SwapManager (manual mode):**
```typescript
// You must manually monitor - blocks until payment is received
const receivalResult = await arkadeLightning.waitAndClaim(result.pendingSwap);
console.log('Receival successful!');
console.log('Transaction ID:', receivalResult.txid);
// ⚠️ User must stay on this page - navigating away stops monitoring
```

### Sending Lightning Payments

**With SwapManager (recommended):**
```typescript
import { decodeInvoice } from '@arkade-os/boltz-swap';

// Validate invoice first
const invoiceDetails = decodeInvoice('lnbc500u1pj...');
console.log('Invoice amount:', invoiceDetails.amountSats, 'sats');

// Send payment - returns immediately after creating swap
const paymentResult = await arkadeLightning.sendLightningPayment({
  invoice: 'lnbc500u1pj...',
});

console.log('Payment initiated:', paymentResult.txid);
// SwapManager monitors in background and handles refunds if payment fails
```

**Without SwapManager (manual mode):**
```typescript
// Blocks until payment completes or fails
const paymentResult = await arkadeLightning.sendLightningPayment({
  invoice: 'lnbc500u1pj...',
});

console.log('Payment successful!');
console.log('Amount:', paymentResult.amount);
console.log('Preimage:', paymentResult.preimage);
console.log('Transaction ID:', paymentResult.txid);
// ⚠️ If payment fails, you must manually handle refund (see Error Handling)
```

### Checking Swap Status

**With SwapManager:** Status updates are automatic via events - no manual checking needed.

**Without SwapManager (manual mode):**
```typescript
const response = await arkadeLightning.getSwapStatus('swap_id');
console.log('swap status = ', response.status);
```

### Storage

This library automatically stores pending swaps using the wallet's built-in contract repository. All swap data is persisted automatically and can be retrieved using the following methods:

```typescript
// Get all pending submarine swaps (those waiting for Lightning payment)
const pendingPaymentsToLightning = await arkadeLightning.getPendingSubmarineSwaps();

// Get all pending reverse swaps (those waiting for claim)
const pendingPaymentsFromLightning = await arkadeLightning.getPendingReverseSwaps();

// Get complete swap history (both completed and pending)
const swapHistory = await arkadeLightning.getSwapHistory();
```

**Note**: All swap data is automatically persisted and retrieved through the wallet's contract repository. No additional storage configuration is required.

### Cleanup (Disposable Pattern)

ArkadeLightning implements the Disposable pattern for automatic cleanup:

```typescript
// Option 1: Manual cleanup
const arkadeLightning = new ArkadeLightning({ wallet, swapProvider });
// ... use it
await arkadeLightning.dispose(); // Stops SwapManager and cleans up

// Option 2: Automatic cleanup with `await using` (TypeScript 5.2+)
{
  await using arkadeLightning = new ArkadeLightning({
    wallet,
    swapProvider,
    swapManager: { autoStart: true },
  });

  // Use arkadeLightning...

} // SwapManager automatically stopped when scope exits
```

## Chain swaps

### Initializing the Chain Swap Provider

```typescript
import { Wallet, SingleKey } from '@arkade-os/sdk';
import { ArkadeChainSwap, BoltzSwapProvider } from '@arkade-os/boltz-swap';

// Create an identity
const identity = SingleKey.fromHex('your_private_key_in_hex');

// Initialize your Arkade wallet
const wallet = await Wallet.create({
  identity,
  arkServerUrl: 'https://mutinynet.arkade.sh',
});

// Initialize the chain swap provider
const swapProvider = new BoltzSwapProvider({
  apiUrl: 'https://api.boltz.mutinynet.arkade.sh',
  network: 'mutinynet',
  referralId: 'arkade', // optional
});

// Create the ArkadeChainSwap instance
const arkadeChainSwap = new ArkadeChainSwap({
  wallet,
  swapProvider,
  // Optional: enable SwapManager with defaults
  // swapManager: true,
});
```


### ServiceWorkerWallet with IndexDB

```typescript
import { ServiceWorkerWallet, SingleKey, RestArkProvider, RestIndexerProvider } from '@arkade-os/sdk';
import { IndexedDBStorageAdapter } from '@arkade-os/sdk/storage';

// Create your identity
const identity = SingleKey.fromHex('your_private_key_hex');
// Or generate a new one:
// const identity = SingleKey.fromRandomBytes();

// Configure IndexedDB storage adapter for ServiceWorker
const storage = new IndexedDBStorageAdapter('arkade-service-worker-wallet', 1);

const wallet = await ServiceWorkerWallet.setup({
  serviceWorkerPath: '/service-worker.js',
  arkServerUrl: 'https://mutinynet.arkade.sh',
  identity,
  storage, // Pass the IndexedDB storage adapter
});

// Must provide external providers for ServiceWorkerWallet (it doesn't have them)
const arkadeChainSwap = new ArkadeChainSwap({
  wallet: serviceWorkerWallet,
  arkProvider: new RestArkProvider('https://mutinynet.arkade.sh'),
  indexerProvider: new RestIndexerProvider('https://mutinynet.arkade.sh'),
  swapProvider,
});
```

**Storage Adapters**: The Arkade SDK provides various storage adapters for different environments. For ServiceWorker environments, use `IndexedDBStorageAdapter`. For more storage options and adapters, see the [Arkade SDK storage adapters documentation](https://github.com/arkade-os/ts-sdk).


### Checking swap limits

Before creating chain swaps, you can check the minimum and maximum swap amounts supported by the Boltz service. This is useful to validate that your payment amount is within the acceptable range.

```typescript
// Get current swap limits (in satoshis)
const limits = await arkadeChainSwap.getLimits('ARK', 'BTC');

if (limits) {
  console.log('Minimum swap amount:', limits.min, 'sats');
  console.log('Maximum swap amount:', limits.max, 'sats');

  // Example: Validate swap amount before creating
  const swapAmount = 50000; // 50,000 sats

  if (swapAmount < limits.min) {
    console.error(`Amount ${swapAmount} is below minimum ${limits.min} sats`);
  } else if (swapAmount > limits.max) {
    console.error(`Amount ${swapAmount} is above maximum ${limits.max} sats`);
  } else {
    console.log('Amount is within valid range');
    // Safe to proceed with creating swap
  }
} else {
  console.log('Unable to fetch limits - no swap provider configured');
}
```

### Checking Swap fees

You can check the fee to pay for different swap amounts supported by the Boltz service.
This is useful to validate the user is willing to pay the fees.

```typescript
const calcChainSwapFee = async (satoshis: number, from: Chain, to: Chain): number => {
  if (!satoshis) return 0;
  // Get current swap fees
  const fees: ChainFeesResponse | null = await arkadeChainSwap.getFees(from, to);
  if (!fees) throw new Error('something went wrong');
  return Math.ceil(
    (satoshis * fees.percentage) / 100 +
    fees.minerFees.server +
    fees.minerFees.user.claim +
    fees.minerFees.user.lockup
  );
};
```

### Checking Swap Status

**With SwapManager:** Status updates are automatic via events - no manual checking needed.

**Without SwapManager (manual mode):**
```typescript
const response = await arkadeChainSwap.getSwapStatus('swap_id');
console.log('swap status = ', response.status);
```

### Storage

This library automatically stores pending swaps using the wallet's built-in contract repository. All swap data is persisted automatically and can be retrieved using the following methods:

```typescript
// Get all pending chain swaps (those waiting for payment)
const chainPendingPayments = await arkadeChainSwap.getPendingChainSwaps();

// Get complete swap history (both completed and pending)
const chainSwapHistory = await arkadeChainSwap.getSwapHistory();
```

**Note**: All swap data is automatically persisted and retrieved through the wallet's contract repository. No additional storage configuration is required.

### Cleanup (Disposable Pattern)

ArkadeChainSwap implements the Disposable pattern for automatic cleanup:

```typescript
// Option 1: Manual cleanup
const arkadeChainSwap = new ArkadeChainSwap({ wallet, swapProvider });
// ... use it
await arkadeChainSwap.dispose(); // Stops SwapManager and cleans up

// Option 2: Automatic cleanup with `await using` (TypeScript 5.2+)
{
  await using arkadeChainSwap = new ArkadeChainSwap({
    wallet,
    swapProvider,
    swapManager: { autoStart: true },
  });

  // Use arkadeChainSwap...

} // SwapManager automatically stopped when scope exits
```

## Background Swap Monitoring (SwapManager)

By default, you must manually monitor each swap and act on their state. **SwapManager** enables autonomous background processing - swaps complete automatically while the app is running. When the app reopens, it automatically resumes pending swaps.

### Enable SwapManager

```typescript
// Option 1: Enable with defaults
const arkadeLightning = new ArkadeLightning({
  wallet,
  swapProvider,
  swapManager: true, // Simple boolean to enable with defaults
});

const arkadeChainSwap = new ArkadeChainSwap({
  wallet,
  swapProvider,
  swapManager: true, // Simple boolean to enable with defaults
});

// Option 2: Enable with custom config
const arkadeLightning = new ArkadeLightning({
  wallet,
  swapProvider,
  swapManager: {
    autoStart: false, // Set to false to manually call startSwapManager() later
    // Events for UI updates (optional, can also use on/off methods)
    events: {
      onSwapCompleted: (swap) => {
        console.log(`Swap ${swap.id} completed!`);
      },
      onSwapUpdate: (swap, oldStatus) => {
        console.log(`${swap.id}: ${oldStatus} → ${swap.status}`);
      },
    },
  },
});

const arkadeChainSwap = new ArkadeChainSwap({
  wallet,
  swapProvider,
  swapManager: {
    autoStart: false, // Set to false to manually call startSwapManager() later
    // Events for UI updates (optional, can also use on/off methods)
    events: {
      onSwapCompleted: (swap) => {
        console.log(`Swap ${swap.id} completed!`);
      },
      onSwapUpdate: (swap, oldStatus) => {
        console.log(`${swap.id}: ${oldStatus} → ${swap.status}`);
      },
    },
  },
});

// If autostart is false, manually start monitoring
// (autostart is true by default, so this is only needed if you set it to false)
if (swapManager?.autoStart === false) {
  await arkadeLightning.startSwapManager();
}

// Create swaps - they're automatically monitored!
const invoice = await arkadeLightning.createLightningInvoice({ amount: 50000 });

await arkadeChainSwap.btcToArk({
  amountSats: 21000,
  toAddress: await wallet.getAddress(),
  onAddressGenerated: (btcAddress: string, amountInSats: number) => {
    showQrCode(bip21(btcAddress, amountInSats))
  }
})
// User can navigate to other pages - swap completes in background
```

### How It Works

- **Single WebSocket** monitors all swaps (not one per swap)
- **Automatic polling** after WebSocket connects/reconnects
- **Fallback polling** with exponential backoff if WebSocket fails
- **Auto-claim/refund** executes when status allows
- **Resumes on app reopen** - loads pending swaps, polls latest status, executes refunds if expired
- **⚠️ Requires app running** - stops when app closes (service worker support planned)
  - If swaps expire while app is closed, refunds execute automatically on next app launch

### Configuration Options

```typescript
  // Simple boolean to enable with defaults
  swapManager: true,

  // OR custom configuration
  swapManager: {
    enableAutoActions: true,        // Auto claim/refund (default: true)
    autoStart: true,                // Auto-start on init (default: true)
    pollInterval: 30000,            // Failsafe poll every 30s when WS active (default)
    reconnectDelayMs: 1000,         // Initial WS reconnect delay (default)
    maxReconnectDelayMs: 60000,     // Max WS reconnect delay (default)
    pollRetryDelayMs: 5000,         // Initial fallback poll delay (default)
    maxPollRetryDelayMs: 300000,    // Max fallback poll delay (default)

    // Optional: provide event listeners in config
    // (can also use on/off methods dynamically - see Event Subscription section)
    events: {
      onSwapUpdate: (swap, oldStatus) => {},
      onSwapCompleted: (swap) => {},
      onSwapFailed: (swap, error) => {},
      onActionExecuted: (swap, action) => {},  // 'claim' or 'refund'
      onWebSocketConnected: () => {},
      onWebSocketDisconnected: (error?) => {},
    }
  }
```

### Event Subscription

SwapManager supports flexible event subscription - you can add/remove listeners dynamically instead of just providing them in config:

```typescript
const arkadeLightning = new ArkadeLightning({
  wallet,
  swapProvider,
  swapManager: true,
});

// works exactly the same with arkadeChainSwap
const manager = arkadeLightning.getSwapManager();

// Subscribe to events using on* methods (returns unsubscribe function)
const unsubscribe = manager.onSwapUpdate((swap, oldStatus) => {
  console.log(`Swap ${swap.id}: ${oldStatus} → ${swap.status}`);
  // Update UI based on swap status
});

// Subscribe to completed events
manager.onSwapCompleted((swap) => {
  console.log(`Swap ${swap.id} completed!`);
  showNotification(`Payment completed!`);
});

// Subscribe to failures
manager.onSwapFailed((swap, error) => {
  console.error(`Swap ${swap.id} failed:`, error);
  showErrorDialog(error.message);
});

// Subscribe to actions (claim/refund/claimArk/claimBtc/refundArk)
manager.onActionExecuted((swap, action) => {
  console.log(`Executed ${action} for swap ${swap.id}`);
});

// WebSocket events
manager.onWebSocketConnected(() => {
  console.log('Connected to swap updates');
});

manager.onWebSocketDisconnected((error) => {
  console.log('Disconnected from swap updates', error);
});

// Unsubscribe when no longer needed (e.g., component unmount)
// unsubscribe();

// Or use off* methods to remove specific listeners
const listener = (swap) => console.log('completed', swap.id);
manager.onSwapCompleted(listener);
// Later...
manager.offSwapCompleted(listener);
```

**Benefits of dynamic event subscription:**
- Add/remove listeners at any time
- Multiple listeners per event type
- Easy cleanup when components unmount
- No need to restart SwapManager to change handlers

### Manual Control

```typescript
// Stop background monitoring
await arkadeLightning.stopSwapManager();

// Check manager stats
const manager = arkadeLightning.getSwapManager();
const stats = manager?.getStats();
console.log(`Monitoring ${stats.monitoredSwaps} swaps`);
console.log(`WebSocket connected: ${stats.websocketConnected}`);
```

### Per-Swap UI Hooks

When SwapManager is enabled, you can subscribe to updates for specific swaps to show progress in your UI:

```typescript
const result = await arkadeLightning.createLightningInvoice({ amount: 50000 });

// Subscribe to this specific swap's updates
const manager = arkadeLightning.getSwapManager();
const unsubscribe = manager.subscribeToSwapUpdates(
  result.pendingSwap.id,
  (swap, oldStatus) => {
    console.log(`Swap ${swap.id}: ${oldStatus} → ${swap.status}`);
    // Update UI based on status
    if (swap.status === 'transaction.mempool') {
      showNotification('Payment detected in mempool!');
    } else if (swap.status === 'invoice.settled') {
      showNotification('Payment received!');
    }
  }
);

// Clean up when component unmounts
// unsubscribe();
```

### Blocking with SwapManager

Even with SwapManager enabled, you can still wait for specific swaps to complete:

```typescript
const result = await arkadeLightning.createLightningInvoice({ amount: 50000 });

// This blocks until the swap completes, but SwapManager handles the monitoring
try {
  const { txid } = await arkadeLightning.waitAndClaim(result.pendingSwap);
  console.log('Payment claimed successfully:', txid);
} catch (error) {
  console.error('Payment failed:', error);
}

// Benefits of delegating to SwapManager:
// No race conditions - manager coordinates with manual calls
// User can navigate away - swap completes in background
// Automatic refund on failure - no manual error handling needed
```

## Without SwapManager (Manual Mode)

If SwapManager is not enabled, you must manually monitor swaps:

```typescript
// Create invoice
const result = await arkadeLightning.createLightningInvoice({ amount: 50000 });

// MUST manually monitor - blocks until complete
await arkadeLightning.waitAndClaim(result.pendingSwap);
// User must stay on this page - navigating away stops monitoring
```

### Validating Lightning Invoice Amounts

```typescript
import { decodeInvoice } from '@arkade-os/boltz-swap';

// Decode an incoming Lightning invoice to check its amount
const invoice = 'lnbc500u1pj...'; // Lightning invoice string
const decodedInvoice = decodeInvoice(invoice);

console.log('Invoice amount:', decodedInvoice.amountSats, 'sats');

// Check if the invoice amount is within swap limits
const limits = await arkadeLightning.getLimits();

if (limits && decodedInvoice.amountSats >= limits.min && decodedInvoice.amountSats <= limits.max) {
  // Amount is valid for swaps
  const paymentResult = await arkadeLightning.sendLightningPayment({
    invoice: invoice,
  });
  console.log('Payment successful!');
} else {
  console.error('Invoice amount is outside supported swap limits');
}
```

### Checking Swap Fees

You can check the fee to pay for different swap amounts supported by the Boltz service.
This is useful to validate the user is willing to pay the fees.

```typescript
// Get current swap fees
const fees: FeesResponse | null = await arkadeLightning.getFees();
if (!fees) throw new Error('something went wrong');

const calcSubmarineSwapFee = (satoshis: number): number => {
  if (!satoshis) return 0;
  const { percentage, minerFees } = fees.submarine;
  return Math.ceil((satoshis * percentage) / 100 + minerFees);
};

const calcReverseSwapFee = (satoshis: number): number => {
  if (!satoshis) return 0;
  const { percentage, minerFees } = fees.reverse;
  return Math.ceil((satoshis * percentage) / 100 + minerFees.claim + minerFees.lockup);
};
```

## Error Handling

**With SwapManager:** Refunds are handled automatically - listen to `onSwapFailed` event for notifications.

**Without SwapManager (manual mode):** You must handle errors and execute refunds manually:

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
} from '@arkade-os/boltz-swap';

try {
  await arkadeLightning.sendLightningPayment({
    invoice: 'lnbc500u1pj...',
  });
} catch (error) {
  if (error instanceof InvoiceExpiredError) {
    console.error('The invoice has expired. Please request a new one.');
  } else if (error instanceof InvoiceFailedToPayError) {
    console.error('The provider failed to pay the invoice.');
  } else if (error instanceof InsufficientFundsError) {
    console.error('Not enough funds available:', error.message);
  } else if (error instanceof NetworkError) {
    console.error('Network issue. Please try again later:', error.message);
  } else if (error instanceof SchemaError) {
    console.error('Invalid response from API. Please try again later.');
  } else if (error instanceof SwapExpiredError) {
    console.error('The swap has expired.');
  } else if (error instanceof TransactionFailedError) {
    console.error('Transaction failed. Please try again later');
  } else {
    console.error('Unknown error:', error);
  }

  // Manual refund (only needed without SwapManager)
  if (error.isRefundable && error.pendingSwap) {
    const refundResult = await arkadeLightning.refundVHTLC(error.pendingSwap);
    console.log('Refund claimed:', refundResult.txid);
  }
}
```
