import { verifyTapscriptSignatures } from "@arkade-os/sdk";
import { Transaction } from "@scure/btc-signer";
import { hex } from "@scure/base";

export const verifySignatures = (
    tx: Transaction,
    inputIndex: number,
    requiredSigners: string[],
    expectedLeafHash: Uint8Array
): boolean => {
    try {
        verifyTapscriptSignatures(tx, inputIndex, requiredSigners);
    } catch (_) {
        return false;
    }

    const input = tx.getInput(inputIndex);
    const expectedHex = hex.encode(expectedLeafHash);
    return requiredSigners.every((signer) =>
        input.tapScriptSig?.some(
            ([{ pubKey, leafHash }]) =>
                hex.encode(pubKey) === signer &&
                hex.encode(leafHash) === expectedHex
        )
    );
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
