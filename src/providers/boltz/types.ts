import { Network } from '../../types';

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
      (data.transaction && typeof data.transaction === 'object' &&
       typeof data.transaction.id === 'string' && typeof data.transaction.hex === 'string'))
  );
};

export type SubmarineSwapGetResponse = {
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

export const isSubmarineSwapGetResponse = (data: any): data is SubmarineSwapGetResponse => {
  return (
    data &&
    typeof data === 'object' &&
    data.ARK && typeof data.ARK === 'object' &&
    data.ARK.BTC && typeof data.ARK.BTC === 'object' &&
    typeof data.ARK.BTC.hash === 'string' &&
    typeof data.ARK.BTC.rate === 'number' &&
    data.ARK.BTC.limits && typeof data.ARK.BTC.limits === 'object' &&
    typeof data.ARK.BTC.limits.maximal === 'number' &&
    typeof data.ARK.BTC.limits.minimal === 'number' &&
    typeof data.ARK.BTC.limits.maximalZeroConf === 'number' &&
    data.ARK.BTC.fees && typeof data.ARK.BTC.fees === 'object' &&
    typeof data.ARK.BTC.fees.percentage === 'number' &&
    typeof data.ARK.BTC.fees.minerFees === 'number'
  );
};

export type SubmarineSwapPostResponse = {
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

export const isSubmarineSwapPostResponse = (data: any): data is SubmarineSwapPostResponse => {
  return (
    data &&
    typeof data === 'object' &&
    typeof data.id === 'string' &&
    typeof data.address === 'string' &&
    typeof data.expectedAmount === 'number' &&
    typeof data.claimPublicKey === 'string' &&
    typeof data.acceptZeroConf === 'boolean' &&
    data.timeoutBlockHeights && typeof data.timeoutBlockHeights === 'object' &&
    typeof data.timeoutBlockHeights.unilateralClaim === 'number' &&
    typeof data.timeoutBlockHeights.unilateralRefund === 'number' &&
    typeof data.timeoutBlockHeights.unilateralRefundWithoutReceiver === 'number'
  );
};

export type ReverseSwapPostResponse = {
  id: string;
  invoice: string;
  onchainAmount: number;
  lockupAddress: string;
  refundPublicKey: string;
  timeoutBlockHeights: {
    unilateralClaim: number;
    unilateralRefund: number;
    unilateralRefundWithoutReceiver: number;
  };
};

export const isReverseSwapPostResponse = (data: any): data is ReverseSwapPostResponse => {
  return (
    data &&
    typeof data === 'object' &&
    typeof data.id === 'string' &&
    typeof data.invoice === 'string' &&
    typeof data.onchainAmount === 'number' &&
    typeof data.lockupAddress === 'string' &&
    typeof data.refundPublicKey === 'string' &&
    data.timeoutBlockHeights && typeof data.timeoutBlockHeights === 'object' &&
    typeof data.timeoutBlockHeights.unilateralClaim === 'number' &&
    typeof data.timeoutBlockHeights.unilateralRefund === 'number' &&
    typeof data.timeoutBlockHeights.unilateralRefundWithoutReceiver === 'number'
  );
};
