import { BoltzSwap } from "../types";
import { BoltzSwapStatus } from "../boltz-swap-provider";

export type { BoltzSwap };

export type GetSwapsFilter = {
    id?: string | string[];
    status?: BoltzSwapStatus | BoltzSwapStatus[];
    type?: BoltzSwap["type"] | BoltzSwap["type"][];
    orderBy?: "createdAt";
    orderDirection?: "asc" | "desc";
};

export interface SwapRepository extends AsyncDisposable {
    readonly version: 1;

    saveSwap<T extends BoltzSwap>(swap: T): Promise<void>;
    /**
     * Atomically read the existing record for `swap.id`, merge incoming fields
     * on top (`{ ...existing, ...swap }`), and write back in a single
     * transaction.  Falls back to a plain insert when no record exists yet.
     */
    mergeAndSaveSwap<T extends BoltzSwap>(swap: T): Promise<void>;
    deleteSwap(id: string): Promise<void>;
    getAllSwaps<T extends BoltzSwap>(filter?: GetSwapsFilter): Promise<T[]>;

    clear(): Promise<void>;
}
