import { fetch } from 'undici';
import { NetworkError } from './errors';
import { Network, SwapStatus } from './types';
import { WebSocket } from 'ws';

export interface SwapProviderConfig {
  apiUrl?: string;
  network: Network;
}

export type LimitsResponse = {
  min: number;
  max: number;
};

export type SwapStages =
  | 'invoice.settled'
  | 'invoice.expired'
  | 'swap.successful'
  | 'swap.created'
  | 'swap.expired'
  | 'transaction.claimed'
  | 'transaction.failed'
  | 'transaction.refunded'
  | 'transaction.mempool'
  | 'transaction.confirmed';

export type SwapStatusResponse = {
  status: string;
  zeroConfRejected?: boolean;
  transaction?: {
    id: string;
    hex: string;
    preimage?: string;
  };
};

export const isSwapStatusResponse = (data: any): data is SwapStatusResponse => {
  return (
    data &&
    typeof data === 'object' &&
    typeof data.status === 'string' &&
    (data.zeroConfRejected === undefined || typeof data.zeroConfRejected === 'boolean') &&
    (data.transaction === undefined ||
      (data.transaction &&
        typeof data.transaction === 'object' &&
        typeof data.transaction.id === 'string' &&
        typeof data.transaction.hex === 'string'))
  );
};

export type GetPairsResponse = {
  ARK: {
    BTC: {
      hash: string;
      rate: number;
      limits: {
        maximal: number;
        minimal: number;
        maximalZeroConf: number;
      };
      fees: {
        percentage: number;
        minerFees: number;
      };
    };
  };
};

export const isGetPairsResponse = (data: any): data is GetPairsResponse => {
  return (
    data &&
    typeof data === 'object' &&
    data.ARK &&
    typeof data.ARK === 'object' &&
    data.ARK.BTC &&
    typeof data.ARK.BTC === 'object' &&
    typeof data.ARK.BTC.hash === 'string' &&
    typeof data.ARK.BTC.rate === 'number' &&
    data.ARK.BTC.limits &&
    typeof data.ARK.BTC.limits === 'object' &&
    typeof data.ARK.BTC.limits.maximal === 'number' &&
    typeof data.ARK.BTC.limits.minimal === 'number' &&
    typeof data.ARK.BTC.limits.maximalZeroConf === 'number' &&
    data.ARK.BTC.fees &&
    typeof data.ARK.BTC.fees === 'object' &&
    typeof data.ARK.BTC.fees.percentage === 'number' &&
    typeof data.ARK.BTC.fees.minerFees === 'number'
  );
};

export type CreateSubmarineSwapResponse = {
  id: string;
  address: string;
  expectedAmount: number;
  claimPublicKey: string;
  acceptZeroConf: boolean;
  timeoutBlockHeights: {
    unilateralClaim: number;
    unilateralRefund: number;
    unilateralRefundWithoutReceiver: number;
  };
};

export const isCreateSubmarineSwapResponse = (data: any): data is CreateSubmarineSwapResponse => {
  return (
    data &&
    typeof data === 'object' &&
    typeof data.id === 'string' &&
    typeof data.address === 'string' &&
    typeof data.expectedAmount === 'number' &&
    typeof data.claimPublicKey === 'string' &&
    typeof data.acceptZeroConf === 'boolean' &&
    data.timeoutBlockHeights &&
    typeof data.timeoutBlockHeights === 'object' &&
    typeof data.timeoutBlockHeights.unilateralClaim === 'number' &&
    typeof data.timeoutBlockHeights.unilateralRefund === 'number' &&
    typeof data.timeoutBlockHeights.unilateralRefundWithoutReceiver === 'number'
  );
};

export type CreateReverseSwapResponse = {
  id: string;
  invoice: string;
  onchainAmount: number;
  lockupAddress: string;
  refundPublicKey: string;
  timeoutBlockHeights: {
    refund: number;
    unilateralClaim: number;
    unilateralRefund: number;
    unilateralRefundWithoutReceiver: number;
  };
};

export const isCreateReverseSwapResponse = (data: any): data is CreateReverseSwapResponse => {
  return (
    data &&
    typeof data === 'object' &&
    typeof data.id === 'string' &&
    typeof data.invoice === 'string' &&
    typeof data.onchainAmount === 'number' &&
    typeof data.lockupAddress === 'string' &&
    typeof data.refundPublicKey === 'string' &&
    data.timeoutBlockHeights &&
    typeof data.timeoutBlockHeights === 'object' &&
    typeof data.timeoutBlockHeights.unilateralClaim === 'number' &&
    typeof data.timeoutBlockHeights.unilateralRefund === 'number' &&
    typeof data.timeoutBlockHeights.unilateralRefundWithoutReceiver === 'number'
  );
};

