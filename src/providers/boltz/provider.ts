import { fetch } from 'undici';
import { NetworkError } from '../../errors';
import { Network } from '../../types';
import { WebSocket } from 'ws';
import {
  LimitsResponse,
  SubmarineSwapGetResponse,
  isSubmarineSwapGetResponse,
  SwapStatusResponse,
  isSwapStatusResponse,
  SubmarineSwapPostResponse,
  isSubmarineSwapPostResponse,
  ReverseSwapPostResponse,
  isReverseSwapPostResponse,
  SwapProviderConfig,
} from './types';

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
    const response = await this.request<SubmarineSwapGetResponse>('/v2/swap/submarine', 'GET');
    if (!isSubmarineSwapGetResponse(response)) throw new NetworkError(`Invalid response from API`);
    return {
      min: response.ARK.BTC.limits.minimal,
      max: response.ARK.BTC.limits.maximal,
    };
  }

  async getSwapStatus(id: string): Promise<SwapStatusResponse> {
    const response = this.request<SwapStatusResponse>(`/swap/${id}`, 'GET');
    if (!isSwapStatusResponse(response)) throw new NetworkError('Invalid response from API');
    return response;
  }

  async createSubmarineSwap(invoice: string, refundPublicKey: string): Promise<SubmarineSwapPostResponse> {
    const response = await this.request<SubmarineSwapPostResponse>('/v2/swap/submarine', 'POST', {
      from: 'ARK',
      to: 'BTC',
      invoice,
      refundPublicKey,
    });
    if (!isSubmarineSwapPostResponse(response)) throw new NetworkError('Invalid response from API');
    return response;
  }

  async createReverseSwap(
    invoiceAmount: number,
    claimPublicKey: string,
    preimageHash: string
  ): Promise<ReverseSwapPostResponse> {
    const response = await this.request<ReverseSwapPostResponse>('/v2/swap/reverse', 'POST', {
      from: 'BTC',
      to: 'ARK',
      invoiceAmount,
      claimPublicKey,
      preimageHash,
    });
    if (!isReverseSwapPostResponse(response)) throw new NetworkError('Invalid response from API');
    if (response.invoice) throw new NetworkError('Failed to create reverse swap invoice');
    return { ...response };
  }

  async waitAndClaim(swapInfo: ReverseSwapPostResponse, preimage: string, claimVHTLC: any): Promise<void> {
    return new Promise((res, rej) => {
      const webSocket = new WebSocket(this.wsUrl);

      const reject = (error: string) => {
        if (webSocket?.close) webSocket.close();
        rej(error);
      };

      const resolve = () => {
        if (webSocket?.close) webSocket.close();
        res();
      };

      webSocket.onerror = (error) => {
        console.error('WebSocket error:', error);
        reject('WebSocket connection failed');
      };

      webSocket.onopen = () => {
        webSocket.send(
          JSON.stringify({
            op: 'subscribe',
            channel: 'swap.update',
            args: [swapInfo.id],
          })
        );
      };

      webSocket.onmessage = async (rawMsg) => {
        const msg = JSON.parse(rawMsg.data as string);

        // we are only interested in updates for the specific swap
        if (msg.event !== 'update' || msg.args[0].id !== swapInfo.id) return;

        if (msg.args[0].error) {
          reject('WebSocket error message received: ' + msg.args[0].error);
        }

        switch (msg.args[0].status) {
          case 'swap.created': {
            console.log('Waiting for invoice to be paid');
            break;
          }

          // Boltz's lockup transaction is found in the mempool (or already confirmed)
          // which will only happen after the user paid the Lightning hold invoice
          case 'transaction.mempool':
          case 'transaction.confirmed': {
            await claimVHTLC({ preimage, swapInfo });
            break;
          }

          case 'invoice.settled': {
            console.log('Invoice was settled');
            resolve();
            break;
          }

          case 'invoice.expired': {
            reject('Invoice expired');
            break;
          }

          case 'swap.expired': {
            reject('Swap expired');
            break;
          }

          case 'transaction.failed': {
            reject('Transaction failed');
            break;
          }

          case 'transaction.refunded': {
            reject('Transaction refunded');
          }
        }
      };
    });
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
