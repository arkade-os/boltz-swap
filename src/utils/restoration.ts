import { hex } from "@scure/base";
import { FeesResponse } from "../types";

/**
 * Extracts and calculates the relative timelock (sequence value) from a Bitcoin script hex string
 * based on BIP 68 (OP_CHECKSEQUENCEVERIFY).
 * @param scriptHex The Bitcoin script in hexadecimal format.
 * @returns The timelock value in blocks or seconds.
 */
export function extractTimeLockFromLeafOutput(someHex: string): number {
    // remove P2SH wrapper if present (total 24 bytes)
    // OP_HASH160 OP_PUSHBYTES_20 <20 bytes> OP_EQUAL OP_VERIFY
    const scriptHex = someHex.startsWith("a914")
        ? someHex.substring(48)
        : someHex;

    // extract the number of bytes pushed onto the stack
    const pushBytes = parseInt(scriptHex.substring(0, 2), 16);

    // extract the data bytes and the opcode
    const lastByteIndex = 2 + pushBytes * 2;
    const dataBytesHex = scriptHex.substring(2, lastByteIndex);
    const opcodeHex = scriptHex.substring(lastByteIndex, lastByteIndex + 2);

    // check if the opcode is OP_CHECKLOCKTIMEVERIFY (0xb1) or OP_CHECKSEQUENCEVERIFY (0xb2)
    if (opcodeHex !== "b1" && opcodeHex !== "b2") {
        throw new Error(
            "Script does not end with OP_CHECKLOCKTIMEVERIFY or OP_CHECKSEQUENCEVERIFY"
        );
    }

    // compute the sequence value
    const dataBytes = hex.decode(dataBytesHex).reverse(); // Reverse for little-endian
    const sequenceValue = parseInt(hex.encode(dataBytes), 16);

    // return immediatelly if OP_CHECKLOCKTIMEVERIFY
    if (opcodeHex === "b1") return sequenceValue;

    // Bit 22 flag: 1 << 22 = 0x400000 (Signals Time units)
    const SEQUENCE_LOCKTIME_TYPE_FLAG = 1 << 22;

    // Lower 16 bits mask: 0x0000ffff (The actual timelock value)
    const SEQUENCE_LOCKTIME_MASK = 0x0000ffff;

    // Check if the Time Flag (Bit 22) is set
    const isTime = (sequenceValue & SEQUENCE_LOCKTIME_TYPE_FLAG) !== 0;

    // Extract the relative timelock value (lower 16 bits)
    const value = sequenceValue & SEQUENCE_LOCKTIME_MASK;

    return isTime ? value * 512 : value;
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
