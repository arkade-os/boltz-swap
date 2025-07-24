import { PendingReverseSwap, PendingSubmarineSwap } from './types';

export class SwapError extends Error {
  public isClaimable: boolean;
  public isRefundable: boolean;
  public swapData?: PendingReverseSwap | PendingSubmarineSwap;

  constructor(
    message: string,
    options: {
      isClaimable?: boolean;
      isRefundable?: boolean;
      swapData?: PendingReverseSwap | PendingSubmarineSwap;
    } = {}
  ) {
    super(message);
    this.name = 'SwapError';
    this.isClaimable = options.isClaimable ?? false;
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

export class InvoiceFailedToPayError extends SwapError {
  constructor(message: string = 'The invoice has failed to pay.') {
    super(message);
    this.name = 'InvoiceFailedToPayError';
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

export class SchemaError extends SwapError {
  constructor(
    message: string,
    options: {
      swapData?: PendingReverseSwap | PendingSubmarineSwap;
    } = {}
  ) {
    super(message, options);
    this.name = 'SchemaError';
  }
}

export class SwapExpiredError extends SwapError {
  constructor(message: string = 'The swap has expired.') {
    super(message);
    this.name = 'SwapExpiredError';
  }
}

export class TransactionFailedError extends SwapError {
  constructor(message: string = 'The transaction has failed.') {
    super(message);
    this.name = 'TransactionFailedError';
  }
}

export class TransactionLockupFailedError extends SwapError {
  constructor(message: string = 'The transaction lockup has failed.') {
    super(message);
    this.name = 'TransactionLockupFailedError';
  }
}

export class TransactionRefundedError extends SwapError {
  constructor(message: string = 'The transaction has been refunded.') {
    super(message);
    this.name = 'TransactionRefundedError';
  }
}
