import {
    ArkAddress,
    ArkInfo,
    ArkTxInput,
    isRecoverable,
    IUpdater,
    Identity,
} from "@arkade-os/sdk";
import { BoltzSwapProvider, BoltzSwapStatus } from "../boltz-swap-provider";
import { SwapRepository } from "../repositories/swap-repository";
import { SwapManager, SwapManagerConfig } from "../swap-manager";
import { logger } from "../logger";
import { IndexedDbSwapRepository } from "../repositories/IndexedDb/swap-repository";
import { Network, PendingReverseSwap, PendingSubmarineSwap } from "../types";
import { SvcWrkArkadeLightningConfig } from "./arkade-lightning";
import { RequestEnvelope } from "../../../ts-sdk/src/serviceWorker/worker";
import { ArkProvider, RestArkProvider } from "../../../ts-sdk/src/providers/ark";
import {
    IndexerProvider,
    RestIndexerProvider,
} from "../../../ts-sdk/src/providers/indexer";
import { hex } from "@scure/base";
import { normalizeToXOnlyPublicKey } from "../utils/keys";
import { sha256 } from "@noble/hashes/sha2.js";
import { createVHTLCScript } from "../utils/scripts";
import { claimVHTLCIdentity } from "../utils/identity";
import { updateReverseSwapStatus } from "../utils/swap-helpers";
import { TransactionOutput } from "@scure/btc-signer/psbt.js";
import { Transaction } from "@scure/btc-signer";

export const  DEFAULT_MESSAGE_TAG = "ARKADE_LIGHTNING_UPDATER"

export type RequestInitArkLn = RequestEnvelope & {
    type: "INIT_ARKADE_LIGHTNING";
    payload: {
        network: Network
        arkServerUrl: string;
        swapProvider: {
            baseUrl: string;
        }
        swapManager?: {
            config?: SwapManagerConfig;
            autoStart?: boolean;
        };
    };
};

export type ResponseInitArkLn = RequestEnvelope & {
    type: "ARKADE_LIGHTNING_INITIALIZED"
}

export type ArkadeLightningUpdaterRequest = RequestInitArkLn;
export type ArkadeLightningUpdaterResponse = ResponseInitArkLn;

