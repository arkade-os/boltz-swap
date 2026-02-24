import type { PendingSwap } from "./types";

interface ErrorOptions {
    message?: string;
    isClaimable?: boolean;
    isRefundable?: boolean;
    pendingSwap?: PendingSwap;
}

export class SwapError extends Error {
    public isClaimable: boolean;
    public isRefundable: boolean;
    public pendingSwap?: PendingSwap;

    constructor(options: ErrorOptions = {}) {
        super(options.message ?? "Error during swap.");
        this.name = "SwapError";
        this.isClaimable = options.isClaimable ?? false;
        this.isRefundable = options.isRefundable ?? false;
        this.pendingSwap = options.pendingSwap;
    }
}

export class NetworkError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NetworkError";
    }
}

export class SchemaError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SchemaError";
    }
}

export class InvoiceExpiredError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ ...options, message: options.message ?? "Invoice expired." });
        this.name = "InvoiceExpiredError";
    }
}

export class SwapExpiredError extends SwapError {
    constructor(options: ErrorOptions = {}) {
        super({ ...options, message: options.message ?? "Swap expired." });
        this.name = "SwapExpiredError";
    }
}
