import { GetSwapStatusResponse } from "../boltz-swap-provider";
import type {
    CreateLightningInvoiceRequest,
    CreateLightningInvoiceResponse,
    FeesResponse,
    LimitsResponse,
    PendingReverseSwap,
    PendingSubmarineSwap,
    SendLightningPaymentRequest,
    SendLightningPaymentResponse,
} from "../types";
import { SwapRepository } from "../repositories/swap-repository";
import { DEFAULT_MESSAGE_TAG } from "./arkade-lightning-message-handler";
import type {
    RequestClaimVhtlc,
    RequestCreateLightningInvoice,
    RequestCreateReverseSwap,
    RequestCreateSubmarineSwap,
    RequestGetFees,
    RequestGetLimits,
    RequestGetPendingReverseSwaps,
    RequestGetPendingSubmarineSwaps,
    RequestGetSwapHistory,
    RequestGetSwapStatus,
    RequestRefundVhtlc,
    RequestRefreshSwapsStatus,
    RequestRestoreSwaps,
    RequestSendLightningPayment,
    RequestWaitAndClaim,
    RequestWaitForSwapSettlement,
    ResponseClaimVhtlc,
    ResponseCreateLightningInvoice,
    ResponseCreateReverseSwap,
    ResponseCreateSubmarineSwap,
    ResponseGetFees,
    ResponseGetLimits,
    ResponseGetPendingReverseSwaps,
    ResponseGetPendingSubmarineSwaps,
    ResponseGetSwapHistory,
    ResponseGetSwapStatus,
    ResponseRefundVhtlc,
    ResponseRefreshSwapsStatus,
    ResponseRestoreSwaps,
    ResponseSendLightningPayment,
    ResponseWaitAndClaim,
    ResponseWaitForSwapSettlement,
} from "./arkade-lightning-message-handler";
import type { RequestEnvelope, ResponseEnvelope, VHTLC } from "@arkade-os/sdk";
import { IArkadeLightning } from "../arkade-lightning";
import { IndexedDbSwapRepository } from "../repositories/IndexedDb/swap-repository";
import { SwapManager } from "../swap-manager";

export type SvcWrkArkadeLightningConfig = {
    serviceWorker: ServiceWorker;
    messageTag?: string;
    swapRepository?: SwapRepository;
};

export class SwArkadeLightningRuntime implements IArkadeLightning {
    readonly swapManager: SwapManager | null = null;

    private constructor(
        public readonly serviceWorker: ServiceWorker,
        private readonly messageTag: string,
        readonly swapRepository: SwapRepository // expose methods, not the repo
    ) {}

    static create(options: SvcWrkArkadeLightningConfig) {
        const messageTag = options.messageTag ?? DEFAULT_MESSAGE_TAG;

        const swapRepository =
            options.swapRepository ?? new IndexedDbSwapRepository();

        const svcArkadeLightning = new SwArkadeLightningRuntime(
            options.serviceWorker,
            messageTag,
            swapRepository
        );

        return svcArkadeLightning;
    }

    async startSwapManager(): Promise<void> {
        if (!this.swapManager) {
            throw new Error(
                "SwapManager is not enabled. Provide 'swapManager' config in ArkadeLightningConfig."
            );
        }
        // TODO: filter only pending swaps
        const allSwaps = await this.swapRepository.getAllSwaps();
        console.log("Starting SwapManager with", allSwaps.length, "swaps");
        await this.swapManager.start(allSwaps);
    }

    async stopSwapManager(): Promise<void> {
        await this.swapManager?.stop();
    }

    getSwapManager() {
        return this.swapManager ?? null;
    }

    async createLightningInvoice(
        args: CreateLightningInvoiceRequest
    ): Promise<CreateLightningInvoiceResponse> {
        const res = await this.sendMessage<
            RequestCreateLightningInvoice,
            ResponseCreateLightningInvoice
        >({
            type: "CREATE_LIGHTNING_INVOICE",
            payload: args,
        });
        return res.payload;
    }

    async sendLightningPayment(
        args: SendLightningPaymentRequest
    ): Promise<SendLightningPaymentResponse> {
        const res = await this.sendMessage<
            RequestSendLightningPayment,
            ResponseSendLightningPayment
        >({
            type: "SEND_LIGHTNING_PAYMENT",
            payload: args,
        });
        return res.payload;
    }

    async createSubmarineSwap(
        args: SendLightningPaymentRequest
    ): Promise<PendingSubmarineSwap> {
        const res = await this.sendMessage<
            RequestCreateSubmarineSwap,
            ResponseCreateSubmarineSwap
        >({
            type: "CREATE_SUBMARINE_SWAP",
            payload: args,
        });
        return res.payload;
    }

    async createReverseSwap(
        args: CreateLightningInvoiceRequest
    ): Promise<PendingReverseSwap> {
        const res = await this.sendMessage<
            RequestCreateReverseSwap,
            ResponseCreateReverseSwap
        >({
            type: "CREATE_REVERSE_SWAP",
            payload: args,
        });
        return res.payload;
    }

    async claimVHTLC(pendingSwap: PendingReverseSwap): Promise<void> {
        await this.sendMessage<RequestClaimVhtlc, ResponseClaimVhtlc>({
            type: "CLAIM_VHTLC",
            payload: pendingSwap,
        });
    }

    async refundVHTLC(pendingSwap: PendingSubmarineSwap): Promise<void> {
        await this.sendMessage<RequestRefundVhtlc, ResponseRefundVhtlc>({
            type: "REFUND_VHTLC",
            payload: pendingSwap,
        });
    }

