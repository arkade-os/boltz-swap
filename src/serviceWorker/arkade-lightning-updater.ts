import {
    ArkInfo,
    ArkTxInput,
    IWallet,
    IReadonlyWallet,
    CSVMultisigTapscript,
    buildOffchainTx,
    combineTapscriptSigs,
    RequestEnvelope,
    ResponseEnvelope,
    MessageHandler,
} from "@arkade-os/sdk";
import {
    BoltzSwapProvider,
    type GetSwapStatusResponse,
} from "../boltz-swap-provider";
import { SwapRepository } from "../repositories/swap-repository";
import {
    ArkadeLightningConfig,
    type CreateLightningInvoiceRequest,
    type CreateLightningInvoiceResponse,
    type FeesResponse,
    type LimitsResponse,
    Network,
    PendingReverseSwap,
    PendingSubmarineSwap,
    type SendLightningPaymentRequest,
    SendLightningPaymentResponse,
} from "../types";
import {
    ArkProvider,
    RestArkProvider,
} from "../../../ts-sdk/src/providers/ark";
import {
    IndexerProvider,
    RestIndexerProvider,
} from "../../../ts-sdk/src/providers/indexer";
import { base64, hex } from "@scure/base";
import { TransactionOutput } from "@scure/btc-signer/psbt.js";
import { Transaction } from "@scure/btc-signer";
import { verifySignatures } from "../utils/signatures";
import { ArkadeLightning, IArkadeLightning } from "../arkade-lightning";

export const DEFAULT_MESSAGE_TAG = "ARKADE_LIGHTNING_UPDATER";

export type RequestInitArkLn = RequestEnvelope & {
    type: "INIT_ARKADE_LIGHTNING";
    payload: ArkadeLightningConfig & {
        network: Network;
        arkServerUrl: string;
        swapProvider: {
            baseUrl: string;
        };
    };
};

export type ResponseInitArkLn = ResponseEnvelope & {
    type: "ARKADE_LIGHTNING_INITIALIZED";
};

export type RequestCreateLightningInvoice = RequestEnvelope & {
    type: "CREATE_LIGHTNING_INVOICE";
    payload: CreateLightningInvoiceRequest;
};
export type ResponseCreateLightningInvoice = ResponseEnvelope & {
    type: "LIGHTNING_INVOICE_CREATED";
    payload: CreateLightningInvoiceResponse;
};

export type RequestSendLightningPayment = RequestEnvelope & {
    type: "SEND_LIGHTNING_PAYMENT";
    payload: SendLightningPaymentRequest;
};
export type ResponseSendLightningPayment = ResponseEnvelope & {
    type: "LIGHTNING_PAYMENT_SENT";
    payload: SendLightningPaymentResponse;
};

export type RequestCreateSubmarineSwap = RequestEnvelope & {
    type: "CREATE_SUBMARINE_SWAP";
    payload: SendLightningPaymentRequest;
};
export type ResponseCreateSubmarineSwap = ResponseEnvelope & {
    type: "SUBMARINE_SWAP_CREATED";
    payload: PendingSubmarineSwap;
};

export type RequestCreateReverseSwap = RequestEnvelope & {
    type: "CREATE_REVERSE_SWAP";
    payload: CreateLightningInvoiceRequest;
};
export type ResponseCreateReverseSwap = ResponseEnvelope & {
    type: "REVERSE_SWAP_CREATED";
    payload: PendingReverseSwap;
};

export type RequestClaimVhtlc = RequestEnvelope & {
    type: "CLAIM_VHTLC";
    payload: PendingReverseSwap;
};
export type ResponseClaimVhtlc = ResponseEnvelope & {
    type: "VHTLC_CLAIMED";
};

export type RequestRefundVhtlc = RequestEnvelope & {
    type: "REFUND_VHTLC";
    payload: PendingSubmarineSwap;
};
export type ResponseRefundVhtlc = ResponseEnvelope & {
    type: "VHTLC_REFUNDED";
};

export type RequestWaitAndClaim = RequestEnvelope & {
    type: "WAIT_AND_CLAIM";
    payload: PendingReverseSwap;
};
export type ResponseWaitAndClaim = ResponseEnvelope & {
    type: "WAIT_AND_CLAIMED";
    payload: { txid: string };
};

