/**
 * Vercel Function: Wait and Claim Payment
 *
 * This endpoint monitors a pending reverse swap and automatically claims
 * the payment via the VHTLC claim path when it's available.
 *
 * This is the core logic similar to Money Dev Kit - it handles the entire
 * payment lifecycle inside the function.
 *
 * Example usage:
 * POST /api/wait-and-claim
 * {
 *   "swapId": "swap_abc123",
 *   "preimage": "preimage_hex"
 * }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Wallet, SingleKey } from '@arkade-os/sdk';
import {
  ArkadeLightning,
  BoltzSwapProvider,
  type PendingReverseSwap,
  InvoiceExpiredError,
  SwapExpiredError,
  TransactionFailedError,
} from '@arkade-os/boltz-swap';

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
    const { swapId, preimage } = req.body;

    // Validate input
    if (!swapId || typeof swapId !== 'string') {
      return res.status(400).json({
        error: 'Invalid swapId. Must be a string.'
      });
    }

    if (!preimage || typeof preimage !== 'string') {
      return res.status(400).json({
        error: 'Invalid preimage. Must be a string.'
      });
    }

    // Get ArkadeLightning instance
    const lightning = await getArkadeLightning();

    // Get all pending reverse swaps to find our swap
    const pendingSwaps = await lightning.getPendingReverseSwaps();
    let pendingSwap = pendingSwaps.find(swap => swap.id === swapId);

    // If not in pending list, try getting from swap history
    if (!pendingSwap) {
      const history = await lightning.getSwapHistory();
      const swapFromHistory = history.find(swap => swap.id === swapId);

      if (!swapFromHistory || swapFromHistory.type !== 'reverse') {
        return res.status(404).json({
          error: 'Swap not found',
          swapId,
        });
      }

      pendingSwap = swapFromHistory as PendingReverseSwap;
    }

    // Ensure we have the preimage in the swap object
    if (!pendingSwap.preimage) {
      pendingSwap.preimage = preimage;
    }

    // THIS IS THE KEY PART - waitAndClaim inside the Vercel function
    // It monitors the swap and automatically claims via VHTLC when payment is received
    console.log(`Waiting for payment on swap ${swapId}...`);

    const result = await lightning.waitAndClaim(pendingSwap);

    console.log(`Payment claimed successfully! TxID: ${result.txid}`);

    // Return success response
    return res.status(200).json({
      success: true,
      message: 'Payment received and claimed successfully',
      txid: result.txid,
      swapId: pendingSwap.id,
      amount: pendingSwap.response.onchainAmount,
    });

  } catch (error: any) {
    console.error('Error waiting for or claiming payment:', error);

    // Handle specific error types
    if (error instanceof InvoiceExpiredError) {
      return res.status(400).json({
        error: 'Invoice expired',
        message: 'The Lightning invoice has expired. Please create a new one.',
      });
    }

    if (error instanceof SwapExpiredError) {
      return res.status(400).json({
        error: 'Swap expired',
        message: 'The swap has expired. Please create a new invoice.',
      });
    }

    if (error instanceof TransactionFailedError) {
      return res.status(500).json({
        error: 'Transaction failed',
        message: 'The claim transaction failed. Please try again.',
      });
    }

    return res.status(500).json({
      error: 'Failed to claim payment',
      message: error.message,
    });
  }
}