    async waitAndClaim(
        pendingSwap: PendingReverseSwap
    ): Promise<{ txid: string }> {
        const res = await this.sendMessage<
            RequestWaitAndClaim,
            ResponseWaitAndClaim
        >({
            type: "WAIT_AND_CLAIM",
            payload: pendingSwap,
        });
        return res.payload;
    }

    async waitForSwapSettlement(
        pendingSwap: PendingSubmarineSwap
    ): Promise<{ preimage: string }> {
        const res = await this.sendMessage<
            RequestWaitForSwapSettlement,
            ResponseWaitForSwapSettlement
        >({
            type: "WAIT_FOR_SWAP_SETTLEMENT",
            payload: pendingSwap,
        });
        return res.payload;
    }

    async restoreSwaps(boltzFees?: FeesResponse): Promise<{
        reverseSwaps: PendingReverseSwap[];
        submarineSwaps: PendingSubmarineSwap[];
    }> {
        const res = await this.sendMessage<
            RequestRestoreSwaps,
            ResponseRestoreSwaps
        >({
            type: "RESTORE_SWAPS",
            payload: boltzFees,
        });
        return res.payload;
    }

    enrichReverseSwapPreimage(
        _swap: PendingReverseSwap,
        _preimage: string
    ): PendingReverseSwap {
        throw new Error(
            "enrichReverseSwapPreimage is not supported via service worker"
        );
    }

    enrichSubmarineSwapInvoice(
        _swap: PendingSubmarineSwap,
        _invoice: string
    ): PendingSubmarineSwap {
        throw new Error(
            "enrichSubmarineSwapInvoice is not supported via service worker"
        );
    }

    createVHTLCScript(_args: {
        network: string;
        preimageHash: Uint8Array;
        receiverPubkey: string;
        senderPubkey: string;
        serverPubkey: string;
        timeoutBlockHeights: {
            refund: number;
            unilateralClaim: number;
            unilateralRefund: number;
            unilateralRefundWithoutReceiver: number;
        };
    }): { vhtlcScript: VHTLC.Script; vhtlcAddress: string } {
        throw new Error(
            "createVHTLCScript is not supported via service worker"
        );
    }

    async getFees(): Promise<FeesResponse> {
        const res = await this.sendMessage<RequestGetFees, ResponseGetFees>({
            type: "GET_FEES",
        });
        return res.payload;
    }

    async getLimits(): Promise<LimitsResponse> {
        const res = await this.sendMessage<RequestGetLimits, ResponseGetLimits>(
            {
                type: "GET_LIMITS",
            }
        );
        return res.payload;
    }

    async getSwapStatus(swapId: string): Promise<GetSwapStatusResponse> {
        const res = await this.sendMessage<
            RequestGetSwapStatus,
            ResponseGetSwapStatus
        >({
            type: "GET_SWAP_STATUS",
            payload: { swapId },
        });
        return res.payload;
    }

    async getPendingSubmarineSwaps(): Promise<PendingSubmarineSwap[]> {
        const res = await this.sendMessage<
            RequestGetPendingSubmarineSwaps,
            ResponseGetPendingSubmarineSwaps
        >({
            type: "GET_PENDING_SUBMARINE_SWAPS",
        });
        return res.payload;
    }

    async getPendingReverseSwaps(): Promise<PendingReverseSwap[]> {
        const res = await this.sendMessage<
            RequestGetPendingReverseSwaps,
            ResponseGetPendingReverseSwaps
        >({
            type: "GET_PENDING_REVERSE_SWAPS",
        });
        return res.payload;
    }

    async getSwapHistory(): Promise<
        (PendingReverseSwap | PendingSubmarineSwap)[]
    > {
        const res = await this.sendMessage<
            RequestGetSwapHistory,
            ResponseGetSwapHistory
        >({
            type: "GET_SWAP_HISTORY",
        });
        return res.payload;
    }

    async refreshSwapsStatus(): Promise<void> {
        await this.sendMessage<
            RequestRefreshSwapsStatus,
            ResponseRefreshSwapsStatus
        >({
            type: "REFRESH_SWAPS_STATUS",
        });
    }

    normalizeToXOnlyPublicKey(
        _publicKey: Uint8Array,
        _keyName: string,
        _swapId?: string
    ): Uint8Array {
        throw new Error(
            "normalizeToXOnlyPublicKey is not supported via service worker"
        );
    }

    async dispose(): Promise<void> {
        // TODO: stop the updater?
    }

    async [Symbol.asyncDispose](): Promise<void> {
        return this.dispose();
    }

    private async sendMessage<
        REQ extends RequestEnvelope = RequestEnvelope,
        RES extends ResponseEnvelope = ResponseEnvelope,
    >(message: Partial<REQ>): Promise<RES> {
        const id = typeof message.id === "string" ? message.id : getRandomId();

        return new Promise((resolve, reject) => {
            const messageHandler = (event: MessageEvent) => {
                const response = event.data as RES;
                if (!response) return;
                if (response.tag !== this.messageTag) return;
                if (response.id !== id) return;

                navigator.serviceWorker.removeEventListener(
                    "message",
                    messageHandler
                );

                if (response.error) {
                    reject(response.error);
                } else {
                    resolve(response);
                }
            };

            navigator.serviceWorker.addEventListener("message", messageHandler);
            this.serviceWorker.postMessage({
                tag: this.messageTag,
                id,
                type: "type" in message ? message.type : "NO_TYPE",
                payload: "payload" in message ? message.payload : undefined,
            });
        });
    }
}

function getRandomId(): string {
    return `${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
}
