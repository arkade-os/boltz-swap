import { base64, hex } from "@scure/base";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";

// Arkade enforcement script pinning output[currentInputIndex] to the given
// P2TR pkScript with value >= input value. Layout:
//   OP_PUSHCURRENTINPUTINDEX OP_DUP OP_INSPECTOUTPUTSCRIPTPUBKEY
//   OP_1 OP_EQUALVERIFY <witnessProgram> OP_EQUALVERIFY
//   OP_INSPECTOUTPUTVALUE OP_PUSHCURRENTINPUTINDEX OP_INSPECTINPUTVALUE
//   OP_GREATERTHANOREQUAL
export function enforcePayTo(p2tr: Uint8Array): Uint8Array {
    if (p2tr.length !== 34 || p2tr[0] !== 0x51 || p2tr[1] !== 0x20) {
        throw new Error("offlineReceive: expected v1 P2TR pkScript");
    }
    return new Uint8Array([
        0xcd, // OP_PUSHCURRENTINPUTINDEX
        0x76, // OP_DUP
        0xd1, // OP_INSPECTOUTPUTSCRIPTPUBKEY
        0x51, // OP_1
        0x88, // OP_EQUALVERIFY
        0x20, // OP_DATA_32
        ...p2tr.slice(2),
        0x88, // OP_EQUALVERIFY
        0xcf, // OP_INSPECTOUTPUTVALUE
        0xcd, // OP_PUSHCURRENTINPUTINDEX
        0xc9, // OP_INSPECTINPUTVALUE
        0xa2, // OP_GREATERTHANOREQUAL
    ]);
}

export function computeArkadeScriptPubkey(
    introPubkey: Uint8Array,
    script: Uint8Array
): Uint8Array {
    const tag = schnorr.utils.taggedHash("ArkScriptHash", script);
    const xOnly =
        introPubkey.length === 33 ? introPubkey.subarray(1) : introPubkey;
    const point = secp256k1.Point.fromHex("02" + hex.encode(xOnly));
    let scalar = 0n;
    for (const b of tag) scalar = (scalar << 8n) | BigInt(b);
    scalar = scalar % secp256k1.Point.CURVE().n || 1n;
    const tweak = secp256k1.Point.BASE.multiply(scalar);
    return point.add(tweak).toBytes().subarray(1);
}

export async function registerOfflineReceive(
    bancodUrl: string,
    preimage: Uint8Array,
    arkadeScript: Uint8Array,
    taptree: string[]
): Promise<string> {
    const r = await fetch(`${bancodUrl}/v1/preimage/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            preimage: base64.encode(preimage),
            arkade_script: base64.encode(arkadeScript),
            taptree,
        }),
    });
    if (!r.ok) {
        throw new Error(
            `bancod register failed: ${r.status} ${await r.text()}`
        );
    }
    const body = (await r.json()) as Record<string, string>;
    const claimAddress = body.claimAddress ?? body.claim_address;
    if (!claimAddress) {
        throw new Error(`bancod register: missing claim_address in response`);
    }
    return claimAddress;
}
