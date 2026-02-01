import { GetSwapsFilter, SwapRepository } from "../swap-repository";
import { PendingReverseSwap, PendingSubmarineSwap } from "../../types";

export class InMemorySwapRepository implements SwapRepository {
    private readonly reverseSwaps: Map<string, PendingReverseSwap> = new Map();
    private readonly submarineSwaps: Map<string, PendingSubmarineSwap> =
        new Map();

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

    async getAllReverseSwaps(
        filter?: GetSwapsFilter
    ): Promise<PendingReverseSwap[]> {
        const swaps = this.reverseSwaps.values();
        if (!filter) return [...swaps];
        return this.applySwapsFilter([...swaps], filter);
    }

    async getAllSubmarineSwaps(
        filter?: GetSwapsFilter
    ): Promise<PendingSubmarineSwap[]> {
        const swaps = this.submarineSwaps.values();
        if (!filter) return [...swaps];
        return this.applySwapsFilter([...swaps], filter);
    }

    async clear(): Promise<void> {
        this.reverseSwaps.clear();
        this.submarineSwaps.clear();
    }

    private applySwapsFilter<T extends { id: string; status: string }>(
        swaps: (T | undefined)[],
        filter: GetSwapsFilter
    ): T[] {
        const matches = <T>(value: T, criterion?: T | T[]) => {
            if (criterion === undefined) {
                return true;
            }
            return Array.isArray(criterion)
                ? criterion.includes(value)
                : value === criterion;
        };
        return swaps.filter(
            (swap): swap is T =>
                !!swap &&
                matches(swap.id, filter.id) &&
                matches(swap.status, filter.status)
        );
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.clear();
    }
}
