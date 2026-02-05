import { TapLeafScript, Transaction } from "@arkade-os/sdk";
import { base64 } from "@scure/base";
import { TransactionInput } from "@scure/btc-signer/psbt.js";

/**
 * Validates the final Ark transaction.
 * checks that all inputs have a signature for the given pubkey
 * and the signature is correct for the given tapscript leaf
 * TODO: This is a simplified check, we should verify the actual signatures
 * @param finalArkTx The final Ark transaction in PSBT format.
 * @param _pubkey The public key of the user.
 * @param _tapLeaves The taproot script leaves.
 * @returns True if the final Ark transaction is valid, false otherwise.
 */
export function validFinalArkTx(
    finalArkTx: string,
    _pubkey: Uint8Array,
    _tapLeaves: TapLeafScript[]
): boolean {
    // decode the final Ark transaction
    const tx = Transaction.fromPSBT(base64.decode(finalArkTx), {
        allowUnknown: true,
    });
    if (!tx) return false;

    // push all inputs to an array
    const inputs: TransactionInput[] = [];
    for (let i = 0; i < tx.inputsLength; i++) {
        inputs.push(tx.getInput(i));
    }

    // basic check that all inputs have a witnessUtxo
    // this is a simplified check, we should verify the actual signatures
    return inputs.every((input) => input.witnessUtxo);
}
