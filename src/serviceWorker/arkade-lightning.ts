import { IArkadeLightning } from "../arkade-lightning";
import { ArkProvider, IContractManager, IndexerProvider, ServiceWorkerWallet, Wallet } from "../../../ts-sdk/src";
import { BoltzSwapProvider } from "../boltz-swap-provider";
import { SwapManager, SwapManagerConfig } from "../swap-manager";
import { SwapRepository } from "../repositories/swap-repository";
import { ArkadeLightningConfig, FeeConfig, RefundHandler, RetryConfig, TimeoutConfig } from "../types";
import { logger } from "../logger";
import { IndexedDbSwapRepository } from "../repositories/IndexedDb/swap-repository";
import { DEFAULT_MESSAGE_TAG } from "./arkade-lightning-updater";

export type  SvcArkadeLightningConfig = {

    // sw
    messageTag? : string
    // path?

    // shared
    wallet: Wallet | ServiceWorkerWallet;
    arkProvider?: ArkProvider;
    swapProvider: BoltzSwapProvider;
    indexerProvider?: IndexerProvider;
    feeConfig?: Partial<FeeConfig>;
    refundHandler?: RefundHandler;
    timeoutConfig?: Partial<TimeoutConfig>;
    retryConfig?: Partial<RetryConfig>;
    /**
     * Enable background swap monitoring and autonomous actions.
     * - `false` or `undefined`: SwapManager disabled
     * - `true`: SwapManager enabled with default configuration
     * - `SwapManagerConfig` object: SwapManager enabled with custom configuration
     */
    swapManager?: boolean | (SwapManagerConfig & { autoStart?: boolean });
    contractManager?: IContractManager;
    /**
     * Optional swap repository to use for persisting swap data.
     * - `undefined`: fallback to default IndexedDbSwapRepository
     * - `SwapRepository` object: SwapRepository enabled with custom configuration
     */
    swapRepository?: SwapRepository;
}

type SvcArkadeLightningOptions = {
    swapManagerAutostart: boolean
}

export class ServiceWorkerArkadeLightning implements IArkadeLightning {
    // private readonly wallet: Wallet; TODO: this is the WalletUpdater and we communicate via messages

    // data sources

    private constructor(
        public readonly serviceWorker: ServiceWorker,
        private readonly arkProvider: ArkProvider,
        private readonly indexerProvider: IndexerProvider,
        private readonly swapProvider: BoltzSwapProvider,
        private readonly swapRepository: SwapRepository,
        private readonly swapManager: SwapManager | null,
        protected readonly messageTag: string,
        config: SvcArkadeLightningOptions
    ) {
        if (config.swapManagerAutostart && swapManager) {
            // Start in background without blocking constructor
            this.startSwapManager().catch((error) => {
                logger.error("Failed to autostart SwapManager:", error);
            });
        }
    }

    static create(options: SvcArkadeLightningConfig) {
        const swapRepository = options.swapRepository ?? new IndexedDbSwapRepository()
        const messageTag = options.messageTag ?? DEFAULT_MESSAGE_TAG;

        // Initialize SwapManager if config is provided
        // - true: use defaults
        // - object: use provided config
        // - false/undefined: disabled
        let swapManager: SwapManager | null; = null
        if (options.swapManager) {
            const swapManagerConfig =
                options.swapManager === true
                    ? ({} as SwapManagerConfig & { autoStart?: boolean })
                    : options.swapManager;

            // Extract autostart (defaults to true) before passing to SwapManager
            // SwapManager doesn't need it - only ArkadeLightning uses it
            const shouldAutostart = swapManagerConfig.autoStart ?? true;

            swapManager = new SwapManager(
                options.serviceWorker,
                swapManagerConfig
            );

            // Set up callbacks for claim, refund, and save operations
            this.swapManager.setCallbacks({
                claim: async (swap: PendingReverseSwap) => {
                    await this.claimVHTLC(swap);
                },
                refund: async (swap: PendingSubmarineSwap) => {
                    await this.refundVHTLC(swap);
                },
                saveSwap: async (
                    swap: PendingReverseSwap | PendingSubmarineSwap
                ) => {
                    await saveSwap(swap, {
                        saveSwap: this.swapRepository.saveSwap.bind(
                            this.swapRepository
                        ),
                    });
                },
            });
        }

        const svcArkadeLightning = new ServiceWorkerArkadeLightning(
            swapRepository,
            options.arkProvider,
            options.indexerProvider,
            options.swapProvider,
            swapRepository,
            messageTag,
        )
    }

    /* --- SwapManager --- */

    /**
     * Start the background swap manager
     * This will load all pending swaps and begin monitoring them
     * Automatically called when SwapManager is enabled
     */
    async startSwapManager(): Promise<void> {
        if (!this.swapManager) {
            throw new Error(
                "SwapManager is not enabled. Provide 'swapManager' config in SvcArkadeLightningConfig."
            );
        }

        // Load all pending swaps from storage
        const allSwaps = await this.swapRepository.getAllSwaps();

        console.log("Starting SwapManager with", allSwaps.length, "swaps");
        // Start the manager with all pending swaps
        await this.swapManager.start(allSwaps);
    }
}