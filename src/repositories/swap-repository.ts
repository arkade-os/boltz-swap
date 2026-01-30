import { PendingReverseSwap, PendingSubmarineSwap } from "../types";

export interface SwapRepository extends AsyncDisposable {
    saveReverseSwap(swap: PendingReverseSwap): Promise<void>;
    saveSubmarineSwap(swap: PendingSubmarineSwap): Promise<void>;
    deleteReverseSwap(id: string): Promise<void>;
    deleteSubmarineSwap(id: string): Promise<void>;
    getReverseSwap(id: string): Promise<PendingReverseSwap | undefined>;
    getSubmarineSwap(id: string): Promise<PendingSubmarineSwap | undefined>;
    getAllReverseSwaps(): Promise<PendingReverseSwap[]>;
    getAllSubmarineSwaps(): Promise<PendingSubmarineSwap[]>;

    clear(): Promise<void>;
}