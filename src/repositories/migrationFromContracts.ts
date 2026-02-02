import { ContractRepositoryImpl } from "../../../ts-sdk/src/repositories/migrations/contractRepositoryImpl";
import { StorageAdapter } from "../../../ts-sdk/src/storage";
import { SwapRepository } from "./swap-repository";
import { PendingReverseSwap, PendingSubmarineSwap } from "../types";

const MIGRATION_KEY = "migration-from-storage-adapter-swaps";

export async function migrateToSwapRepository(
    storageAdapter: StorageAdapter,
    fresh: SwapRepository
) {
    const migration = await storageAdapter.getItem(MIGRATION_KEY);
    if (migration === "done") {
        return;
    }

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
        await fresh.saveSubmarineSwap(swap);
    }

    await storageAdapter.setItem(MIGRATION_KEY, "done");
}
