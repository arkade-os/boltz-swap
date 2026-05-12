import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import {
    BoltzSwapProvider,
    BoltzSwapStatus,
} from "../../src/boltz-swap-provider";
import { sha256 } from "@scure/btc-signer/utils.js";
import { ArkadeSwaps } from "../../src/arkade-swaps";
import { schnorr } from "@noble/curves/secp256k1.js";
import { exec } from "child_process";
import { base64, hex } from "@scure/base";
import { promisify } from "util";
import {
    Wallet,
    Identity,
    SingleKey,
    RestArkProvider,
    EsploraProvider,
    RestIndexerProvider,
    InMemoryWalletRepository,
    InMemoryContractRepository,
    ArkAddress,
    isRecoverable,
    VHTLC,
    ArkInfo,
    ArkProvider,
    ArkTxInput,
    buildOffchainTx,
    CSVMultisigTapscript,
    Transaction,
    TapLeafScript,
} from "@arkade-os/sdk";
import { BoltzReverseSwap } from "../../src/types";
import {
    normalizeToXOnlyKey,
    verifySignatures,
} from "../../src/utils/signatures";
import { createVHTLCScript } from "../../src/utils/vhtlc";
import { claimVHTLCIdentity } from "../../src/utils/identity";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { TransactionOutput } from "@scure/btc-signer/psbt.js";
import {
    InvoiceExpiredError,
    NetworkError,
    SwapError,
    SwapExpiredError,
    TransactionFailedError,
    TransactionRefundedError,
} from "../../src/errors";

const CLAIM_VTXO_RETRY_ATTEMPTS = 3;
const CLAIM_VTXO_RETRY_DELAY_MS = 500;

const execAsync = promisify(exec);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getLNDBalance = async () => {
    const lncli = "docker exec -i lnd lncli --network=regtest";
    const { stdout } = await execAsync(`${lncli} channelbalance`);
    return parseInt(JSON.parse(stdout).balance, 10);
};

const payInvoice = async (invoice: string) => {
    const lncli = "docker exec -i lnd lncli --network=regtest";
    return execAsync(`${lncli} payinvoice --force ${invoice}`);
};

const createWalletStorage = () => ({
    walletRepository: new InMemoryWalletRepository(),
    contractRepository: new InMemoryContractRepository(),
});

const generateBlocks = async (numBlocks = 1) => {
    await execAsync(`nigiri rpc --generate ${numBlocks}`);
};

function scriptFromTapLeafScript(leaf: TapLeafScript): Uint8Array {
    return leaf[1].subarray(0, leaf[1].length - 1); // remove the version byte
}

