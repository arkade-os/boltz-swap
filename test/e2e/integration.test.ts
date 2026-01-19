import { it } from "vitest";
import { ArkadeLightning, BoltzSwapProvider } from "../../src";
import { SingleKey, Wallet, EsploraProvider } from "@arkade-os/sdk";
import { exec } from "child_process";
import { promisify } from "util";
import { expect } from "vitest";

it("should recover swept VHTLCs", { timeout: 120_000 }, async () => {
    const { arkadeLightning, wallet } = await createTestWallet();

    const { stdout } = await promisify(exec)(
        `docker exec lnd lncli --network=regtest addinvoice --amt 1000`
    );
    const output = stdout.trim();
    expect(output).toBeDefined();
    expect(output).toBeTruthy();
    const outputJSON = JSON.parse(output);
    expect("payment_request" in outputJSON).toBeTruthy();
    const invoice = outputJSON.payment_request;

    const swap = await arkadeLightning.createSubmarineSwap({ invoice });
    // fund the vhtlc after fulmine is down so it can be swept
    exec(`docker compose -f test.docker-compose.yml stop boltz-fulmine`);
    exec(
        `docker exec -t arkd ark send --to ${swap.response.address} --amount ${swap.response.expectedAmount} --password secret`
    );

    // generate block to expire the vhtlc
    exec(
        `nigiri rpc generatetoaddress 21 bcrt1qlfc0juf4csvvfkvxhzygqgh523sc9ppvq4yz3v`
    );

    // sleep 30s to let arkd sweep the vhtlc
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    // try to refund (with boltz down and vhtlc swept)
    await arkadeLightning.refundVHTLC(swap);

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const balance = await wallet.getBalance();
    expect(balance.available).toBe(swap.response.expectedAmount);
});

export interface TestArkWallet {
    wallet: Wallet;
    identity: SingleKey;
    arkadeLightning: ArkadeLightning;
}

export async function createTestWallet(): Promise<TestArkWallet> {
    const identity = SingleKey.fromRandomBytes();

    const wallet = await Wallet.create({
        identity,
        arkServerUrl: "http://localhost:7070",
        onchainProvider: new EsploraProvider("http://localhost:3000", {
            forcePolling: true,
            pollingInterval: 2000,
        }),
    });

    return {
        wallet,
        identity,
        arkadeLightning: new ArkadeLightning({
            wallet,
            swapProvider: new BoltzSwapProvider({ network: "regtest" }),
        }),
    };
}
