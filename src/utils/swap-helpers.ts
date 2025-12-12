import {
    isPendingReverseSwap,
    isPendingSubmarineSwap,
} from "../boltz-swap-provider";
import { PendingReverseSwap, PendingSubmarineSwap } from "../types";

/**
 * Generic type for swap save functions
 */
export type SwapSaver = {
    saveReverseSwap: (swap: PendingReverseSwap) => Promise<void>;
    saveSubmarineSwap: (swap: PendingSubmarineSwap) => Promise<void>;
};

/**
 * Save a swap of any type using the appropriate saver function
 * This eliminates the need for type checking in multiple places
 */
export async function saveSwap(
    swap: PendingReverseSwap | PendingSubmarineSwap,
    saver: SwapSaver
): Promise<void> {
    if (isPendingReverseSwap(swap)) {
        await saver.saveReverseSwap(swap);
    } else if (isPendingSubmarineSwap(swap)) {
        await saver.saveSubmarineSwap(swap);
    }
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
