import { verifyTapscriptSignatures } from "@arkade-os/sdk";
import { Transaction } from "@scure/btc-signer";
import { hex } from "@scure/base";

export const verifySignatures = (
    tx: Transaction,
    inputIndex: number,
    requiredSigners: string[]
): boolean => {
    try {
        verifyTapscriptSignatures(tx, inputIndex, requiredSigners);
        return true;
    } catch (_) {
        return false;
    }
};

/**
 * Validate we are using a x-only public key
 * @param publicKey
 * @param keyName
 * @param swapId
 * @returns Uint8Array
 */
export const normalizeToXOnlyKey = (
    someKey: Uint8Array | string,
    keyName = "",
    swapId = ""
): Uint8Array => {
    const keyBytes =
        typeof someKey === "string" ? hex.decode(someKey) : someKey;
    if (keyBytes.length === 33) {
        return keyBytes.slice(1);
    }
    if (keyBytes.length !== 32) {
        throw new Error(
            `Invalid ${keyName} key length: ${keyBytes.length} ${swapId ? "for swap " + swapId : ""}`
        );
    }
    return keyBytes;
};
