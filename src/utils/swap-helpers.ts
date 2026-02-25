import {
    isPendingChainSwap,
    isPendingReverseSwap,
    isPendingSubmarineSwap,
} from "../boltz-swap-provider";
import {
    PendingChainSwap,
    PendingReverseSwap,
    PendingSubmarineSwap,
    PendingSwap,
} from "../types";

/**
 * Generic type for swap save functions
 */
export type SwapSaver = {
    saveChainSwap?: (swap: PendingChainSwap) => Promise<void>;
    saveReverseSwap?: (swap: PendingReverseSwap) => Promise<void>;
    saveSubmarineSwap?: (swap: PendingSubmarineSwap) => Promise<void>;
};

/**
 * Save a swap of any type using the appropriate saver function
 * This eliminates the need for type checking in multiple places
 */
export async function saveSwap(
    swap: PendingSwap,
    saver: SwapSaver
): Promise<void> {
    if (isPendingReverseSwap(swap)) {
        if (saver.saveReverseSwap) {
            await saver.saveReverseSwap(swap);
        } else {
            console.warn("No saveReverseSwap handler provided, swap not saved");
        }
    } else if (isPendingSubmarineSwap(swap)) {
        if (saver.saveSubmarineSwap) {
            await saver.saveSubmarineSwap(swap);
        } else {
            console.warn(
                "No saveSubmarineSwap handler provided, swap not saved"
            );
        }
    } else if (isPendingChainSwap(swap)) {
        if (saver.saveChainSwap) {
            await saver.saveChainSwap(swap);
        } else {
            console.warn("No saveChainSwap handler provided, swap not saved");
        }
    }
}

/**
 * Update a reverse swap's status and save it
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

/**
 * Update a chain swap's status and save it
 */
export async function updateChainSwapStatus(
    swap: PendingChainSwap,
    status: PendingChainSwap["status"],
    saveFunc: (swap: PendingChainSwap) => Promise<void>,
    additionalFields?: Partial<PendingChainSwap>
): Promise<void> {
    await saveFunc({
        ...swap,
        status,
        ...additionalFields,
    });
}
