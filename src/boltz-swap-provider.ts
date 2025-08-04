import { NetworkError, SchemaError, SwapError } from './errors';
import { Network } from './types';

export interface SwapProviderConfig {
  apiUrl?: string;
  network: Network;
}

export type LimitsResponse = {
  min: number;
  max: number;
};

// Boltz swap status types
export type BoltzSwapStatus =
  | 'invoice.expired'
  | 'invoice.failedToPay'
  | 'invoice.paid'
  | 'invoice.pending'
  | 'invoice.set'
  | 'invoice.settled'
  | 'swap.created'
  | 'swap.expired'
  | 'transaction.claim.pending'
  | 'transaction.claimed'
  | 'transaction.confirmed'
  | 'transaction.failed'
  | 'transaction.lockupFailed'
  | 'transaction.mempool'
  | 'transaction.refunded';

export type GetSwapStatusResponse = {
  status: BoltzSwapStatus;
  zeroConfRejected?: boolean;
  transaction?: {
    id: string;
    hex: string;
    preimage?: string;
  };
};

export const isGetSwapStatusResponse = (data: any): data is GetSwapStatusResponse => {
  return (
    data &&
    typeof data === 'object' &&
    typeof data.status === 'string' &&
    (data.zeroConfRejected === undefined || typeof data.zeroConfRejected === 'boolean') &&
    (data.transaction === undefined ||
      (data.transaction &&
        typeof data.transaction === 'object' &&
        typeof data.transaction.id === 'string' &&
        typeof data.transaction.hex === 'string' &&
        (data.transaction.preimage === undefined || typeof data.transaction.preimage === 'string')))
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

export type CreateSubmarineSwapRequest = {
  invoice: string;
  refundPublicKey: string;
};

export type CreateSubmarineSwapResponse = {
  id: string;
  address: string;
  expectedAmount: number;
  claimPublicKey: string;
  acceptZeroConf: boolean;
  timeoutBlockHeights: {
    refund: number;
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

export type CreateReverseSwapRequest = {
  claimPublicKey: string;
  invoiceAmount: number;
  preimageHash: string;
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
    typeof data.timeoutBlockHeights.refund === 'number' &&
    typeof data.timeoutBlockHeights.unilateralClaim === 'number' &&
    typeof data.timeoutBlockHeights.unilateralRefund === 'number' &&
    typeof data.timeoutBlockHeights.unilateralRefundWithoutReceiver === 'number'
  );
};

const BASE_URLS: Record<Network, string> = {
  bitcoin: 'https://boltz.arkade.sh',
  mutinynet: 'https://boltz.mutinynet.arkade.sh',
  testnet: 'https://boltz.testnet.arkade.sh',
  regtest: 'http://localhost:9069',
};

export class BoltzSwapProvider {
  private readonly wsUrl: string;
  private readonly apiUrl: string;
  private readonly network: Network;

  constructor(config: SwapProviderConfig) {
    this.network = config.network;
    this.apiUrl = config.apiUrl || BASE_URLS[config.network];
    this.wsUrl = this.apiUrl.replace(/^http(s)?:\/\//, 'ws$1://').replace('9069', '9004') + '/v2/ws';
  }

  getApiUrl(): string {
    return this.apiUrl;
  }

  getWsUrl(): string {
    return this.wsUrl;
  }

  getNetwork(): Network {
    return this.network;
  }

  async getLimits(): Promise<LimitsResponse> {
    const response = await this.request<GetPairsResponse>('/v2/swap/submarine', 'GET');
    if (!isGetPairsResponse(response)) throw new SchemaError({ message: 'error fetching limits' });
    return {
      min: response.ARK.BTC.limits.minimal,
      max: response.ARK.BTC.limits.maximal,
    };
  }

  async getSwapStatus(id: string): Promise<GetSwapStatusResponse> {
    const response = await this.request<GetSwapStatusResponse>(`/v2/swap/${id}`, 'GET');
    if (!isGetSwapStatusResponse(response)) throw new SchemaError({ message: `error fetching status for swap: ${id}` });
    return response;
  }

  async createSubmarineSwap({
    invoice,
    refundPublicKey,
  }: CreateSubmarineSwapRequest): Promise<CreateSubmarineSwapResponse> {
    // if refundPublicKey is a xOnlyPublicKey, we need the compressed version
    if (refundPublicKey.length == 64) refundPublicKey = '02' + refundPublicKey;
    // make submarine swap request
    const response = await this.request<CreateSubmarineSwapResponse>('/v2/swap/submarine', 'POST', {
      from: 'ARK',
      to: 'BTC',
      invoice,
      refundPublicKey,
    });
    if (!isCreateSubmarineSwapResponse(response)) throw new SchemaError({ message: 'Error creating submarine swap' });
    return response;
  }

  async createReverseSwap({
    invoiceAmount,
    claimPublicKey,
    preimageHash,
  }: CreateReverseSwapRequest): Promise<CreateReverseSwapResponse> {
    // if claimPublicKey is a xOnlyPublicKey, we need the compressed version
    if (claimPublicKey.length == 64) claimPublicKey = '02' + claimPublicKey;
    // make reverse swap request
    const response = await this.request<CreateReverseSwapResponse>('/v2/swap/reverse', 'POST', {
      from: 'BTC',
      to: 'ARK',
      invoiceAmount,
      claimPublicKey,
      preimageHash,
    });
    if (!isCreateReverseSwapResponse(response)) throw new SchemaError({ message: 'Error creating reverse swap' });
    return response;
  }

  async monitorSwap(swapId: string, update: (type: BoltzSwapStatus, data?: any) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const webSocket = new globalThis.WebSocket(this.wsUrl);

      const connectionTimeout = setTimeout(() => {
        webSocket.close();
        reject(new NetworkError('WebSocket connection timeout'));
      }, 30000); // 30 second timeout

      webSocket.onerror = (error) => {
        clearTimeout(connectionTimeout);
        reject(new NetworkError(`WebSocket error: ${error.message}`));
      };

      webSocket.onopen = () => {
        clearTimeout(connectionTimeout);
        webSocket.send(
          JSON.stringify({
            op: 'subscribe',
            channel: 'swap.update',
            args: [swapId],
          })
        );
      };

      webSocket.onclose = () => {
        clearTimeout(connectionTimeout);
        resolve();
      };

      webSocket.onmessage = async (rawMsg) => {
        const msg = JSON.parse(rawMsg.data as string);

        // we are only interested in updates for the specific swap
        if (msg.event !== 'update' || msg.args[0].id !== swapId) return;

        if (msg.args[0].error) {
          webSocket.close();
          reject(new SwapError({ message: msg.args[0].error }));
        }

        const status = msg.args[0].status as BoltzSwapStatus;

        switch (status) {
          case 'invoice.settled':
          case 'transaction.claimed':
          case 'transaction.refunded':
          case 'invoice.expired':
          case 'invoice.failedToPay':
          case 'transaction.failed':
          case 'transaction.lockupFailed':
          case 'swap.expired':
            webSocket.close();
            update(status);
            break;
          case 'invoice.paid':
          case 'invoice.pending':
          case 'invoice.set':
          case 'swap.created':
          case 'transaction.claim.pending':
          case 'transaction.confirmed':
          case 'transaction.mempool':
            update(status);
        }
      };
    });
  }

  private async request<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    try {
      const response = await globalThis.fetch(url, {
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