export type RequestWaitForSwapSettlement = RequestEnvelope & {
    type: "WAIT_FOR_SWAP_SETTLEMENT";
    payload: PendingSubmarineSwap;
};
export type ResponseWaitForSwapSettlement = ResponseEnvelope & {
    type: "SWAP_SETTLED";
    payload: { preimage: string };
};

export type RequestRestoreSwaps = RequestEnvelope & {
    type: "RESTORE_SWAPS";
    payload?: FeesResponse;
};
export type ResponseRestoreSwaps = ResponseEnvelope & {
    type: "SWAPS_RESTORED";
    payload: {
        reverseSwaps: PendingReverseSwap[];
        submarineSwaps: PendingSubmarineSwap[];
    };
};

export type RequestEnrichReverseSwapPreimage = RequestEnvelope & {
    type: "ENRICH_REVERSE_SWAP_PREIMAGE";
    payload: { swap: PendingReverseSwap; preimage: string };
};
export type ResponseEnrichReverseSwapPreimage = ResponseEnvelope & {
    type: "REVERSE_SWAP_PREIMAGE_ENRICHED";
    payload: PendingReverseSwap;
};

export type RequestEnrichSubmarineSwapInvoice = RequestEnvelope & {
    type: "ENRICH_SUBMARINE_SWAP_INVOICE";
    payload: { swap: PendingSubmarineSwap; invoice: string };
};
export type ResponseEnrichSubmarineSwapInvoice = ResponseEnvelope & {
    type: "SUBMARINE_SWAP_INVOICE_ENRICHED";
    payload: PendingSubmarineSwap;
};

export type RequestGetFees = RequestEnvelope & {
    type: "GET_FEES";
};
export type ResponseGetFees = ResponseEnvelope & {
    type: "FEES";
    payload: FeesResponse;
};

export type RequestGetLimits = RequestEnvelope & {
    type: "GET_LIMITS";
};
export type ResponseGetLimits = ResponseEnvelope & {
    type: "LIMITS";
    payload: LimitsResponse;
};

export type RequestGetSwapStatus = RequestEnvelope & {
    type: "GET_SWAP_STATUS";
    payload: { swapId: string };
};
export type ResponseGetSwapStatus = ResponseEnvelope & {
    type: "SWAP_STATUS";
    payload: GetSwapStatusResponse;
};

export type RequestGetPendingSubmarineSwaps = RequestEnvelope & {
    type: "GET_PENDING_SUBMARINE_SWAPS";
};
export type ResponseGetPendingSubmarineSwaps = ResponseEnvelope & {
    type: "PENDING_SUBMARINE_SWAPS";
    payload: PendingSubmarineSwap[];
};

export type RequestGetPendingReverseSwaps = RequestEnvelope & {
    type: "GET_PENDING_REVERSE_SWAPS";
};
export type ResponseGetPendingReverseSwaps = ResponseEnvelope & {
    type: "PENDING_REVERSE_SWAPS";
    payload: PendingReverseSwap[];
};

export type RequestGetSwapHistory = RequestEnvelope & {
    type: "GET_SWAP_HISTORY";
};
export type ResponseGetSwapHistory = ResponseEnvelope & {
    type: "SWAP_HISTORY";
    payload: (PendingReverseSwap | PendingSubmarineSwap)[];
};

export type RequestRefreshSwapsStatus = RequestEnvelope & {
    type: "REFRESH_SWAPS_STATUS";
};
export type ResponseRefreshSwapsStatus = ResponseEnvelope & {
    type: "SWAPS_STATUS_REFRESHED";
};

export type ArkadeLightningUpdaterRequest =
    | RequestInitArkLn
    | RequestCreateLightningInvoice
    | RequestSendLightningPayment
    | RequestCreateSubmarineSwap
    | RequestCreateReverseSwap
    | RequestClaimVhtlc
    | RequestRefundVhtlc
    | RequestWaitAndClaim
    | RequestWaitForSwapSettlement
    | RequestRestoreSwaps
    | RequestEnrichReverseSwapPreimage
    | RequestEnrichSubmarineSwapInvoice
    | RequestGetFees
    | RequestGetLimits
    | RequestGetSwapStatus
    | RequestGetPendingSubmarineSwaps
    | RequestGetPendingReverseSwaps
    | RequestGetSwapHistory
    | RequestRefreshSwapsStatus;

