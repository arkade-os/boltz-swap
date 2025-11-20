/**
 * Example Client Usage
 *
 * This file demonstrates how to use the Vercel payment API from a client application.
 */

const API_BASE_URL = 'https://your-domain.vercel.app';

/**
 * Example 1: Simple all-in-one payment acceptance
 */
async function acceptPaymentExample() {
  console.log('=== Example 1: Accept Payment (All-in-One) ===\n');

  try {
    // Create invoice and start automatic claiming
    const response = await fetch(`${API_BASE_URL}/api/accept-payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: 50000, // 50,000 sats
        description: 'Coffee purchase',
      }),
    });

    const result = await response.json();

    if (result.success) {
      console.log('Invoice created successfully!');
      console.log('Invoice:', result.invoice);
      console.log('Payment Hash:', result.paymentHash);
      console.log('Swap ID:', result.swapId);
      console.log('\nShare this invoice with the payer:');
      console.log(result.invoice);
      console.log('\nThe payment will be automatically claimed when received.');

      // Display invoice as QR code (in real app)
      // showQRCode(result.invoice);

      // Store swapId for tracking
      // await saveToDatabase({ swapId: result.swapId, status: 'pending' });

    } else {
      console.error('Failed to create invoice:', result.error);
    }

  } catch (error) {
    console.error('Error:', error);
  }
}

/**
 * Example 2: Two-step process (create invoice, then claim separately)
 */
async function twoStepPaymentExample() {
  console.log('\n=== Example 2: Two-Step Payment Process ===\n');

  try {
    // Step 1: Create invoice
    console.log('Step 1: Creating invoice...');
    const createResponse = await fetch(`${API_BASE_URL}/api/create-invoice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: 100000, // 100,000 sats
        description: 'Premium service',
      }),
    });

    const invoiceResult = await createResponse.json();

    if (!invoiceResult.success) {
      throw new Error(invoiceResult.error);
    }

    console.log('Invoice created!');
    console.log('Invoice:', invoiceResult.invoice);
    console.log('Swap ID:', invoiceResult.swapId);
    console.log('Preimage:', invoiceResult.preimage);

    // Store the preimage securely - you'll need it to claim
    const preimage = invoiceResult.preimage;
    const swapId = invoiceResult.swapId;

    // Display invoice to user
    console.log('\nWaiting for payment...');

    // Step 2: Wait for payment and claim
    console.log('\nStep 2: Waiting for payment and claiming...');
    const claimResponse = await fetch(`${API_BASE_URL}/api/wait-and-claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        swapId,
        preimage,
      }),
    });

    const claimResult = await claimResponse.json();

    if (claimResult.success) {
      console.log('Payment claimed successfully!');
      console.log('Transaction ID:', claimResult.txid);
      console.log('Amount:', claimResult.amount, 'sats');

      // Update application state
      // await updateOrderStatus(orderId, 'paid');
      // await sendConfirmationEmail(user);

    } else {
      console.error('Failed to claim payment:', claimResult.error);

      // Handle specific errors
      if (claimResult.error === 'Invoice expired') {
        console.log('Please create a new invoice');
      }
    }

  } catch (error) {
    console.error('Error:', error);
  }
}

/**
 * Example 3: Check swap limits before creating invoice
 */
async function checkLimitsExample() {
  console.log('\n=== Example 3: Check Limits ===\n');

  const requestedAmount = 25000; // 25,000 sats

  try {
    // Get limits (you'd need to create an endpoint for this)
    // For now, we'll try to create an invoice and handle the error

    const response = await fetch(`${API_BASE_URL}/api/create-invoice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: requestedAmount,
      }),
    });

    const result = await response.json();

    if (result.error && result.limits) {
      console.log(`Amount ${requestedAmount} is outside limits`);
      console.log(`Min: ${result.limits.min} sats`);
      console.log(`Max: ${result.limits.max} sats`);
    } else if (result.success) {
      console.log('Invoice created successfully within limits!');
    }

  } catch (error) {
    console.error('Error:', error);
  }
}

/**
 * Example 4: Handle errors gracefully
 */
async function errorHandlingExample() {
  console.log('\n=== Example 4: Error Handling ===\n');

  try {
    const response = await fetch(`${API_BASE_URL}/api/accept-payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: 0, // Invalid amount
      }),
    });

    const result = await response.json();

    if (!result.success) {
      console.error('Error creating invoice:', result.error);

      // Handle specific error cases
      switch (result.error) {
        case 'Invalid amount. Must be a positive number.':
          console.log('Please enter a valid amount');
          break;

        case 'Amount must be between X and Y sats':
          console.log('Amount outside acceptable range:', result.limits);
          break;

        default:
          console.log('Unknown error occurred');
      }
    }

  } catch (error) {
    console.error('Network or parsing error:', error);
  }
}

/**
 * Example 5: Integration with a checkout flow
 */
async function checkoutFlowExample() {
  console.log('\n=== Example 5: Checkout Flow Integration ===\n');

  // Simulated checkout data
  const order = {
    id: 'order_123',
    amount: 75000, // 75,000 sats
    items: ['Coffee', 'Donut'],
    customer: 'customer@example.com',
  };

  try {
    console.log('Processing order:', order.id);
    console.log('Amount:', order.amount, 'sats');

    // Create invoice for the order
    const response = await fetch(`${API_BASE_URL}/api/accept-payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: order.amount,
        description: `Order ${order.id}: ${order.items.join(', ')}`,
      }),
    });

    const result = await response.json();

    if (result.success) {
      console.log('\n✓ Invoice created for order', order.id);
      console.log('✓ Swap ID:', result.swapId);
      console.log('✓ Invoice:', result.invoice);

      // In a real application:
      // 1. Save the order with swapId to database
      await saveOrder({
        orderId: order.id,
        swapId: result.swapId,
        status: 'awaiting_payment',
        invoice: result.invoice,
        amount: result.amount,
        createdAt: new Date(),
      });

      // 2. Display invoice to customer (QR code + copy button)
      displayPaymentPage({
        invoice: result.invoice,
        amount: result.amount,
        orderId: order.id,
      });

      // 3. The Vercel function will automatically claim the payment
      //    and you can listen for webhooks or poll for status updates

      console.log('\n✓ Waiting for payment...');
      console.log('✓ Payment will be automatically claimed when received');
      console.log('✓ Customer will be notified upon successful payment');

    } else {
      console.error('Failed to create invoice for order', order.id);
      console.error('Error:', result.error);

      // Update order status to failed
      await updateOrderStatus(order.id, 'payment_failed', result.error);
    }

  } catch (error) {
    console.error('Error in checkout flow:', error);
    await updateOrderStatus(order.id, 'error', error.message);
  }
}

// Placeholder functions for demonstration
async function saveOrder(data: any) {
  console.log('[DB] Saving order:', data);
}

function displayPaymentPage(data: any) {
  console.log('[UI] Displaying payment page:', data);
}

async function updateOrderStatus(orderId: string, status: string, error?: string) {
  console.log(`[DB] Updating order ${orderId} to status: ${status}`, error || '');
}

// Run examples
if (require.main === module) {
  (async () => {
    // Uncomment the example you want to run:

    // await acceptPaymentExample();
    // await twoStepPaymentExample();
    // await checkLimitsExample();
    // await errorHandlingExample();
    await checkoutFlowExample();
  })();
}

export {
  acceptPaymentExample,
  twoStepPaymentExample,
  checkLimitsExample,
  errorHandlingExample,
  checkoutFlowExample,
};
