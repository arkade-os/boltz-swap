import { PendingReverseSwap, PendingSubmarineSwap } from "../types";
import { BoltzSwapStatus } from "../boltz-swap-provider";

export type GetSwapsFilter = {
    id: string | string[];
    status: BoltzSwapStatus | BoltzSwapStatus[];
}

export interface SwapRepository extends AsyncDisposable {
    saveReverseSwap(swap: PendingReverseSwap): Promise<void>;
    saveSubmarineSwap(swap: PendingSubmarineSwap): Promise<void>;
    deleteReverseSwap(id: string): Promise<void>;
    deleteSubmarineSwap(id: string): Promise<void>;
    getAllReverseSwaps(filter?: GetSwapsFilter): Promise<PendingReverseSwap[]>;
    getAllSubmarineSwaps(filter?: GetSwapsFilter): Promise<PendingSubmarineSwap[]>;

    clear(): Promise<void>;
}