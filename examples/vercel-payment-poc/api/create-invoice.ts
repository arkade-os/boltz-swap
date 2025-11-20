/**
 * Vercel Function: Create Lightning Invoice
 *
 * This endpoint creates a Lightning invoice that, when paid, will deposit
 * funds into your Arkade wallet via a Boltz reverse swap.
 *
 * Example usage:
 * POST /api/create-invoice
 * {
 *   "amount": 50000,
 *   "description": "Payment for service"
 * }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Wallet, SingleKey } from '@arkade-os/sdk';
import { ArkadeLightning, BoltzSwapProvider } from '@arkade-os/boltz-swap';

// Initialize wallet (in production, use secure key management)
let arkadeLightning: ArkadeLightning | null = null;

async function getArkadeLightning() {
  if (arkadeLightning) return arkadeLightning;

  // Get private key from environment variable
  const privateKeyHex = process.env.ARKADE_PRIVATE_KEY;
  if (!privateKeyHex) {
    throw new Error('ARKADE_PRIVATE_KEY environment variable is required');
  }

  // Create identity from private key
  const identity = SingleKey.fromHex(privateKeyHex);

  // Initialize wallet
  const wallet = await Wallet.create({
    identity,
    arkServerUrl: process.env.ARK_SERVER_URL || 'https://mutinynet.arkade.sh',
  });

  // Initialize swap provider
  const swapProvider = new BoltzSwapProvider({
    apiUrl: process.env.BOLTZ_API_URL || 'https://api.boltz.mutinynet.arkade.sh',
    network: (process.env.NETWORK as any) || 'mutinynet',
  });

  // Create ArkadeLightning instance
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
  // Only accept POST requests
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

    // Create Lightning invoice
    const result = await lightning.createLightningInvoice({
      amount,
      description: description || 'Arkade Payment',
    });

    // Return invoice details
    return res.status(200).json({
      success: true,
      invoice: result.invoice,
      amount: result.amount,
      paymentHash: result.paymentHash,
      expiry: result.expiry,
      swapId: result.pendingSwap.id,
      // Store preimage securely - needed for claiming
      preimage: result.preimage,
    });

  } catch (error: any) {
    console.error('Error creating invoice:', error);
    return res.status(500).json({
      error: 'Failed to create invoice',
      message: error.message,
    });
  }
}
