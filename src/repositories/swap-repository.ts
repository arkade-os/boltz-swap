import { PendingReverseSwap, PendingSubmarineSwap } from "../types";
import { BoltzSwapStatus } from "../boltz-swap-provider";

export type PendingSwap = PendingReverseSwap | PendingSubmarineSwap;

export type GetSwapsFilter = {
    id?: string | string[];
    status?: BoltzSwapStatus | BoltzSwapStatus[];
    type?: PendingSwap["type"] | PendingSwap["type"][];
    orderBy?: "createdAt";
    orderDirection?: "asc" | "desc";
};

export interface SwapRepository extends AsyncDisposable {
    saveSwap<T extends PendingSwap>(swap: T): Promise<void>;
    deleteSwap(id: string): Promise<void>;
    getAllSwaps<T extends PendingSwap>(filter?: GetSwapsFilter): Promise<T[]>;

    clear(): Promise<void>;
};;
