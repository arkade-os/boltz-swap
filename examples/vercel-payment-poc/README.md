# Lightning Payment via VHTLC - Vercel Function PoC

This is a **Proof of Concept** demonstrating how to accept Lightning Network payments and automatically claim them via the VHTLC (Virtual Hashed Time-Locked Contract) claim path using Vercel serverless functions and the Boltz-swap package.

This approach is similar to Money Dev Kit - creating a simple API that handles the entire payment lifecycle.

## Overview

This PoC provides three Vercel function endpoints:

### 1. `/api/accept-payment` (Recommended - All-in-One)

The simplest approach - creates an invoice and automatically claims the payment in the background.

**Request:**
```bash
curl -X POST https://your-domain.vercel.app/api/accept-payment \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 50000,
    "description": "Payment for service"
  }'
```

**Response:**
```json
{
  "success": true,
  "invoice": "lnbc500u1p...",
  "amount": 50000,
  "paymentHash": "abc123...",
  "expiry": 3600,
  "swapId": "swap_xyz789"
}
```

The function returns immediately with the invoice, then continues running in the background to automatically claim the payment via VHTLC when it arrives.

### 2. `/api/create-invoice` + `/api/wait-and-claim` (Two-Step)

For more control, you can split the process into two steps:

**Step 1: Create Invoice**
```bash
curl -X POST https://your-domain.vercel.app/api/create-invoice \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 50000,
    "description": "Payment for service"
  }'
```

**Response:**
```json
{
  "success": true,
  "invoice": "lnbc500u1p...",
  "amount": 50000,
  "paymentHash": "abc123...",
  "swapId": "swap_xyz789",
  "preimage": "preimage_hex..."
}
```

**Step 2: Wait and Claim**
```bash
curl -X POST https://your-domain.vercel.app/api/wait-and-claim \
  -H "Content-Type: application/json" \
  -d '{
    "swapId": "swap_xyz789",
    "preimage": "preimage_hex..."
  }'
```

**Response:**
```json
{
  "success": true,
  "message": "Payment received and claimed successfully",
  "txid": "tx_abc123",
  "swapId": "swap_xyz789",
  "amount": 50000
}
```

## How It Works

### The VHTLC Claim Path

When you create a Lightning invoice:

1. **Reverse Swap Creation**: A reverse swap is created with Boltz
2. **VHTLC Lockup**: Boltz creates a Virtual HTLC (VHTLC) on the Arkade network
3. **Invoice Generation**: A Lightning invoice is generated for the payer
4. **Payment Monitoring**: The function monitors the swap status via WebSocket
5. **Automatic Claim**: When payment is received, the function automatically:
   - Detects the VHTLC is funded
   - Creates an off-chain transaction to claim the VHTLC
   - Signs the transaction with the preimage (proving knowledge of the secret)
   - Submits to the Arkade provider
   - Receives the funds in your Arkade wallet

This is all handled by the `waitAndClaim()` method from the `@arkade-os/boltz-swap` package.

### Key Components

```typescript
// 1. Create the Lightning invoice (reverse swap)
const invoiceResult = await arkadeLightning.createLightningInvoice({
  amount: 50000,
  description: 'Payment for service',
});

// 2. Wait for payment and automatically claim via VHTLC
const claimResult = await arkadeLightning.waitAndClaim(
  invoiceResult.pendingSwap
);

// That's it! The VHTLC claim is handled automatically
console.log('Payment claimed! TxID:', claimResult.txid);
```

The `waitAndClaim()` function:
- Monitors the swap status via WebSocket
- Waits for the VHTLC to be funded (`transaction.mempool` or `transaction.confirmed`)
- Automatically calls `claimVHTLC()` internally
- Returns when the payment is successfully claimed

## Setup

### Prerequisites

- Node.js 22 or higher
- Vercel account
- Arkade wallet private key

### Installation

1. Clone or create the project:
```bash
mkdir vercel-payment-poc
cd vercel-payment-poc
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env.local` file:
```env
ARKADE_PRIVATE_KEY=your_private_key_hex
ARK_SERVER_URL=https://mutinynet.arkade.sh
BOLTZ_API_URL=https://api.boltz.mutinynet.arkade.sh
NETWORK=mutinynet
```

**⚠️ Security Warning**: Never commit your private key to version control. Use Vercel's environment variables in production.

### Local Development

```bash
npm run dev
```

This starts a local Vercel development server at `http://localhost:3000`.

### Testing Locally

Create an invoice:
```bash
curl -X POST http://localhost:3000/api/accept-payment \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 50000,
    "description": "Test payment"
  }'
```

Pay the invoice using any Lightning wallet, and the function will automatically claim the payment.

### Deployment

1. Install Vercel CLI:
```bash
npm install -g vercel
```

2. Deploy:
```bash
vercel deploy
```

3. Set environment variables in Vercel dashboard:
   - `ARKADE_PRIVATE_KEY`
   - `ARK_SERVER_URL`
   - `BOLTZ_API_URL`
   - `NETWORK`

