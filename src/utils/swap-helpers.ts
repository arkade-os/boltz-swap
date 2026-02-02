import { PendingSwap } from "../repositories/swap-repository";
import { PendingReverseSwap, PendingSubmarineSwap } from "../types";

/**
 * Generic type for swap save functions
 */
export type SwapSaver = {
    saveSwap: (swap: PendingSwap) => Promise<void>;
};

/**
 * Save a swap of any type using the appropriate saver function
 * This eliminates the need for type checking in multiple places
 */
export async function saveSwap(
    swap: PendingSwap,
    saver: SwapSaver
): Promise<void> {
    await saver.saveSwap(swap);
}

/**
 * Update a reverse swap's status and save it
 * This pattern appears ~10+ times in arkade-lightning.ts
 */
export async function updateReverseSwapStatus(
    swap: PendingReverseSwap,
    status: PendingReverseSwap["status"],
    saveFunc: (swap: PendingReverseSwap) => Promise<void>,
    additionalFields?: Partial<PendingReverseSwap>
): Promise<void> {
    await saveFunc({
        ...swap,
        status,
        ...additionalFields,
    });
}

/**
 * Update a submarine swap's status and save it
 * This pattern appears ~10+ times in arkade-lightning.ts
 */
export async function updateSubmarineSwapStatus(
    swap: PendingSubmarineSwap,
    status: PendingSubmarineSwap["status"],
    saveFunc: (swap: PendingSubmarineSwap) => Promise<void>,
    additionalFields?: Partial<PendingSubmarineSwap>
): Promise<void> {
    await saveFunc({
        ...swap,
        status,
        ...additionalFields,
    });
}