export class ArkadeLightningUpdater
    implements
        IUpdater<ArkadeLightningUpdaterRequest, ArkadeLightningUpdaterResponse>
{
    static messageTag = "arkade-lightning-updater";
    readonly messageTag = ArkadeLightningUpdater.messageTag;

    private arkProvider: ArkProvider | undefined;
    private indexerProvider: IndexerProvider | undefined;
    private swapProvider: BoltzSwapProvider | undefined;
    private swapManager: SwapManager | undefined;

    constructor(private readonly swapRepository: SwapRepository) {}

    private tagged(
        res: Partial<ArkadeLightningUpdaterResponse>
    ): ArkadeLightningUpdaterResponse {
        return {
            ...res,
            tag: this.messageTag,
        } as ArkadeLightningUpdaterResponse;
    }

    async handleMessage(
        message: ArkadeLightningUpdaterRequest
    ): Promise<ArkadeLightningUpdaterResponse> {
        const id = message.id;
        // console.log(`[${this.messageTag}] handleMessage`, message);
        if (message.type === "INIT_ARKADE_LIGHTNING") {
            await this.handleInit(message);
            return this.tagged({
                id,
                type: "ARKADE_LIGHTNING_INITIALIZED",
            });
        }
    }

    private async handleInit({ payload }: RequestInitArkLn): Promise<void> {
        const { arkServerUrl } = payload;
        this.arkProvider = new RestArkProvider(arkServerUrl);
        this.indexerProvider = new RestIndexerProvider(arkServerUrl);
        this.swapProvider = new BoltzSwapProvider({
            apiUrl: payload.swapProvider.baseUrl,
            network: payload.network,
        });

        if (payload.swapManager) {
            this.swapManager = new SwapManager(
                this.swapProvider,
                payload.swapManager.config
            );
            this.swapManager.setCallbacks({
                claim: async (swap: PendingReverseSwap) => {
                    await this.claimVHTLC(swap);
                },
                refund: async (swap: PendingSubmarineSwap) => {
                    // await this.refundVHTLC(swap);
                },
                saveSwap: async (
                    swap: PendingReverseSwap | PendingSubmarineSwap
                ) => this.swapRepository.saveSwap(swap),
            });
            if (payload.swapManager.autoStart) {
                // Load all pending swaps from storage -- TODO: filter by status!
                const allSwaps = await this.swapRepository.getAllSwaps();
                console.log(
                    "Starting SwapManager with",
                    allSwaps.length,
                    "swaps"
                );
                // Start the manager with all pending swaps
                await this.swapManager.start(allSwaps);
            }
        }
    }

    private async withInit<T>(
        fn: (
            indexerProvider: IndexerProvider,
            arkProvider: ArkProvider,
            swapProvider: BoltzSwapProvider
        ) => T
    ): Promise<T> {
        if (this.indexerProvider && this.arkProvider && this.swapProvider) {
            return fn(
                this.indexerProvider,
                this.arkProvider,
                this.swapProvider
            );
        }
        throw new Error("Updater not initialized");
    }

    private async getWalletAddress(): Promise<string> {
        return Promise.reject("not implemented");
    }

    private async getWalletXOnlyPublicKey(): Promise<Uint8Array> {
        return Promise.reject("not implemented");
    }

    /**
     * Claims the VHTLC for a pending reverse swap.
     * If the VHTLC is recoverable, it joins a batch to spend the vtxo via commitment transaction.
     * @param pendingSwap - The pending reverse swap to claim the VHTLC.
     */
    private async claimVHTLC(pendingSwap: PendingReverseSwap): Promise<void> {
        // restored swaps may not have preimage
        if (!pendingSwap.preimage)
            throw new Error("Preimage is required to claim VHTLC");
        const preimage = hex.decode(pendingSwap.preimage);
        const address = await this.getWalletAddress();
        const xOnlyPublicKey = await this.getWalletXOnlyPublicKey();

        return this.withInit(
            async (indexerProvider, arkProvider, _swapProvider) => {
                const aspInfo = await arkProvider.getInfo();

                // build expected VHTLC script
                const { vhtlcScript, vhtlcAddress } = createVHTLCScript({
                    network: aspInfo.network,
                    preimageHash: sha256(preimage),
                    receiverPubkey: hex.encode(xOnlyPublicKey),
                    senderPubkey: pendingSwap.response.refundPublicKey,
                    serverPubkey: aspInfo.signerPubkey,
                    timeoutBlockHeights:
                        pendingSwap.response.timeoutBlockHeights,
                });

                if (!vhtlcScript)
                    throw new Error(
                        "Failed to create VHTLC script for reverse swap"
                    );
                if (vhtlcAddress !== pendingSwap.response.lockupAddress)
                    throw new Error("Boltz is trying to scam us");

                // get spendable VTXOs from the lockup address
                const { vtxos } = await indexerProvider.getVtxos({
                    scripts: [hex.encode(vhtlcScript.pkScript)],
                });
                if (vtxos.length === 0)
                    throw new Error("No spendable virtual coins found");

                // vtxo with the htlc to claim
                // TODO: handle multiple VTXOs
                const vtxo = vtxos[0];

                if (vtxo.isSpent) {
                    throw new Error("VHTLC is already spent");
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

                // signing a VTHLC needs an extra witness element to be added to the PSBT input
                // reveal the secret in the PSBT, thus the server can verify the claim script
                // this witness must satisfy the preimageHash condition
                // TODO: handle sign-via-message
                const vhtlcIdentity = this.claimVHTLCIdentity(
                    this.wallet.identity,
                    preimage
                );

                let finalStatus: BoltzSwapStatus | undefined;

                // if the vtxo is recoverable, we need to claim in batch
                if (isRecoverable(vtxo)) {
                    await this.joinBatch(input, output, aspInfo);
                    finalStatus = "transaction.claimed";
                } else {
                    await this.claimVHTLCwithOffchainTx(
                        vhtlcIdentity,
                        vhtlcScript,
                        serverXOnlyPublicKey,
                        input,
                        output,
                        aspInfo
                    );
                    finalStatus = (
                        await this.swapProvider.getSwapStatus(pendingSwap.id)
                    ).status;
                }

                await this.swapRepository.saveSwap({
                    ...pendingSwap,
                    status: finalStatus,
                });
            }
        );
    }

    private claimVHTLCIdentity(preimage: Uint8Array): {
        sign: Identity["sign"];
    } {
        function sign(
            tx: Transaction,
            inputIndexes?: number[]
        ): Promise<Transaction> {
            const cpy = tx.clone();
            let signedTx = await identity.sign(cpy, inputIndexes);
            signedTx = Transaction.fromPSBT(signedTx.toPSBT());

            // If preimage is provided, add it to the witness for claim transactions
            if (preimage) {
                for (const inputIndex of inputIndexes ||
                    Array.from(
                        { length: signedTx.inputsLength },
                        (_, i) => i
                    )) {
                    setArkPsbtField(signedTx, inputIndex, ConditionWitness, [
                        preimage,
                    ]);
                }
            }
            return signedTx;
        }
        return {            sign        }
    }

    private handleSign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> {

    }

    /**
     * Joins a batch to spend the vtxo via commitment transaction
     * @param identity - The identity to use for signing the forfeit transaction.
     * @param input - The input vtxo.
     * @param output - The output script.
     * @param forfeitPublicKey - The forfeit public key.
     * @returns The commitment transaction ID.
     */
    async joinBatch(
        input: ArkTxInput,
        output: TransactionOutput,
        {
            forfeitPubkey,
            forfeitAddress,
            network,
        }: Pick<ArkInfo, "forfeitPubkey" | "forfeitAddress" | "network">,
        isRecoverable = true
    ): Promise<string> {
        throw Error("not implemented");
    }
}

export default ArkadeLightningUpdater;