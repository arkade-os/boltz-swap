import { SwapRepository } from "../swap-repository";
import { PendingReverseSwap, PendingSubmarineSwap } from "../../types";

export class InMemorySwapRepository implements SwapRepository{
    private readonly reverseSwaps: Map<string, PendingReverseSwap> = new Map();
    private readonly submarineSwaps: Map<string, PendingSubmarineSwap> = new Map();


    async saveReverseSwap(swap: PendingReverseSwap): Promise<void> {
        this.reverseSwaps.set(swap.id, swap);
    }

    async saveSubmarineSwap(swap: PendingSubmarineSwap): Promise<void> {
        this.submarineSwaps.set(swap.id, swap);
    }

    async deleteReverseSwap(id: string): Promise<void> {
        this.reverseSwaps.delete(id);
    }

    async deleteSubmarineSwap(id: string): Promise<void> {
        this.submarineSwaps.delete(id);
    }

    async getReverseSwap(id: string): Promise<PendingReverseSwap | undefined> {
        return this.reverseSwaps.get(id);
    }

    async getSubmarineSwap(id: string): Promise<PendingSubmarineSwap | undefined> {
        return this.submarineSwaps.get(id);
    }

    async getAllReverseSwaps(): Promise<PendingReverseSwap[]> {
        return Array.from(this.reverseSwaps.values());
    }

    async getAllSubmarineSwaps(): Promise<PendingSubmarineSwap[]> {
        return Array.from(this.submarineSwaps.values());
    }

    async clear(): Promise<void> {
        this.reverseSwaps.clear();
        this.submarineSwaps.clear();
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.clear();
    }
}
