# Lightning Swaps

> Integrate Lightning Network with Arkade using Submarine Swaps

Arkade provides seamless integration with the Lightning Network through Boltz submarine swaps, allowing users to move funds between Arkade and Lightning channels. This integration leverages Hash Time-Locked Contracts (HTLCs) to ensure trustless and secure cross-chain atomic swaps.

## Overview

The `BoltzSwapProvider` library extends Arkade's functionality by enabling:

1. **Lightning to Arkade swaps** - Receive funds from Lightning payments into your Arkade wallet
2. **Arkade to Lightning swaps** - Send funds from your Arkade wallet to Lightning invoices

This integration is built on top of the Boltz submarine swap protocol, providing a reliable and secure way to bridge the gap between Arkade and the Lightning Network.

## Installation

```bash
npm install @arkade-os/sdk @arkade-os/boltz-swap
```

## Basic Usage

### Initializing the Lightning Swap Provider

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
  apiUrl: 'https://api.boltz.exchange',
  network: 'mainnet'
});

// Create the ArkadeLightning instance
const arkadeLightning = new ArkadeLightning({
  wallet,
  swapProvider
});
```

## Receiving Lightning Payments

To receive a Lightning payment into your Arkade wallet:

```typescript
// Create a Lightning invoice that will deposit funds to your Arkade wallet
const result = await arkadeLightning.createLightningInvoice({
  amountSats: 50000, // 50,000 sats
  description: 'Payment to my Arkade wallet'
});

console.log('Lightning Invoice:', result.invoice);
console.log('Payment Hash:', result.paymentHash);
console.log('Expiry (seconds):', result.expirySeconds);

// The invoice can now be shared with the payer
// When paid, funds will appear in your Arkade wallet
```

### Monitoring Incoming Lightning Payments

You can monitor the status of incoming Lightning payments:

```typescript
// Monitor the payment by payment hash
const subscription = arkadeLightning.monitorIncomingPayment(result.paymentHash);

subscription.on('pending', () => {
  console.log('Payment detected but not yet confirmed');
});

subscription.on('confirmed', (txDetails) => {
  console.log('Payment confirmed!');
  console.log('Transaction ID:', txDetails.txid);
  console.log('Amount received:', txDetails.amountSats, 'sats');
  
  // Update your UI or notify the user
  updateBalanceDisplay();
});

subscription.on('failed', (error) => {
  console.error('Payment failed:', error.message);
});

// Don't forget to clean up when done
subscription.unsubscribe();
```

## Sending Lightning Payments

To send a payment from your Arkade wallet to a Lightning invoice:

```typescript
// Parse a Lightning invoice
const invoiceDetails = await arkadeLightning.decodeInvoice(
  'lnbc500u1pj...'  // Lightning invoice string
);

console.log('Invoice amount:', invoiceDetails.amountSats, 'sats');
console.log('Description:', invoiceDetails.description);
console.log('Destination:', invoiceDetails.destination);

// Pay the Lightning invoice from your Arkade wallet
try {
  const paymentResult = await arkadeLightning.sendLightningPayment({
    invoice: 'lnbc500u1pj...',  // Lightning invoice string
    // Optional: Specify which VTXOs to use
    sourceVtxos: await wallet.getVtxos(),
    // Optional: Maximum fee you're willing to pay (in sats)
    maxFeeSats: 1000
  });
  
  console.log('Payment successful!');
  console.log('Preimage:', paymentResult.preimage);
  console.log('Transaction ID:', paymentResult.txid);
} catch (error) {
  console.error('Payment failed:', error.message);
}
```

## Handling Refunds

In case a Lightning payment fails after the swap has been initiated, the library provides a refund mechanism:

```typescript
// Set up a refund handler when initializing
const arkadeLightning = new ArkadeLightning({
  wallet,
  swapProvider,
  refundHandler: {
    onRefundNeeded: async (swapData) => {
      console.log('Initiating refund for swap:', swapData.id);
      
      // You can implement custom logic here, such as:
      // - Notifying the user
      // - Automatically claiming the refund
      // - Logging the event
      
      // Claim the refund automatically
      return await arkadeLightning.claimRefund(swapData);
    }
  }
});

// Or handle refunds manually
const pendingSwaps = await arkadeLightning.getPendingSwaps();
for (const swap of pendingSwaps) {
  if (swap.status === 'refundable') {
    const refundResult = await arkadeLightning.claimRefund(swap);
    console.log('Refund claimed:', refundResult.txid);
  }
}
```

## Advanced Configuration

The library supports advanced configuration options for more specific use cases:

```typescript
const arkadeLightning = new ArkadeLightning({
  wallet,
  swapProvider,
  
  // Configure timeouts
  timeoutConfig: {
    swapExpiryBlocks: 144, // Number of blocks until swap expires
    invoiceExpirySeconds: 3600, // Invoice expiry in seconds
    claimDelayBlocks: 10 // Blocks to wait before claiming
  },
  
  // Configure fee limits
  feeConfig: {
    maxMinerFeeSats: 5000, // Maximum miner fee in sats
    maxSwapFeeSats: 1000, // Maximum swap fee in sats
  },
  
  // Configure retry logic
  retryConfig: {
    maxAttempts: 3,
    delayMs: 1000
  }
});
```

## Error Handling

The library provides detailed error types to help you handle different failure scenarios:

```typescript
import { 
  SwapError, 
  InvoiceExpiredError,
  InsufficientFundsError,
  NetworkError 
} from '@arkade-os/lightning-swap';

try {
  await arkadeLightning.sendLightningPayment({
    invoice: 'lnbc500u1pj...'
  });
} catch (error) {
  if (error instanceof InvoiceExpiredError) {
    console.error('The invoice has expired. Please request a new one.');
  } else if (error instanceof InsufficientFundsError) {
    console.error('Not enough funds available:', error.message);
  } else if (error instanceof NetworkError) {
    console.error('Network issue. Please try again later:', error.message);
  } else if (error instanceof SwapError) {
    console.error('Swap failed:', error.message);
    
    // You might be able to claim a refund
    if (error.isRefundable) {
      const refundResult = await arkadeLightning.claimRefund(error.swapData);
      console.log('Refund claimed:', refundResult.txid);
    }
  } else {
    console.error('Unknown error:', error);
  }
}
```

## Security Considerations

When working with Lightning swaps, keep these security considerations in mind:

1. **Timeouts**: Always ensure that your HTLCs have appropriate timeouts to prevent funds from being locked indefinitely.

2. **Fee Management**: Set reasonable fee limits to prevent excessive fees during network congestion.

3. **Refund Monitoring**: Implement proper monitoring for failed swaps to ensure refunds are claimed promptly.

4. **Invoice Validation**: Always validate Lightning invoices before initiating payments.

5. **Backup Management**: Keep proper backups of swap data to be able to claim refunds if needed.