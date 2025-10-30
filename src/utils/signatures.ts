import { Transaction } from "@arkade-os/sdk";

/**
 * Merges the signed checkpoint transactions with the original checkpoint transactions
 * @param signedCheckpointTxs Base64 encoded signed checkpoint transactions
 * @param originalCheckpointTxs Base64 encoded original checkpoint transactions
 */
export function mergeCheckpoints(
    signedCheckpointTxs: Transaction[],
    originalCheckpointTxs: Transaction[]
): Transaction[] {
    for (let i = 0; i < originalCheckpointTxs.length; i++) {
        const myCheckpointTx = originalCheckpointTxs[i];
        const signedCheckpointTx = signedCheckpointTxs.find(
            (_) => _.id === myCheckpointTx.id
        );
        if (!signedCheckpointTx) {
            throw new Error("Signed checkpoint not found");
        }
        // for every input, concatenate its signatures with the signature from the server
        for (let j = 0; j < myCheckpointTx.inputsLength; j++) {
            const input = myCheckpointTx.getInput(j);
            const inputFromServer = signedCheckpointTx.getInput(j);
            if (!inputFromServer.tapScriptSig)
                throw new Error("No tapScriptSig");
            myCheckpointTx.updateInput(i, {
                tapScriptSig: input.tapScriptSig?.concat(
                    inputFromServer.tapScriptSig
                ),
            });
        }
    }
    return originalCheckpointTxs;
}

export function mergeTxs(signedTx: Transaction, originalTx: Transaction) {
    for (let i = 0; i < signedTx.inputsLength; i++) {
        const input = originalTx.getInput(i);
        const inputFromServer = signedTx.getInput(i);
        if (!input.tapScriptSig) throw new Error("No tapScriptSig");
        originalTx.updateInput(i, {
            tapScriptSig: input.tapScriptSig?.concat(
                inputFromServer.tapScriptSig!
            ),
        });
    }
    return originalTx;
}