export type ArkadeLightningUpdaterResponse =
    | ResponseInitArkLn
    | ResponseCreateLightningInvoice
    | ResponseSendLightningPayment
    | ResponseCreateSubmarineSwap
    | ResponseCreateReverseSwap
    | ResponseClaimVhtlc
    | ResponseRefundVhtlc
    | ResponseWaitAndClaim
    | ResponseWaitForSwapSettlement
    | ResponseRestoreSwaps
    | ResponseEnrichReverseSwapPreimage
    | ResponseEnrichSubmarineSwapInvoice
    | ResponseGetFees
    | ResponseGetLimits
    | ResponseGetSwapStatus
    | ResponseGetPendingSubmarineSwaps
    | ResponseGetPendingReverseSwaps
    | ResponseGetSwapHistory
    | ResponseRefreshSwapsStatus;

export class ArkadeLightningUpdater
    implements
        MessageHandler<
            ArkadeLightningUpdaterRequest,
            ArkadeLightningUpdaterResponse
        >
{
    static messageTag = "arkade-lightning-updater";
    readonly messageTag = ArkadeLightningUpdater.messageTag;

    private arkProvider: ArkProvider | undefined;
    private indexerProvider: IndexerProvider | undefined;
    private swapProvider: BoltzSwapProvider | undefined;
    private wallet: IWallet | undefined;

    private handler: IArkadeLightning | undefined;

    constructor(private readonly swapRepository: SwapRepository) {}

    async start(opts: {
        wallet?: IWallet;
        readonlyWallet: IReadonlyWallet;
    }): Promise<void> {
        if (!opts.wallet) throw new Error("Wallet is required");
        this.wallet = opts.wallet;
    }

    async stop() {}

    async tick(_now: number) {
        // No subs?
        return [];
    }

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
        if (message.type === "INIT_ARKADE_LIGHTNING") {
            await this.handleInit(message);
            return this.tagged({
                id,
                type: "ARKADE_LIGHTNING_INITIALIZED",
            });
        }

        if (!this.handler || !this.wallet) {
            return this.tagged({
                id,
                error: new Error("handler not initialized"),
            });
        }

        try {
            switch (message.type) {
                case "CREATE_LIGHTNING_INVOICE": {
                    const res = await this.handler.createLightningInvoice(
                        message.payload
                    );
                    return this.tagged({
                        id,
                        type: "LIGHTNING_INVOICE_CREATED",
                        payload: res,
                    });
                }

                case "SEND_LIGHTNING_PAYMENT": {
                    const res = await this.handler.sendLightningPayment(
                        message.payload
                    );
                    return this.tagged({
                        id,
                        type: "LIGHTNING_PAYMENT_SENT",
                        payload: res,
                    });
                }

                case "CREATE_SUBMARINE_SWAP": {
                    const res = await this.handler.createSubmarineSwap(
                        message.payload
                    );
                    return this.tagged({
                        id,
                        type: "SUBMARINE_SWAP_CREATED",
                        payload: res,
                    });
                }

                case "CREATE_REVERSE_SWAP": {
                    const res = await this.handler.createReverseSwap(
                        message.payload
                    );
                    return this.tagged({
                        id,
                        type: "REVERSE_SWAP_CREATED",
                        payload: res,
                    });
                }

                case "CLAIM_VHTLC":
                    await this.handler.claimVHTLC(message.payload);
                    return this.tagged({ id, type: "VHTLC_CLAIMED" });

                case "REFUND_VHTLC":
                    await this.handler.refundVHTLC(message.payload);
                    return this.tagged({ id, type: "VHTLC_REFUNDED" });

                case "WAIT_AND_CLAIM": {
                    const res = await this.handler.waitAndClaim(
                        message.payload
                    );
                    return this.tagged({
                        id,
                        type: "WAIT_AND_CLAIMED",
                        payload: res,
                    });
                }

                case "WAIT_FOR_SWAP_SETTLEMENT": {
                    const res = await this.handler.waitForSwapSettlement(
                        message.payload
                    );
                    return this.tagged({
                        id,
                        type: "SWAP_SETTLED",
                        payload: res,
                    });
                }

                case "RESTORE_SWAPS": {
                    const res = await this.handler.restoreSwaps(
                        message.payload
                    );
                    return this.tagged({
                        id,
                        type: "SWAPS_RESTORED",
                        payload: res,
                    });
                }

                case "ENRICH_REVERSE_SWAP_PREIMAGE": {
                    const res = this.handler.enrichReverseSwapPreimage(
                        message.payload.swap,
                        message.payload.preimage
                    );
                    return this.tagged({
                        id,
                        type: "REVERSE_SWAP_PREIMAGE_ENRICHED",
                        payload: res,
                    });
                }

                case "ENRICH_SUBMARINE_SWAP_INVOICE": {
                    const res = this.handler.enrichSubmarineSwapInvoice(
                        message.payload.swap,
                        message.payload.invoice
                    );
                    return this.tagged({
                        id,
                        type: "SUBMARINE_SWAP_INVOICE_ENRICHED",
                        payload: res,
                    });
                }

                case "GET_FEES": {
                    const res = await this.handler.getFees();
                    return this.tagged({ id, type: "FEES", payload: res });
                }

                case "GET_LIMITS": {
                    const res = await this.handler.getLimits();
                    return this.tagged({ id, type: "LIMITS", payload: res });
                }

                case "GET_SWAP_STATUS": {
                    const res = await this.handler.getSwapStatus(
                        message.payload.swapId
                    );
                    return this.tagged({
                        id,
                        type: "SWAP_STATUS",
                        payload: res,
                    });
                }

                case "GET_PENDING_SUBMARINE_SWAPS": {
                    const res = await this.handler.getPendingSubmarineSwaps();
                    return this.tagged({
                        id,
                        type: "PENDING_SUBMARINE_SWAPS",
                        payload: res,
                    });
                }

                case "GET_PENDING_REVERSE_SWAPS": {
                    const res = await this.handler.getPendingReverseSwaps();
                    return this.tagged({
                        id,
                        type: "PENDING_REVERSE_SWAPS",
                        payload: res,
                    });
                }

                case "GET_SWAP_HISTORY": {
                    const res = await this.handler.getSwapHistory();
                    return this.tagged({
                        id,
                        type: "SWAP_HISTORY",
                        payload: res,
                    });
                }

                case "REFRESH_SWAPS_STATUS":
                    await this.handler.refreshSwapsStatus();
                    return this.tagged({ id, type: "SWAPS_STATUS_REFRESHED" });

                default:
                    console.error("Unknown message type", message);
                    throw new Error("Unknown message");
            }
        } catch (error) {
            return this.tagged({ id, error: error as Error });
        }
    }

    private async handleInit({ payload }: RequestInitArkLn): Promise<void> {
        if (!this.wallet) {
            throw new Error("Wallet is required");
        }
        const { arkServerUrl } = payload;
        this.arkProvider = new RestArkProvider(arkServerUrl);
        this.indexerProvider = new RestIndexerProvider(arkServerUrl);
        this.swapProvider = new BoltzSwapProvider({
            apiUrl: payload.swapProvider.baseUrl,
            network: payload.network,
        });

        const handler = new ArkadeLightning({
            wallet: this.wallet,
            arkProvider: this.arkProvider,
            swapProvider: this.swapProvider,
            indexerProvider: this.indexerProvider,
            swapRepository: this.swapRepository,
            // SwapManager handles SW by itself
            swapManager: undefined,
            feeConfig: payload.feeConfig,
            timeoutConfig: payload.timeoutConfig,
            retryConfig: payload.retryConfig,
        });
        this.handler = handler;
    }

    private async withInit<T>(
        fn: (
            wallet: IWallet,
            indexerProvider: IndexerProvider,
            arkProvider: ArkProvider,
            swapProvider: BoltzSwapProvider
        ) => T
    ): Promise<T> {
        if (
            this.wallet &&
            this.indexerProvider &&
            this.arkProvider &&
            this.swapProvider
        ) {
            return fn(
                this.wallet,
                this.indexerProvider,
                this.arkProvider,
                this.swapProvider
            );
        }
        throw new Error("Updater not initialized");
    }

    async refundVHTLCwithOffchainTx(
        pendingSwap: PendingSubmarineSwap,
        boltzXOnlyPublicKey: Uint8Array,
        ourXOnlyPublicKey: Uint8Array,
        serverXOnlyPublicKey: Uint8Array,
        input: ArkTxInput,
        output: TransactionOutput,
        arkInfos: Pick<ArkInfo, "checkpointTapscript">
    ): Promise<void> {
        // create the server unroll script for checkpoint transactions
        const rawCheckpointTapscript = hex.decode(arkInfos.checkpointTapscript);
        const serverUnrollScript = CSVMultisigTapscript.decode(
            rawCheckpointTapscript
        );

        // create the virtual transaction to claim the VHTLC
        const { arkTx: unsignedRefundTx, checkpoints: checkpointPtxs } =
            buildOffchainTx([input], [output], serverUnrollScript);

        // validate we have one checkpoint transaction
        if (checkpointPtxs.length !== 1)
            throw new Error(
                `Expected one checkpoint transaction, got ${checkpointPtxs.length}`
            );

        const unsignedCheckpointTx = checkpointPtxs[0];

        return this.withInit(
            async (wallet, _indexerProvider, arkProvider, swapProvider) => {
                // get Boltz to sign its part
                const {
                    transaction: boltzSignedRefundTx,
                    checkpoint: boltzSignedCheckpointTx,
                } = await swapProvider.refundSubmarineSwap(
                    pendingSwap.id,
                    unsignedRefundTx,
                    unsignedCheckpointTx
                );

                // Verify Boltz signatures before combining
                const boltzXOnlyPublicKeyHex = hex.encode(boltzXOnlyPublicKey);
                if (
                    !verifySignatures(boltzSignedRefundTx, 0, [
                        boltzXOnlyPublicKeyHex,
                    ])
                ) {
                    throw new Error(
                        "Invalid Boltz signature in refund transaction"
                    );
                }
                if (
                    !verifySignatures(boltzSignedCheckpointTx, 0, [
                        boltzXOnlyPublicKeyHex,
                    ])
                ) {
                    throw new Error(
                        "Invalid Boltz signature in checkpoint transaction"
                    );
                }

                // sign our part
                const signedRefundTx =
                    await wallet.identity.sign(unsignedRefundTx);
                const signedCheckpointTx =
                    await wallet.identity.sign(unsignedCheckpointTx);

                // combine transactions
                const combinedSignedRefundTx = combineTapscriptSigs(
                    boltzSignedRefundTx,
                    signedRefundTx
                );
                const combinedSignedCheckpointTx = combineTapscriptSigs(
                    boltzSignedCheckpointTx,
                    signedCheckpointTx
                );

                // get server to sign its part of the combined transaction
                const { arkTxid, finalArkTx, signedCheckpointTxs } =
                    await arkProvider.submitTx(
                        base64.encode(combinedSignedRefundTx.toPSBT()),
                        [base64.encode(unsignedCheckpointTx.toPSBT())]
                    );

                // verify the final tx is properly signed
                const tx = Transaction.fromPSBT(base64.decode(finalArkTx));
                const inputIndex = 0;
                const requiredSigners = [
                    hex.encode(ourXOnlyPublicKey),
                    hex.encode(boltzXOnlyPublicKey),
                    hex.encode(serverXOnlyPublicKey),
                ];

                if (!verifySignatures(tx, inputIndex, requiredSigners)) {
                    throw new Error("Invalid refund transaction");
                }

                // validate we received exactly one checkpoint transaction
                if (signedCheckpointTxs.length !== 1) {
                    throw new Error(
                        `Expected one signed checkpoint transaction, got ${signedCheckpointTxs.length}`
                    );
                }

                // combine the checkpoint signatures
                const serverSignedCheckpointTx = Transaction.fromPSBT(
                    base64.decode(signedCheckpointTxs[0])
                );

                const finalCheckpointTx = combineTapscriptSigs(
                    combinedSignedCheckpointTx,
                    serverSignedCheckpointTx
                );

                // finalize the transaction
                await arkProvider.finalizeTx(arkTxid, [
                    base64.encode(finalCheckpointTx.toPSBT()),
                ]);
            }
        );
    }
}