const BASE_URLS: Record<Network, string> = {
  mainnet: 'https://api.boltz.exchange',
  testnet: 'https://api.testnet.boltz.exchange',
  regtest: 'http://localhost:9090',
};

export class BoltzSwapProvider {
  private readonly wsUrl: string;
  private readonly apiUrl: string;
  private readonly network: Network;

  constructor(config: SwapProviderConfig) {
    this.network = config.network;
    this.apiUrl = config.apiUrl || BASE_URLS[config.network];
    this.wsUrl = this.apiUrl.replace(/^http(s)?:\/\//, 'ws$1://');
  }

  public getNetwork(): Network {
    return this.network;
  }

  async getLimits(): Promise<LimitsResponse> {
    const response = await this.request<GetPairsResponse>('/v2/swap/submarine', 'GET');
    if (!isGetPairsResponse(response)) throw new NetworkError(`Invalid response from API`);
    return {
      min: response.ARK.BTC.limits.minimal,
      max: response.ARK.BTC.limits.maximal,
    };
  }

  async getSwapStatus(id: string): Promise<SwapStatusResponse> {
    const response = await this.request<SwapStatusResponse>(`/swap/${id}`, 'GET');
    if (!isSwapStatusResponse(response)) throw new NetworkError('Invalid response from API');
    return response;
  }

  async createSubmarineSwap(invoice: string, refundPublicKey: string): Promise<CreateSubmarineSwapResponse> {
    const response = await this.request<CreateSubmarineSwapResponse>('/v2/swap/submarine', 'POST', {
      from: 'ARK',
      to: 'BTC',
      invoice,
      refundPublicKey,
    });
    if (!isCreateSubmarineSwapResponse(response)) throw new NetworkError('Invalid response from API');
    return response;
  }

  async createReverseSwap(
    invoiceAmount: number,
    claimPublicKey: string,
    preimageHash: string
  ): Promise<CreateReverseSwapResponse> {
    const response = await this.request<CreateReverseSwapResponse>('/v2/swap/reverse', 'POST', {
      from: 'BTC',
      to: 'ARK',
      invoiceAmount,
      claimPublicKey,
      preimageHash,
    });
    if (!isCreateReverseSwapResponse(response)) throw new NetworkError('Invalid response from API');
    if (!response.invoice) throw new NetworkError('Failed to create reverse swap invoice');
    return response;
  }

  async monitorSwap(swapId: string, update: (type: SwapStatus, data?: any) => void): Promise<void> {
    const webSocket = new WebSocket(this.wsUrl);

    webSocket.onerror = (error) => {
      console.error('WebSocket error:', error);
      update('failed', 'WebSocket connection failed');
    };

    webSocket.onopen = () => {
      webSocket.send(
        JSON.stringify({
          op: 'subscribe',
          channel: 'swap.update',
          args: [swapId],
        })
      );
    };

    webSocket.onmessage = async (rawMsg) => {
      const msg = JSON.parse(rawMsg.data as string);

      // we are only interested in updates for the specific swap
      if (msg.event !== 'update' || msg.args[0].id !== swapId) return;

      if (msg.args[0].error) {
        webSocket.close();
        update('failed', `WebSocket error message received: ${msg.args[0].error}`);
      }

      switch (msg.args[0].status as SwapStages) {
        case 'swap.created': {
          console.log('Waiting for invoice to be paid');
          update('pending');
          break;
        }

        // Boltz's lockup transaction is found in the mempool (or already confirmed)
        // which will only happen after the user paid the Lightning hold invoice
        case 'transaction.mempool':
        case 'transaction.confirmed': {
          console.log('Transaction is in mempool or confirmed');
          update('claimable');
          break;
        }

        case 'invoice.settled': {
          webSocket.close();
          console.log('Invoice was settled');
          update('completed');
          break;
        }

        case 'invoice.expired': {
          webSocket.close();
          update('failed', 'Invoice expired');
          break;
        }

        case 'swap.expired': {
          webSocket.close();
          update('failed', 'Swap expired');
          break;
        }

        case 'transaction.failed': {
          webSocket.close();
          update('failed', 'Transaction failed');
          break;
        }

        case 'transaction.refunded': {
          webSocket.close();
          update('failed', 'Transaction refunded');
        }
      }
    };
  }

  private async request<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    try {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new NetworkError(`Boltz API error: ${response.status} ${errorBody}`);
      }
      if (response.headers.get('content-length') === '0') {
        throw new NetworkError('Empty response from Boltz API');
      }
      // Use type assertion to T, as we expect the API to return the correct type
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof NetworkError) throw error;
      throw new NetworkError(`Request to ${url} failed: ${(error as Error).message}`);
    }
  }
}
