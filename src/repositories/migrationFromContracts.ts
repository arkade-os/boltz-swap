import { ContractRepositoryImpl } from "../../../ts-sdk/src/repositories/migrations/contractRepositoryImpl";
import { StorageAdapter } from "../../../ts-sdk/src/storage";
import { SwapRepository } from "./swap-repository";
import { PendingReverseSwap, PendingSubmarineSwap } from "../types";

export async function migrateToSwapRepository(
    storageAdapter: StorageAdapter,
    fresh: SwapRepository
) {
    // const oldStorage = new IndexedDBStorageAdapter("arkade-service-worker");
    const legacyContracts = new ContractRepositoryImpl(storageAdapter);
    // reverse swaps
    const reverseSwaps: readonly PendingReverseSwap[] =
        await legacyContracts.getContractCollection("reverseSwaps");
    const submarineSwaps: readonly PendingSubmarineSwap[] =
        await legacyContracts.getContractCollection("submarineSwaps");

    for (const swap of reverseSwaps) {
        await fresh.saveReverseSwap(swap);
    }

    for (const swap of submarineSwaps) {
        await fresh.saveSubmarineSwap(swap)
    }
}