## Architecture

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │ POST /api/accept-payment
       │ { amount: 50000 }
       ▼
┌─────────────────────────────┐
│   Vercel Function           │
│                             │
│  1. Create Invoice          │──────┐
│     (Reverse Swap)          │      │
│                             │      │
│  2. Return invoice to       │◄─────┘
│     client immediately      │
│                             │
│  3. Wait for payment        │──────┐
│     (WebSocket monitor)     │      │
│                             │      │
│  4. Claim via VHTLC         │◄─────┘
│     - Build off-chain tx    │
│     - Sign with preimage    │
│     - Submit to Ark         │
│                             │
└─────────────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│   Boltz API                 │
│   - Swap creation           │
│   - Status monitoring       │
│   - VHTLC coordination      │
└─────────────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│   Arkade Network            │
│   - VHTLC contracts         │
│   - Off-chain transactions  │
│   - Final settlement        │
└─────────────────────────────┘
```

## Production Considerations

### Security

1. **Private Key Management**:
   - Use environment variables (never hardcode)
   - Consider using a key management service (AWS KMS, etc.)
   - Implement key rotation

2. **Webhook Authentication**:
   - Add API key authentication to your endpoints
   - Validate request signatures
   - Rate limiting

3. **Error Handling**:
   - Implement comprehensive error logging
   - Set up monitoring and alerts
   - Handle edge cases (expired invoices, failed claims, etc.)

### Scalability

1. **State Management**:
   - Use a database to track swap states
   - Implement idempotency keys
   - Handle concurrent requests

2. **Background Processing**:
   - Consider using a job queue for claim processing
   - Implement retry logic with exponential backoff
   - Monitor long-running functions

3. **Observability**:
   - Add structured logging
   - Track metrics (success rate, claim time, etc.)
   - Set up alerting for failures

### Example Production Enhancement

```typescript
// Add database for state tracking
import { db } from './db';

// Add webhook for notifications
import { sendWebhook } from './webhooks';

export default async function handler(req, res) {
  // ... create invoice ...

  // Save to database
  await db.saveSwap({
    swapId: invoiceResult.pendingSwap.id,
    status: 'pending',
    amount: invoiceResult.amount,
    createdAt: Date.now(),
  });

  // Return immediately
  res.json({ invoice: invoiceResult.invoice });

  // Background claim
  try {
    const result = await lightning.waitAndClaim(invoiceResult.pendingSwap);

    // Update database
    await db.updateSwap(swapId, {
      status: 'claimed',
      txid: result.txid,
      claimedAt: Date.now(),
    });

    // Trigger webhook
    await sendWebhook({
      event: 'payment.claimed',
      swapId,
      txid: result.txid,
    });

  } catch (error) {
    await db.updateSwap(swapId, {
      status: 'failed',
      error: error.message,
    });

    await sendWebhook({
      event: 'payment.failed',
      swapId,
      error: error.message,
    });
  }
}
```

## API Reference

### POST `/api/accept-payment`

Creates a Lightning invoice and automatically claims the payment.

**Request Body:**
```typescript
{
  amount: number;        // Amount in satoshis
  description?: string;  // Optional invoice description
}
```

**Response:**
```typescript
{
  success: true;
  invoice: string;       // Lightning invoice (BOLT11)
  amount: number;        // Amount in satoshis
  paymentHash: string;   // Payment hash
  expiry: number;        // Invoice expiry (seconds)
  swapId: string;        // Swap identifier
}
```

### POST `/api/create-invoice`

Creates a Lightning invoice only (without automatic claiming).

**Request Body:**
```typescript
{
  amount: number;        // Amount in satoshis
  description?: string;  // Optional invoice description
}
```

**Response:**
```typescript
{
  success: true;
  invoice: string;       // Lightning invoice (BOLT11)
  amount: number;        // Amount in satoshis
  paymentHash: string;   // Payment hash
  expiry: number;        // Invoice expiry (seconds)
  swapId: string;        // Swap identifier
  preimage: string;      // Preimage (needed for claiming)
}
```

### POST `/api/wait-and-claim`

Waits for payment and claims via VHTLC.

**Request Body:**
```typescript
{
  swapId: string;        // Swap identifier
  preimage: string;      // Preimage from create-invoice
}
```

**Response:**
```typescript
{
  success: true;
  message: string;       // Success message
  txid: string;          // Transaction ID
  swapId: string;        // Swap identifier
  amount: number;        // Amount claimed (satoshis)
}
```

## Error Handling

All endpoints return appropriate HTTP status codes:

- `200` - Success
- `400` - Bad Request (invalid input)
- `404` - Not Found (swap not found)
- `405` - Method Not Allowed
- `500` - Internal Server Error

Error response format:
```json
{
  "error": "Error type",
  "message": "Detailed error message"
}
```

## License

MIT

## Resources

- [Boltz-swap Package](https://github.com/arkade-os/boltz-swap)
- [Arkade SDK](https://github.com/arkade-os/ts-sdk)
- [Boltz API Docs](https://api.docs.boltz.exchange/)
- [Vercel Documentation](https://vercel.com/docs)
