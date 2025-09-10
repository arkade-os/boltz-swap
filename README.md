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

## Wallet class Compatibility

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
});
```

### ServiceWorkerWallet (legacy interface)

```typescript
import { RestArkProvider, RestIndexerProvider } from '@arkade-os/sdk';

// ServiceWorkerWallet has identity methods spread directly (no nested identity)
const serviceWorkerWallet = new ServiceWorkerWallet(serviceWorker);
await serviceWorkerWallet.init({
  privateKey: 'your_private_key_hex',
  arkServerUrl: 'https://ark.example.com',
});

// Must provide external providers for ServiceWorkerWallet (it doesn't have them)
const arkadeLightning = new ArkadeLightning({
  wallet: serviceWorkerWallet,
  arkProvider: new RestArkProvider('https://ark.example.com'),
  indexerProvider: new RestIndexerProvider('https://indexer.example.com'),
  swapProvider,
});
```

## Checking Swap Limits

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
    maxFeeSats: 1000,
  });
  console.log('Payment successful!');
} else {
  console.error('Invoice amount is outside supported swap limits');
}
```

## Checking Swap Fees

You can check the fee to pay for different swap amounts supported by the Boltz service.
This is useful to validate the user is willing to pay the fees.

```typescript
// Get current swap fees
const fees: FeeResponse | null = await arkadeLightning.getFees();
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