describe("Refund swap", () => {
    let indexerProvider: RestIndexerProvider;
    let swapProvider: BoltzSwapProvider;
    let arkProvider: RestArkProvider;
    let aliceSecKey: Uint8Array;
    let identity: Identity;
    let swaps: ArkadeSwaps;
    let wallet: Wallet;

    const arkUrl = "http://localhost:7070";

    beforeAll(() => {
        // Set up any necessary environment or configurations for the tests
    });

    beforeEach(async () => {
        // create identity
        aliceSecKey = schnorr.utils.randomSecretKey();
        identity = SingleKey.fromPrivateKey(aliceSecKey);

        // create providers
        arkProvider = new RestArkProvider(arkUrl);
        indexerProvider = new RestIndexerProvider(arkUrl);
        swapProvider = new BoltzSwapProvider({ network: "regtest" });

        // create wallet
        wallet = await Wallet.create({
            identity,
            arkServerUrl: arkUrl,
            settlementConfig: false,
            storage: createWalletStorage(),
            onchainProvider: new EsploraProvider("http://localhost:3000", {
                forcePolling: true,
                pollingInterval: 2000,
            }),
        });

        // create swaps instance
        swaps = new ArkadeSwaps({
            wallet,
            swapProvider,
            arkProvider,
            indexerProvider,
            swapManager: false,
        });
    });

    it("should refund a swap successfully", { timeout: 100_000 }, async () => {
        let finalizeFunc: any;
        const options = { amount: 2100 };
        const lndBalanceBefore = await getLNDBalance();
        const balanceBefore = await wallet.getBalance();
        const pendingSwap = await swaps.createReverseSwap(options);

        const claimVHTLC = async (
            pendingSwap: BoltzReverseSwap
        ): Promise<void> => {
            // restored swaps may not have preimage
            if (!pendingSwap.preimage)
                throw new Error(
                    `Swap ${pendingSwap.id}: preimage is required to claim VHTLC`
                );

            const {
                refundPublicKey,
                lockupAddress,
                timeoutBlockHeights: vhtlcTimeouts,
            } = pendingSwap.response;
            if (!refundPublicKey || !lockupAddress || !vhtlcTimeouts)
                throw new Error(
                    `Swap ${pendingSwap.id}: incomplete reverse swap response`
                );

            const preimage = hex.decode(pendingSwap.preimage);
            const arkInfo = await arkProvider.getInfo();
            const address = await wallet.getAddress();

            const receiverXOnly = normalizeToXOnlyKey(
                await wallet.identity.xOnlyPublicKey(),
                "our",
                pendingSwap.id
            );

            const senderXOnly = normalizeToXOnlyKey(
                hex.decode(refundPublicKey),
                "boltz",
                pendingSwap.id
            );

            const serverXOnly = normalizeToXOnlyKey(
                hex.decode(arkInfo.signerPubkey),
                "server",
                pendingSwap.id
            );

            // build expected VHTLC script
            const { vhtlcScript, vhtlcAddress } = createVHTLCScript({
                network: arkInfo.network,
                preimageHash: sha256(preimage),
                receiverPubkey: hex.encode(receiverXOnly),
                senderPubkey: hex.encode(senderXOnly),
                serverPubkey: hex.encode(serverXOnly),
                timeoutBlockHeights: vhtlcTimeouts,
            });

            if (!vhtlcScript.claimScript)
                throw new Error(
                    `Swap ${pendingSwap.id}: failed to create VHTLC script for reverse swap`
                );
            if (vhtlcAddress !== lockupAddress)
                throw new Error(
                    `Swap ${pendingSwap.id}: VHTLC address mismatch. Expected ${lockupAddress}, got ${vhtlcAddress}`
                );

            let vtxo;
            for (
                let attempt = 1;
                attempt <= CLAIM_VTXO_RETRY_ATTEMPTS;
                attempt++
            ) {
                const { vtxos } = await indexerProvider.getVtxos({
                    scripts: [hex.encode(vhtlcScript.pkScript)],
                });
                if (vtxos.length > 0) {
                    vtxo = vtxos[0];
                    break;
                }
                if (attempt < CLAIM_VTXO_RETRY_ATTEMPTS) {
                    await new Promise((resolve) =>
                        setTimeout(resolve, CLAIM_VTXO_RETRY_DELAY_MS)
                    );
                }
            }

            if (!vtxo) {
                throw new Error(
                    `Swap ${pendingSwap.id}: no spendable virtual coins found`
                );
            }

            if (vtxo.isSpent) {
                throw new Error(
                    `Swap ${pendingSwap.id}: VHTLC is already spent`
                );
            }

            const input = {
                ...vtxo,
                tapLeafScript: vhtlcScript.claim(),
                tapTree: vhtlcScript.encode(),
            };

            const output = {
                amount: BigInt(vtxo.value),
                script: ArkAddress.decode(address).pkScript,
            };

            const vhtlcIdentity = claimVHTLCIdentity(wallet.identity, preimage);

            let finalStatus: BoltzSwapStatus | undefined;
            let finalizeFunc: any;

            if (isRecoverable(vtxo)) {
                await swaps.joinBatch(vhtlcIdentity, input, output, arkInfo);
                finalStatus = "transaction.claimed";
            } else {
                finalizeFunc = await claimVHTLCwithOffchainTx(
                    vhtlcIdentity,
                    vhtlcScript,
                    serverXOnly,
                    input,
                    output,
                    arkInfo,
                    arkProvider
                );
                finalStatus = (await swaps.getSwapStatus(pendingSwap.id))
                    .status;
            }
            return finalizeFunc;
        };

        const claimVHTLCwithOffchainTx = async (
            identity: Identity,
            vhtlcScript: VHTLC.Script,
            serverXOnlyPublicKey: Uint8Array,
            input: ArkTxInput,
            output: TransactionOutput,
            arkInfo: ArkInfo,
            arkProvider: ArkProvider
        ): Promise<any> => {
            // create the server unroll script for checkpoint transactions
            const rawCheckpointTapscript = hex.decode(
                arkInfo.checkpointTapscript
            );
            const serverUnrollScript = CSVMultisigTapscript.decode(
                rawCheckpointTapscript
            );

            // create the offchain transaction to claim the VHTLC
            const { arkTx, checkpoints } = buildOffchainTx(
                [input],
                [output],
                serverUnrollScript
            );

            // sign and submit the virtual transaction
            const signedArkTx = await identity.sign(arkTx);
            const { arkTxid, finalArkTx, signedCheckpointTxs } =
                await arkProvider.submitTx(
                    base64.encode(signedArkTx.toPSBT()),
                    checkpoints.map((c) => base64.encode(c.toPSBT()))
                );

            // wait for Boltz to fetch the pending Tx and settle the invoice, before making the swap expire.
            // it can take up to a minute.
            await generateBlocks(21);

            return async () => {
                // verify the server signed the transaction with correct key on the claim leaf
                const finalTx = Transaction.fromPSBT(base64.decode(finalArkTx));
                const serverPubkeyHex = hex.encode(serverXOnlyPublicKey);
                const claimLeafHash = tapLeafHash(
                    scriptFromTapLeafScript(vhtlcScript.claim())
                );
                for (let i = 0; i < finalTx.inputsLength; i++) {
                    if (
                        !verifySignatures(
                            finalTx,
                            i,
                            [serverPubkeyHex],
                            claimLeafHash
                        )
                    ) {
                        throw new Error("Invalid final Ark transaction");
                    }
                }

                // verify and sign the checkpoint transactions pre signed by the server
                const finalCheckpoints = await Promise.all(
                    signedCheckpointTxs.map(async (c, idx) => {
                        const tx = Transaction.fromPSBT(base64.decode(c));
                        const checkpointLeaf =
                            checkpoints[idx].getInput(0).tapLeafScript![0];
                        const cpLeafHash = tapLeafHash(
                            scriptFromTapLeafScript(checkpointLeaf)
                        );
                        if (
                            !verifySignatures(
                                tx,
                                0,
                                [serverPubkeyHex],
                                cpLeafHash
                            )
                        ) {
                            throw new Error(
                                "Invalid server signature in checkpoint transaction"
                            );
                        }
                        const signedCheckpoint = await identity.sign(tx, [0]);
                        return base64.encode(signedCheckpoint.toPSBT());
                    })
                );

                // submit the final transaction to the Ark provider
                await arkProvider.finalizeTx(arkTxid, finalCheckpoints);
            };
        };

        const onStatusUpdate = async (status: BoltzSwapStatus, data: any) => {
            switch (status) {
                case "transaction.mempool":
                case "transaction.confirmed":
                    finalizeFunc = await claimVHTLC(pendingSwap);
                    break;
                case "invoice.settled": {
                    await finalizeFunc();

                    const swapStatus = await swapProvider.getReverseSwapTxId(
                        pendingSwap.id
                    );
                    const txid = swapStatus.id;

                    if (!txid || txid.trim() === "") {
                        throw new SwapError({
                            message: `Transaction ID not available for settled swap ${pendingSwap.id}.`,
                        });
                    }
                    return { txid };
                }
                case "invoice.expired":
                    throw new InvoiceExpiredError({
                        isRefundable: true,
                        pendingSwap,
                    });
                case "swap.expired":
                    throw new SwapExpiredError({
                        isRefundable: true,
                        pendingSwap,
                    });
                    break;
                case "transaction.failed":
                    throw new TransactionFailedError({
                        message: data?.failureReason ?? "Transaction failed",
                        isRefundable: true,
                    });
                case "transaction.refunded":
                    throw new TransactionRefundedError();
                default:
                    break;
            }
        };

        const monitorSwap = (
            swapId: string,
            update: (
                type: BoltzSwapStatus,
                data?: any
            ) => Promise<{ txid?: string } | void>
        ): Promise<void> => {
            return new Promise((resolve, reject) => {
                const webSocket = new globalThis.WebSocket(
                    "ws://localhost:9004/v2/ws"
                );

                const connectionTimeout = setTimeout(() => {
                    webSocket.close();
                    reject(new NetworkError("WebSocket connection timeout"));
                }, 30000); // 30 second timeout

                webSocket.onerror = (error) => {
                    clearTimeout(connectionTimeout);
                    reject(
                        new NetworkError(
                            `WebSocket error: ${(error as any).message}`
                        )
                    );
                };

                webSocket.onopen = () => {
                    clearTimeout(connectionTimeout);
                    webSocket.send(
                        JSON.stringify({
                            op: "subscribe",
                            channel: "swap.update",
                            args: [swapId],
                        })
                    );
                };

                webSocket.onclose = () => {
                    clearTimeout(connectionTimeout);
                    resolve();
                };

                webSocket.onmessage = async (rawMsg) => {
                    const msg = JSON.parse(rawMsg.data as string);

                    // we are only interested in updates for the specific swap
                    if (msg.event !== "update" || msg.args[0].id !== swapId)
                        return;

                    if (msg.args[0].error) {
                        webSocket.close();
                        reject(new SwapError({ message: msg.args[0].error }));
                    }

                    const status = msg.args[0].status as BoltzSwapStatus;

                    // chain swaps lockupFailed can be negotiable
                    const negotiable =
                        status === "transaction.lockupFailed" &&
                        msg.args[0].failureDetails?.actual !== undefined &&
                        msg.args[0].failureDetails?.expected !== undefined;

                    switch (status) {
                        case "transaction.claimed":
                        case "transaction.refunded":
                        case "invoice.expired":
                        case "invoice.failedToPay":
                        case "transaction.failed":
                        case "swap.expired":
                            webSocket.close();
                            update(status, msg.args[0]);
                            break;
                        case "transaction.lockupFailed":
                            if (!negotiable) webSocket.close();
                            update(status, msg.args[0]);
                            break;
                        case "invoice.paid":
                        case "invoice.pending":
                        case "invoice.set":
                        case "swap.created":
                        case "transaction.mempool":
                        case "transaction.confirmed":
                        case "transaction.claim.pending":
                        case "transaction.server.mempool":
                        case "transaction.server.confirmed":
                            update(status, msg.args[0]);
                            break;
                        case "invoice.settled":
                            sleep(10_000).then(() => webSocket.close());
                            update(status, msg.args[0]);
                    }
                };
            });
        };

        await sleep(1000);

        payInvoice(pendingSwap.response.invoice);

        await monitorSwap(pendingSwap.id, onStatusUpdate);

        const balanceAfter = await wallet.getBalance();
        expect(balanceAfter.available).toBeGreaterThan(balanceBefore.available);

        const lndBalanceAfter = await getLNDBalance();
        expect(lndBalanceBefore).toBeGreaterThan(lndBalanceAfter);
    });
});
