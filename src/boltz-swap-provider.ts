import { fetch } from 'undici';
import { NetworkError } from './errors';
import { BoltzSwapProviderConfig, SwapData, BoltzSwapStatusResponse, CreateSwapResponse, Network } from './types';

const BASE_URLS: Record<Network, string> = {
  mainnet: 'https://api.boltz.exchange',
  testnet: 'https://api.testnet.boltz.exchange',
  regtest: 'http://localhost:9090',
};

export class BoltzSwapProvider {
  private readonly apiUrl: string;
  private readonly network: Network;

  constructor(config: BoltzSwapProviderConfig) {
    this.apiUrl = config.apiUrl || BASE_URLS[config.network];
    this.network = config.network;
  }

  public getNetwork(): Network {
    return this.network;
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
        throw new NetworkError(
          `Boltz API error: ${response.status} ${errorBody}`
        );
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

  async getPairs(): Promise<SwapData[]> {
    return this.request<SwapData[]>('/getpairs', 'GET');
  }

  async createSubmarineSwap(invoice: string, refundPublicKey: string): Promise<CreateSwapResponse> {
    return this.request<CreateSwapResponse>('/createswap', 'POST', {
      type: 'submarine',
      pairId: 'BTC/BTC',
      orderSide: 'sell',
      invoice,
      refundPublicKey,
    });
  }

  async getSwapStatus(id: string): Promise<BoltzSwapStatusResponse> {
    return this.request<BoltzSwapStatusResponse>('/swapstatus', 'POST', { id });
  }
}