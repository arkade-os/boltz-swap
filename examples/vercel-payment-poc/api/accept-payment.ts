/**
 * Vercel Function: Accept Lightning Payment (All-in-One)
 *
 * This is a complete example that combines invoice creation and payment claiming
 * in a single endpoint - similar to how Money Dev Kit works.
 *
 * This function:
 * 1. Creates a Lightning invoice for the specified amount
 * 2. Waits for the payment to be received
 * 3. Automatically claims the payment via the VHTLC claim path
 * 4. Returns the result
 *
 * Example usage:
 * POST /api/accept-payment
 * {
 *   "amount": 50000,
 *   "description": "Payment for service"
 * }
 *
 * Response (immediately):
 * {
 *   "invoice": "lnbc...",
 *   "paymentHash": "...",
 *   "swapId": "..."
 * }
 *
 * The function continues running in the background to claim the payment.
 * For a synchronous version, see /api/accept-payment-sync
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Wallet, SingleKey } from '@arkade-os/sdk';
import {
  ArkadeLightning,
  BoltzSwapProvider,
  InvoiceExpiredError,
  SwapExpiredError,
  TransactionFailedError,
} from '@arkade-os/boltz-swap';

// Initialize wallet (in production, use secure key management)
let arkadeLightning: ArkadeLightning | null = null;

async function getArkadeLightning() {
  if (arkadeLightning) return arkadeLightning;

  const privateKeyHex = process.env.ARKADE_PRIVATE_KEY;
  if (!privateKeyHex) {
    throw new Error('ARKADE_PRIVATE_KEY environment variable is required');
  }

  const identity = SingleKey.fromHex(privateKeyHex);

  const wallet = await Wallet.create({
    identity,
    arkServerUrl: process.env.ARK_SERVER_URL || 'https://mutinynet.arkade.sh',
  });

  const swapProvider = new BoltzSwapProvider({
    apiUrl: process.env.BOLTZ_API_URL || 'https://api.boltz.mutinynet.arkade.sh',
    network: (process.env.NETWORK as any) || 'mutinynet',
  });

  arkadeLightning = new ArkadeLightning({
    wallet,
    swapProvider,
  });

  return arkadeLightning;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { amount, description } = req.body;

    // Validate input
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({
        error: 'Invalid amount. Must be a positive number.'
      });
    }

    // Get ArkadeLightning instance
    const lightning = await getArkadeLightning();

    // Check limits
    const limits = await lightning.getLimits();
    if (amount < limits.min || amount > limits.max) {
      return res.status(400).json({
        error: `Amount must be between ${limits.min} and ${limits.max} sats`,
        limits,
      });
    }

    console.log(`Creating invoice for ${amount} sats...`);

    // Step 1: Create Lightning invoice (reverse swap)
    const invoiceResult = await lightning.createLightningInvoice({
      amount,
      description: description || 'Arkade Payment',
    });

    console.log(`Invoice created: ${invoiceResult.invoice}`);
    console.log(`Swap ID: ${invoiceResult.pendingSwap.id}`);

    // Return invoice immediately to client
    res.status(200).json({
      success: true,
      invoice: invoiceResult.invoice,
      amount: invoiceResult.amount,
      paymentHash: invoiceResult.paymentHash,
      expiry: invoiceResult.expiry,
      swapId: invoiceResult.pendingSwap.id,
    });

    // Step 2 & 3: Wait for payment and claim via VHTLC (runs in background)
    // THIS IS THE KEY PART - waitAndClaim handles the VHTLC claim path automatically
    console.log(`Waiting for payment on swap ${invoiceResult.pendingSwap.id}...`);

    try {
      const claimResult = await lightning.waitAndClaim(invoiceResult.pendingSwap);
      console.log(`Payment claimed successfully! TxID: ${claimResult.txid}`);

      // In a real application, you might:
      // - Store the result in a database
      // - Trigger a webhook
      // - Update order status
      // - Send notification to user

    } catch (claimError: any) {
      console.error('Error claiming payment:', claimError);

      // Handle claim errors
      if (claimError instanceof InvoiceExpiredError) {
        console.error('Invoice expired before payment was received');
      } else if (claimError instanceof SwapExpiredError) {
        console.error('Swap expired before payment could be claimed');
      } else if (claimError instanceof TransactionFailedError) {
        console.error('Claim transaction failed');
      }

      // In a real application, you might:
      // - Update database with failure status
      // - Trigger error webhook
      // - Alert admin
    }

  } catch (error: any) {
    console.error('Error in accept-payment:', error);
    return res.status(500).json({
      error: 'Failed to process payment',
      message: error.message,
    });
  }
}
