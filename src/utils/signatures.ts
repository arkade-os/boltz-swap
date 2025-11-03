import { verifyTapscriptSignatures } from "@arkade-os/sdk";
import { Transaction } from "@scure/btc-signer";

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
