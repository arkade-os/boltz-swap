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

## Basic Usage

### Initializing the Lightning Swap Provider

```typescript
import { Wallet } from '@arkade-os/sdk';
import { ArkadeLightning, BoltzSwapProvider, StorageProvider } from '@arkade-os/boltz-swap';

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

// Optionally: initialize a storage provider
const storageProvider = await StorageProvider.create();

// Create the ArkadeLightning instance
const arkadeLightning = new ArkadeLightning({
  wallet,
  swapProvider,
  storageProvider, // optional
});
```

## Storage

By default this library doesn't store pending swaps.

If you need it you must initialize a storageProvider:

```typescript
const storageProvider = await StorageProvider.create({ storagePath: './storage.json' });

const arkadeLightning = new ArkadeLightning({
  wallet,
  swapProvider,
  storageProvider,
});

// you now are able to use the following methods
const pendingPaymentsToLightning = arkadeLightning.getPendingSubmarineSwaps();
const pendingPaymentsFromLightning = arkadeLightning.getPendingReverseSwaps();
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
