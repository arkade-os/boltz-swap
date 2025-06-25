import { SwapData } from './types';

export class SwapError extends Error {
  public isRefundable: boolean;
  public swapData?: SwapData;

  constructor(message: string, options: { isRefundable?: boolean; swapData?: SwapData } = {}) {
    super(message);
    this.name = 'SwapError';
    this.isRefundable = options.isRefundable ?? false;
    this.swapData = options.swapData;
  }
}

export class InvoiceExpiredError extends SwapError {
  constructor(message: string = 'The invoice has expired.') {
    super(message);
    this.name = 'InvoiceExpiredError';
  }
}

export class InsufficientFundsError extends SwapError {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientFundsError';
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}
