import { hex } from "@scure/base";
import { FeesResponse } from "../types";
import { script } from "bitcoinjs-lib";
// @ts-ignore
import bip68 from "bip68";

/**
 * Extracts and calculates the relative timelock from a Bitcoin script
 * @param scriptHex The Bitcoin script in hexadecimal format.
 * @returns The timelock value in blocks or seconds.
 */
export function extractTimeLockFromLeafOutput(someHex: string): number {
    // return 0 if no script provided
    if (!someHex) return 0;

    try {
        // split the script into opcodes
        const opcodes = script.toASM(hex.decode(someHex)).split(" ");

        // look for OP_NOP2 (CLTV - OP_CHECKLOCKTIMEVERIFY)
        const hasCLTV = opcodes.findIndex((op) => op === "OP_NOP2");

        if (hasCLTV > 0) {
            const dataHex = opcodes[hasCLTV - 1];
            const dataBytes = hex.decode(dataHex).reverse(); // reverse for little-endian
            return parseInt(hex.encode(dataBytes), 16);
        }

        // look for OP_NOP3 (CSV - OP_CHECKSEQUENCEVERIFY)
        const hasCSV = opcodes.findIndex((op) => op === "OP_NOP3");

        if (hasCSV > 0) {
            const dataHex = opcodes[hasCSV - 1];
            const dataBytes = hex.decode(dataHex).reverse(); // reverse for little-endian
            const { blocks, seconds }: { blocks?: number; seconds?: number } =
                bip68.decode(parseInt(hex.encode(dataBytes), 16));
            return blocks ?? seconds ?? 0;
        }
    } catch (error) {
        // Return 0 for malformed scripts
        return 0;
    }

    return 0;
}

export function extractInvoiceAmount(
    amountSats: number | undefined,
    fees: FeesResponse
): number {
    // validate inputs
    if (!amountSats) return 0;
    const { percentage, minerFees } = fees.reverse;
    const miner = minerFees.lockup + minerFees.claim;

    // validate inputs
    if (percentage >= 100 || percentage < 0) return 0;
    if (miner >= amountSats) return 0;

    return Math.ceil((amountSats - miner) / (1 - percentage / 100));
}
