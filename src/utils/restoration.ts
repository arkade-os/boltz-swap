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
    // split the script into opcodes
    const opcodes = script.toASM(hex.decode(someHex)).split(" ");

    // look for OP_NOP2 (CLTV - OP_CHECKLOCKTIMEVERIFY)
    const hasCLTV = opcodes.findIndex((op) => op === "OP_NOP2");

    if (hasCLTV !== -1) {
        const dataHex = opcodes[hasCLTV - 1];
        const dataBytes = hex.decode(dataHex).reverse(); // reverse for little-endian
        return parseInt(hex.encode(dataBytes), 16);
    }

    // look for OP_NOP3 (CSV - OP_CHECKSEQUENCEVERIFY)
    const hasCSV = opcodes.findIndex((op) => op === "OP_NOP3");

    if (hasCSV !== -1) {
        const dataHex = opcodes[hasCSV - 1];
        const dataBytes = hex.decode(dataHex).reverse(); // reverse for little-endian
        const { blocks, seconds }: { blocks?: number; seconds?: number } =
            bip68.decode(parseInt(hex.encode(dataBytes), 16));
        return blocks ? blocks : seconds ? seconds : 0;
    }

    return 0;
}

export function extractInvoiceAmount(
    amountSats: number | undefined,
    fees: FeesResponse
): number {
    if (!amountSats) return 0;
    const { percentage, minerFees } = fees.reverse;
    const miner = minerFees.lockup + minerFees.claim;
    return Math.ceil((amountSats - miner) / (1 - percentage / 100));
}
