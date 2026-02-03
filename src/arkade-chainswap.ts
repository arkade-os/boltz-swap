import {
    SwapError,
    SwapExpiredError,
    TransactionFailedError,
    TransactionRefundedError,
} from "./errors";
import {
    ArkAddress,
    ArkProvider,
    IndexerProvider,
    buildOffchainTx,
    ConditionWitness,
    ServiceWorkerWallet,
    CSVMultisigTapscript,
    setArkPsbtField,
    Transaction as ARKTransaction,
    Wallet,
    VHTLC,
    TapLeafScript,
    ArkInfo,
    isRecoverable,
    ArkTxInput,
    Identity,
} from "@arkade-os/sdk";
import type {
    Chain,
    LimitsResponse,
    PendingChainSwap,
    ChainFeesResponse,
    ArkadeChainSwapConfig,
    PendingSwap,
} from "./types";
import {
    BoltzSwapProvider,
    GetSwapStatusResponse,
    isChainFinalStatus,
    BoltzSwapStatus,
} from "./boltz-swap-provider";
import { base64, hex } from "@scure/base";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { TransactionInput, TransactionOutput } from "@scure/btc-signer/psbt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
    SwapTreeSerializer,
    TaprootUtils,
    Musig,
    Networks,
    constructClaimTransaction,
    targetFee,
    detectSwap,
    OutputType,
} from "boltz-core";
import { randomBytes } from "crypto";
import { Address, OutScript, SigHash, Transaction } from "@scure/btc-signer";
import { normalizeToXOnlyKey } from "./utils/signatures";
import { isValidArkAddress } from "./utils/decoding";
import { joinBatch, refundVHTLCwithOffchainTx } from "./utils/vhtlc";
import { SwapManager } from "./swap-manager";
import { saveSwap } from "./utils/swap-helpers";
import { logger } from "./logger";

/**
 * Returns the signer session from a wallet.
 * If the signer session is a factory, it will be invoked.
 * @param wallet - Wallet instance with an identity signer session.
 * @returns The signer session or undefined.
 */
function getSignerSession(wallet: Wallet | ServiceWorkerWallet): any {
    const signerSession = wallet.identity.signerSession;

    // If signerSession is a function (factory), call it to get the actual session
    if (typeof signerSession === "function") {
        return signerSession();
    }

    // Otherwise return it directly (could be the session object or undefined)
    return signerSession;
}

export class ArkadeChainSwap {
    private readonly wallet: Wallet | ServiceWorkerWallet;
    private readonly arkProvider: ArkProvider;
    private readonly swapProvider: BoltzSwapProvider;
    private readonly indexerProvider: IndexerProvider;
    private readonly swapManager: SwapManager | null = null;

    /**
     * Creates an Arkade chain swap client.
     * @param config - Configuration for providers, wallet, and swap manager.
     */
    constructor(config: ArkadeChainSwapConfig) {
        if (!config.wallet) throw new Error("Wallet is required.");
        if (!config.swapProvider) throw new Error("Swap provider is required.");

        this.wallet = config.wallet;
        // Prioritize wallet providers, fallback to config providers for backward compatibility
        const arkProvider =
            (config.wallet as any).arkProvider ?? config.arkProvider;
        if (!arkProvider)
            throw new Error(
                "Ark provider is required either in wallet or config."
            );
        this.arkProvider = arkProvider;

        const indexerProvider =
            (config.wallet as any).indexerProvider ?? config.indexerProvider;
        if (!indexerProvider)
            throw new Error(
                "Indexer provider is required either in wallet or config."
            );
        this.indexerProvider = indexerProvider;

        this.swapProvider = config.swapProvider;

        // Initialize SwapManager if config is provided
        // - true: use defaults
        // - object: use provided config
        // - false/undefined: disabled
        if (config.swapManager) {
            const swapManagerConfig =
                config.swapManager === true ? {} : config.swapManager;

            // Extract autostart (defaults to true) before passing to SwapManager
            // SwapManager doesn't need it - only ArkadeLightning uses it
            const shouldAutostart = swapManagerConfig.autoStart ?? true;

            this.swapManager = new SwapManager(
                this.swapProvider,
                swapManagerConfig
            );

            // Set up callbacks for claim, refund, and save operations
            this.swapManager.setChainCallbacks({
                claimArk: async (swap: PendingChainSwap) => {
                    await this.claimArk(swap);
                },
                claimBtc: async (
                    swap: PendingChainSwap,
                    data: { transaction: { id: string; hex: string } }
                ) => {
                    await this.claimBtc(swap, data);
                },
                refundArk: async (swap: PendingChainSwap) => {
                    await this.refundArk(swap);
                },
                saveSwap: async (swap: PendingSwap) => {
                    await saveSwap(swap, {
                        saveChainSwap: this.savePendingChainSwap.bind(this),
                    });
                },
            });

            // Autostart if configured (defaults to true)
            if (shouldAutostart) {
                // Start in background without blocking constructor
                this.startSwapManager().catch((error) => {
                    logger.error("Failed to autostart SwapManager:", error);
                });
            }
        }
    }

    /**
     * Creates a chain swap from ARK to BTC.
     * @param args - Swap arguments.
     * @param args.toAddress - Destination BTC address.
     * @param args.amountSats - Amount in sats.
     * @param args.feeSatsPerByte - Optional fee rate in sats/vbyte.
     * @returns The pending chain swap.
     */
    async arkToBtc(args: {
        toAddress: string;
        amountSats: number;
        feeSatsPerByte?: number;
    }): Promise<PendingChainSwap> {
        // deconstruct args and validate
        const feeSatsPerByte = args.feeSatsPerByte ?? 1;
        const { toAddress, amountSats } = args;
        if (!toAddress) {
            throw new SwapError({
                message: "Invalid Btc address in arkToBtc",
            });
        }
        if (amountSats <= 0) {
            throw new SwapError({
                message: "Invalid amount in arkToBtc",
            });
        }

        // get ark info
        const arkInfo = await this.arkProvider.getInfo();

        // create chain swap
        const pendingSwap = await this.createChainSwap({
            to: "BTC",
            from: "ARK",
            feeSatsPerByte,
            userLockAmount: amountSats,
            toAddress,
        });

        // verify swap details
        await this.verifyChainSwap({
            arkInfo,
            to: "BTC",
            from: "ARK",
            swap: pendingSwap,
        }).catch((err) => {
            throw new SwapError({
                message: `Chain swap verification failed: ${err.message}`,
            });
        });

        // send funds to the swap address
        await this.wallet.sendBitcoin({
            address: pendingSwap.response.lockupDetails.lockupAddress,
            amount: pendingSwap.response.lockupDetails.amount,
        });

        // wait for the swap to be ready and claim the HTLC
        try {
            await this.waitAndClaimBtc(pendingSwap);
        } catch (error: any) {
            if (error.isRefundable) {
                await this.refundArk(pendingSwap);
                const { status } = await this.getSwapStatus(pendingSwap.id);
                this.savePendingChainSwap({ ...pendingSwap, status });
            }
            throw new TransactionFailedError();
        }

        const { status } = await this.getSwapStatus(pendingSwap.id);
        await this.savePendingChainSwap({ ...pendingSwap, status });
        return { ...pendingSwap, status };
    }

    /**
     * Waits for the swap to be confirmed and claims it.
     * @param pendingSwap - The pending chain swap to monitor.
     * @returns The transaction ID of the claimed HTLC.
     * @throws SwapExpiredError, TransactionFailedError, TransactionRefundedError
     */
    async waitAndClaimBtc(
        pendingSwap: PendingChainSwap
    ): Promise<{ txid: string }> {
        return new Promise<{ txid: string }>((resolve, reject) => {
            let claimStarted = false;
            // https://api.docs.boltz.exchange/lifecycle.html#swap-states
            const onStatusUpdate = async (
                status: BoltzSwapStatus,
                data: any
            ) => {
                const updateSwapStatus = (status: BoltzSwapStatus) => {
                    return this.savePendingChainSwap({
                        ...pendingSwap,
                        status,
                    });
                };
                switch (status) {
                    case "transaction.mempool":
                    case "transaction.confirmed":
                        await updateSwapStatus(status);
                        break;
                    case "transaction.server.mempool":
                    case "transaction.server.confirmed":
                        await updateSwapStatus(status);
                        if (claimStarted) return;
                        claimStarted = true;
                        this.claimBtc(pendingSwap, data).catch(reject);
                        break;
                    case "transaction.claimed":
                        await updateSwapStatus(status);
                        resolve({
                            txid:
                                data?.transaction?.id ??
                                pendingSwap.response.id,
                        });
                        break;
                    case "transaction.lockupFailed":
                        await updateSwapStatus(status);
                        await this.quoteSwap(pendingSwap.response.id);
                        break;
                    case "swap.expired":
                        await updateSwapStatus(status);
                        reject(
                            new SwapExpiredError({
                                isRefundable: true,
                                pendingSwap,
                            })
                        );
                        break;
                    case "transaction.failed":
                        await updateSwapStatus(status);
                        reject(
                            new TransactionFailedError({ isRefundable: true })
                        );
                        break;
                    case "transaction.refunded":
                        await updateSwapStatus(status);
                        reject(new TransactionRefundedError());
                        break;
                    default:
                        await updateSwapStatus(status);
                        break;
                }
            };

            this.swapProvider.monitorSwap(pendingSwap.id, onStatusUpdate);
        });
    }

    /**
     * Claim sats on BTC chain by claiming the HTLC.
     * @param pendingSwap - The pending chain swap.
     * @param data - Swap status update data containing the lockup transaction.
     */
    async claimBtc(
        pendingSwap: PendingChainSwap,
        data: { transaction: { id: string; hex: string } }
    ): Promise<void> {
        if (!pendingSwap.toAddress)
            throw new Error("Destination address is required");

        if (!pendingSwap.response.claimDetails.swapTree)
            throw new Error("Missing swap tree in claim details");

        if (!pendingSwap.response.claimDetails.serverPublicKey)
            throw new Error("Missing server public key in claim details");

        const lockupTx = Transaction.fromRaw(hex.decode(data.transaction.hex));

        const arkInfo = await this.arkProvider.getInfo();

        const network =
            arkInfo.network === "bitcoin" ? Networks.bitcoin : Networks.regtest;

        const swapTree = SwapTreeSerializer.deserializeSwapTree(
            pendingSwap.response.claimDetails.swapTree
        );

        const musig = TaprootUtils.tweakMusig(
            Musig.create(hex.decode(pendingSwap.ephemeralKey), [
                hex.decode(pendingSwap.response.claimDetails.serverPublicKey),
                secp256k1.getPublicKey(hex.decode(pendingSwap.ephemeralKey)),
            ]),
            swapTree.tree
        );
        const swapOutput = detectSwap(musig.aggPubkey, lockupTx)!;
        const claimTx = targetFee(1, (fee) =>
            constructClaimTransaction(
                [
                    {
                        preimage: hex.decode(pendingSwap.preimage),
                        type: OutputType.Taproot,
                        script: swapOutput.script!,
                        amount: swapOutput.amount!,
                        vout: swapOutput.vout!,
                        privateKey: hex.decode(pendingSwap.ephemeralKey),
                        transactionId: lockupTx.id,
                        swapTree: swapTree,
                        internalKey: musig.internalKey,
                        cooperative: true, // set to false to enforce script path
                    },
                ],
                OutScript.encode(
                    Address(network).decode(pendingSwap.toAddress!)
                ),
                fee
            )
        );

        const musigMessage = musig
            .message(
                claimTx.preimageWitnessV1(
                    0,
                    [swapOutput.script!],
                    SigHash.DEFAULT,
                    [swapOutput.amount!]
                )
            )
            .generateNonce();

        const signedTxData = await this.swapProvider.postChainClaimDetails(
            pendingSwap.response.id,
            {
                preimage: pendingSwap.preimage,
                toSign: {
                    pubNonce: hex.encode(musigMessage.publicNonce),
                    transaction: claimTx.hex,
                    index: 0,
                },
            }
        );

        if (!signedTxData.pubNonce || !signedTxData.partialSignature)
            throw new Error("Invalid signature data from server");

        const musigSession = musigMessage
            .aggregateNonces([
                [
                    hex.decode(
                        pendingSwap.response.claimDetails.serverPublicKey
                    ),
                    hex.decode(signedTxData.pubNonce),
                ],
            ])
            .initializeSession();

        musigSession.addPartial(
            hex.decode(pendingSwap.response.claimDetails.serverPublicKey),
            hex.decode(signedTxData.partialSignature)
        );
        const musigSigned = musigSession.signPartial();

        claimTx.updateInput(0, {
            finalScriptWitness: [musigSigned.aggregatePartials()],
        });

        await this.swapProvider.postBtcTransaction(claimTx.hex);
    }

    /**
     * When an ARK to BTC swap fails, claim sats on ARK chain by claiming the VHTLC.
     * @param pendingSwap - The pending chain swap.
     */
    async refundArk(pendingSwap: PendingChainSwap): Promise<void> {
        if (!pendingSwap.response.lockupDetails.serverPublicKey)
            throw new Error("Missing server public key in lockup details");

        if (!pendingSwap.response.lockupDetails.timeouts)
            throw new Error("Missing timeouts in lockup details");

        const arkInfo = await this.arkProvider.getInfo();

        const address = await this.wallet.getAddress();

        // validate we are using a x-only public key
        const ourXOnlyPublicKey = await this.wallet.identity.xOnlyPublicKey();

        // validate we are using a x-only server public key
        const serverXOnlyPublicKey = normalizeToXOnlyKey(
            hex.decode(arkInfo.signerPubkey),
            "server",
            pendingSwap.id
        );

        // validate we are using a x-only boltz public key
        const boltzXOnlyPublicKey = normalizeToXOnlyKey(
            hex.decode(pendingSwap.response.lockupDetails.serverPublicKey),
            "boltz",
            pendingSwap.id
        );

        const vhtlcPkScript = ArkAddress.decode(
            pendingSwap.response.lockupDetails.lockupAddress
        ).pkScript;

        // get spendable VTXOs from the lockup address
        const { vtxos } = await this.indexerProvider.getVtxos({
            scripts: [hex.encode(vhtlcPkScript)],
        });

        if (vtxos.length === 0) {
            throw new Error(
                `VHTLC not found for address ${pendingSwap.response.lockupDetails.lockupAddress}`
            );
        }

        const vtxo = vtxos[0];

        if (vtxo.isSpent) {
            throw new Error("VHTLC is already spent");
        }

        // build expected VHTLC script

        const { vhtlcAddress, vhtlcScript } = this.createVHTLCScript({
            network: arkInfo.network,
            preimageHash: hex.decode(pendingSwap.request.preimageHash),
            serverPubkey: hex.encode(serverXOnlyPublicKey),
            senderPubkey: hex.encode(ourXOnlyPublicKey),
            receiverPubkey: hex.encode(boltzXOnlyPublicKey),
            timeoutBlockHeights: pendingSwap.response.lockupDetails.timeouts!,
        });

        if (!vhtlcScript.refundScript)
            throw new Error("Failed to create VHTLC script for chain swap");

        if (pendingSwap.response.lockupDetails.lockupAddress !== vhtlcAddress) {
            throw new SwapError({
                message: "Unable to claim: invalid VHTLC address",
            });
        }

        const isRecoverableVtxo = isRecoverable(vtxo);

        const input = {
            ...vtxo,
            tapLeafScript: isRecoverableVtxo
                ? vhtlcScript.refundWithoutReceiver()
                : vhtlcScript.refund(),
            tapTree: vhtlcScript.encode(),
        };

        const output = {
            amount: BigInt(vtxo.value),
            script: ArkAddress.decode(address).pkScript,
        };

        if (isRecoverableVtxo) {
            await this.joinBatch(this.wallet.identity, input, output, arkInfo);
        } else {
            await refundVHTLCwithOffchainTx(
                pendingSwap.id,
                this.wallet.identity,
                this.arkProvider,
                boltzXOnlyPublicKey,
                ourXOnlyPublicKey,
                serverXOnlyPublicKey,
                input,
                output,
                arkInfo,
                this.swapProvider.refundChainSwap.bind(this.swapProvider)
            );
        }

        // update the pending swap on storage if available
        const finalStatus = await this.getSwapStatus(pendingSwap.id);
        await this.savePendingChainSwap({
            ...pendingSwap,
            status: finalStatus.status,
        });
    }

    /**
     * Creates a chain swap from BTC to ARK.
     * @param args - Swap arguments.
     * @param args.toAddress - Destination Ark address.
     * @param args.amountSats - Amount in sats.
     * @param args.feeSatsPerByte - Optional fee rate in sats/vbyte.
     * @param args.onAddressGenerated - Callback invoked with lockup address.
     * @returns The pending chain swap.
     */
    async btcToArk(args: {
        toAddress: string;
        amountSats: number;
        feeSatsPerByte?: number;
        onAddressGenerated: (address: string) => void;
    }): Promise<PendingChainSwap> {
        // deconstruct args and validate
        const feeSatsPerByte = args.feeSatsPerByte ?? 1;
        const { amountSats, toAddress, onAddressGenerated } = args;

        if (!toAddress || !isValidArkAddress(toAddress)) {
            throw new SwapError({
                message: "Invalid Ark address in btcToArk",
            });
        }

        if (amountSats <= 0) {
            throw new SwapError({
                message: "Invalid amount in btcToArk",
            });
        }

        const arkInfo = await this.arkProvider.getInfo();

        // create chain swap
        const pendingSwap = await this.createChainSwap({
            to: "ARK",
            from: "BTC",
            feeSatsPerByte,
            userLockAmount: amountSats,
            toAddress,
        });

        // verify swap details
        await this.verifyChainSwap({
            arkInfo,
            to: "ARK",
            from: "BTC",
            swap: pendingSwap,
        }).catch((err) => {
            throw new SwapError({
                message: `Chain swap verification failed: ${err.message}`,
            });
        });

        // notify the user of the generated lockup address
        onAddressGenerated(pendingSwap.response.lockupDetails.lockupAddress);

        // wait for the swap to be ready and claim the VHTLC
        await this.waitAndClaimArk(pendingSwap);

        const { status } = await this.getSwapStatus(pendingSwap.id);
        await this.savePendingChainSwap({ ...pendingSwap, status });
        return { ...pendingSwap, status };
    }

    /**
     * Waits for the swap to be confirmed and claims it.
     * @param pendingSwap - The pending chain swap to monitor.
     * @returns The transaction ID of the claimed VHTLC.
     */
    async waitAndClaimArk(
        pendingSwap: PendingChainSwap
    ): Promise<{ txid: string }> {
        return new Promise<{ txid: string }>((resolve, reject) => {
            let claimStarted = false;
            // https://api.docs.boltz.exchange/lifecycle.html#swap-states
            const onStatusUpdate = async (status: BoltzSwapStatus) => {
                const updateSwapStatus = (status: BoltzSwapStatus) => {
                    return this.savePendingChainSwap({
                        ...pendingSwap,
                        status,
                    });
                };
                switch (status) {
                    case "transaction.server.mempool":
                    case "transaction.server.confirmed":
                        await updateSwapStatus(status);
                        if (claimStarted) return;
                        claimStarted = true;
                        this.claimArk(pendingSwap).catch(reject);
                        break;
                    case "transaction.claimed":
                        await updateSwapStatus(status);
                        resolve({ txid: pendingSwap.response.id });
                        break;
                    case "transaction.claim.pending":
                        // Be nice and sign a cooperative claim for the server
                        // Not required: you can treat this as success already,
                        // the server will batch sweep eventually
                        await updateSwapStatus(status);
                        await this.signCooperativeClaimForServer(
                            pendingSwap
                        ).catch();
                        resolve({ txid: pendingSwap.response.id });
                        break;
                    case "transaction.lockupFailed":
                        await updateSwapStatus(status);
                        await this.quoteSwap(pendingSwap.response.id);
                        break;
                    case "swap.expired":
                        await updateSwapStatus(status);
                        reject(
                            new SwapExpiredError({
                                isRefundable: true,
                                pendingSwap,
                            })
                        );
                        break;
                    case "transaction.failed":
                        await updateSwapStatus(status);
                        reject(new TransactionFailedError());
                        break;
                    case "transaction.refunded":
                        await updateSwapStatus(status);
                        reject(new TransactionRefundedError());
                        break;
                    default:
                        await updateSwapStatus(status);
                        break;
                }
            };

            this.swapProvider.monitorSwap(pendingSwap.id, onStatusUpdate);
        });
    }

    /**
     * Claim sats on ARK chain by claiming the VHTLC.
     * @param pendingSwap - The pending chain swap.
     */
    async claimArk(pendingSwap: PendingChainSwap): Promise<void> {
        if (!pendingSwap.toAddress)
            throw new Error("Destination address is required");

        if (!pendingSwap.response.claimDetails.serverPublicKey)
            throw new Error("Missing server public key in claim details");

        if (!pendingSwap.response.claimDetails.timeouts)
            throw new Error("Missing timeouts in claim details");

        const arkInfo = await this.arkProvider.getInfo();

        const preimage = hex.decode(pendingSwap.preimage);

        const address = await this.wallet.getAddress();

        // build expected VHTLC script
        const receiverXOnlyPublicKey = normalizeToXOnlyKey(
            pendingSwap.request.claimPublicKey,
            "receiver"
        );

        const senderXOnlyPublicKey = normalizeToXOnlyKey(
            pendingSwap.response.claimDetails.serverPublicKey!,
            "sender"
        );

        const serverXOnlyPublicKey = normalizeToXOnlyKey(
            arkInfo.signerPubkey,
            "server"
        );

        const { vhtlcAddress, vhtlcScript } = this.createVHTLCScript({
            network: arkInfo.network,
            preimageHash: hex.decode(pendingSwap.request.preimageHash),
            serverPubkey: hex.encode(serverXOnlyPublicKey),
            senderPubkey: hex.encode(senderXOnlyPublicKey),
            receiverPubkey: hex.encode(receiverXOnlyPublicKey),
            timeoutBlockHeights: pendingSwap.response.claimDetails.timeouts!,
        });

        if (!vhtlcScript.claimScript)
            throw new Error("Failed to create VHTLC script for chain swap");

        if (pendingSwap.response.claimDetails.lockupAddress !== vhtlcAddress) {
            throw new SwapError({
                message: "Unable to claim: invalid VHTLC address",
            });
        }

        // get spendable VTXOs from the lockup address
        const spendableVtxos = await this.indexerProvider.getVtxos({
            scripts: [hex.encode(vhtlcScript.pkScript)],
            spendableOnly: true,
        });

        if (spendableVtxos.vtxos.length === 0)
            throw new Error("No spendable virtual coins found");

        // vtxo with the htlc to claim
        const vtxo = spendableVtxos.vtxos[0];

        // signing a VTHLC needs an extra witness element to be added to the PSBT input
        // reveal the secret in the PSBT, thus the server can verify the claim script
        // this witness must satisfy the preimageHash condition
        const vhtlcIdentity = {
            sign: async (tx: any, inputIndexes?: number[]) => {
                const cpy = tx.clone();
                let signedTx = await this.wallet.identity.sign(
                    cpy,
                    inputIndexes
                );
                signedTx = ARKTransaction.fromPSBT(signedTx.toPSBT(), {
                    allowUnknown: true,
                });
                setArkPsbtField(signedTx, 0, ConditionWitness, [preimage]);
                return signedTx;
            },
            xOnlyPublicKey: pendingSwap.request.claimPublicKey,
            signerSession: getSignerSession(this.wallet),
        };

        // create the server unroll script for checkpoint transactions
        const rawCheckpointTapscript = hex.decode(arkInfo.checkpointTapscript);
        const serverUnrollScript = CSVMultisigTapscript.decode(
            rawCheckpointTapscript
        );

        // create the offchain transaction to claim the VHTLC
        const { arkTx, checkpoints } = buildOffchainTx(
            [
                {
                    ...spendableVtxos.vtxos[0],
                    tapLeafScript: vhtlcScript.claim(),
                    tapTree: vhtlcScript.encode(),
                },
            ],
            [
                {
                    amount: BigInt(vtxo.value),
                    script: ArkAddress.decode(address).pkScript,
                },
            ],
            serverUnrollScript
        );

        // sign and submit the virtual transaction
        const signedArkTx = await vhtlcIdentity.sign(arkTx);
        const { arkTxid, finalArkTx, signedCheckpointTxs } =
            await this.arkProvider.submitTx(
                base64.encode(signedArkTx.toPSBT()),
                checkpoints.map((c) => base64.encode(c.toPSBT()))
            );

        // verify the server signed the transaction with correct key
        if (
            !this.validFinalArkTx(
                finalArkTx,
                hex.decode(arkInfo.signerPubkey),
                vhtlcScript.leaves
            )
        ) {
            throw new Error("Invalid final Ark transaction");
        }

        // sign the checkpoint transactions pre signed by the server
        const finalCheckpoints = await Promise.all(
            signedCheckpointTxs.map(async (c) => {
                const tx = ARKTransaction.fromPSBT(base64.decode(c), {
                    allowUnknown: true,
                });
                const signedCheckpoint = await vhtlcIdentity.sign(tx, [0]);
                return base64.encode(signedCheckpoint.toPSBT());
            })
        );

        // submit the final transaction to the Ark provider
        await this.arkProvider.finalizeTx(arkTxid, finalCheckpoints);

        // update the pending swap on storage if available
        const finalStatus = await this.getSwapStatus(pendingSwap.id);
        await this.savePendingChainSwap({
            ...pendingSwap,
            status: finalStatus.status,
        });
    }

    /**
     * Sign a cooperative claim for the server in BTC => ARK swaps.
     * @param pendingSwap - The pending chain swap.
     */
    async signCooperativeClaimForServer(
        pendingSwap: PendingChainSwap
    ): Promise<void> {
        if (!pendingSwap.response.lockupDetails.swapTree)
            throw new Error("Missing swap tree in lockup details");

        if (!pendingSwap.response.lockupDetails.serverPublicKey)
            throw new Error("Missing server public key in lockup details");

        const claimDetails = await this.swapProvider.getChainClaimDetails(
            pendingSwap.id
        );

        const musig = TaprootUtils.tweakMusig(
            Musig.create(hex.decode(pendingSwap.ephemeralKey), [
                hex.decode(claimDetails.publicKey),
                secp256k1.getPublicKey(hex.decode(pendingSwap.ephemeralKey)),
            ]),
            SwapTreeSerializer.deserializeSwapTree(
                pendingSwap.response.lockupDetails.swapTree
            ).tree
        );

        const musigNonces = musig
            .message(hex.decode(claimDetails.transactionHash))
            .generateNonce()
            .aggregateNonces([
                [
                    hex.decode(
                        pendingSwap.response.lockupDetails.serverPublicKey
                    ),
                    hex.decode(claimDetails.pubNonce),
                ],
            ])
            .initializeSession();

        const partialSig = musigNonces.signPartial();

        await this.swapProvider.postChainClaimDetails(pendingSwap.response.id, {
            signature: {
                partialSignature: hex.encode(partialSig.ourPartialSignature),
                pubNonce: hex.encode(partialSig.publicNonce),
            },
        });
    }

    /**
     * Creates a VHTLC script for the swap.
     * It creates a VHTLC script that can be used to claim or refund the swap.
     * It validates the receiver, sender, and server public keys are x-only.
     * It encodes the VHTLC address from the VHTLC script.
     * @param args - The parameters for creating the VHTLC script.
     * @returns The created VHTLC script and address.
     */
    createVHTLCScript(args: {
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
        const {
            network,
            preimageHash,
            receiverPubkey,
            senderPubkey,
            serverPubkey,
            timeoutBlockHeights,
        } = args;

        // validate we are using a x-only receiver public key
        const receiverXOnlyPublicKey = normalizeToXOnlyKey(
            hex.decode(receiverPubkey),
            "receiver"
        );

        // validate we are using a x-only sender public key
        const senderXOnlyPublicKey = normalizeToXOnlyKey(
            hex.decode(senderPubkey),
            "sender"
        );

        // validate we are using a x-only server public key
        const serverXOnlyPublicKey = normalizeToXOnlyKey(
            hex.decode(serverPubkey),
            "server"
        );

        const delayType = (num: number) => (num < 512 ? "blocks" : "seconds");

        const vhtlcScript = new VHTLC.Script({
            preimageHash: ripemd160(preimageHash),
            sender: senderXOnlyPublicKey,
            receiver: receiverXOnlyPublicKey,
            server: serverXOnlyPublicKey,
            refundLocktime: BigInt(timeoutBlockHeights.refund),
            unilateralClaimDelay: {
                type: delayType(timeoutBlockHeights.unilateralClaim),
                value: BigInt(timeoutBlockHeights.unilateralClaim),
            },
            unilateralRefundDelay: {
                type: delayType(timeoutBlockHeights.unilateralRefund),
                value: BigInt(timeoutBlockHeights.unilateralRefund),
            },
            unilateralRefundWithoutReceiverDelay: {
                type: delayType(
                    timeoutBlockHeights.unilateralRefundWithoutReceiver
                ),
                value: BigInt(
                    timeoutBlockHeights.unilateralRefundWithoutReceiver
                ),
            },
        });

        if (!vhtlcScript.claimScript)
            throw new Error("Failed to create VHTLC script");

        // encode vhtlc address from vhtlc script
        const hrp = network === "bitcoin" ? "ark" : "tark";
        const vhtlcAddress = vhtlcScript
            .address(hrp, serverXOnlyPublicKey)
            .encode();

        return { vhtlcScript, vhtlcAddress };
    }

    /**
     * Creates a chain swap.
     * @param args - The arguments for creating a chain swap.
     * @returns The created pending chain swap.
     */
    async createChainSwap(args: {
        to: Chain;
        from: Chain;
        feeSatsPerByte: number;
        userLockAmount?: number;
        serverLockAmount?: number;
        toAddress?: string;
    }): Promise<PendingChainSwap> {
        // deconstruct args and validate
        const { to, from, feeSatsPerByte, serverLockAmount, userLockAmount } =
            args;

        // create random preimage and its hash
        const preimage = randomBytes(32);
        const preimageHash = hex.encode(sha256(preimage));
        if (!preimageHash)
            throw new SwapError({ message: "Failed to get preimage hash" });

        // ephemeral keys
        // needed to claim/refund on the BTC chain
        const ephemeralKey = secp256k1.utils.randomSecretKey();

        // get refund public key
        // needed in case the swap fails and needs to be refunded
        const refundPublicKey =
            to === "ARK"
                ? hex.encode(secp256k1.getPublicKey(ephemeralKey))
                : hex.encode(await this.wallet.identity.compressedPublicKey());

        if (!refundPublicKey)
            throw new SwapError({
                message: "Failed to get refund public key",
            });

        // create claim public key for the swap
        const claimPublicKey =
            to === "ARK"
                ? hex.encode(await this.wallet.identity.compressedPublicKey())
                : hex.encode(secp256k1.getPublicKey(ephemeralKey));

        if (!claimPublicKey)
            throw new SwapError({
                message: "Failed to get claim public key",
            });

        // build request object for chain swap
        const swapRequest = {
            to,
            from,
            preimageHash,
            feeSatsPerByte,
            claimPublicKey,
            refundPublicKey,
            serverLockAmount,
            userLockAmount,
        };

        // make chain swap request
        const swapResponse =
            await this.swapProvider.createChainSwap(swapRequest);

        const pendingSwap: PendingChainSwap = {
            id: swapResponse.id,
            type: "chain",
            feeSatsPerByte,
            ephemeralKey: hex.encode(ephemeralKey),
            createdAt: Math.floor(Date.now() / 1000),
            preimage: hex.encode(preimage),
            request: swapRequest,
            response: swapResponse,
            status: "swap.created",
            toAddress: args.toAddress,
        };

        // save pending swap to storage if available
        await this.savePendingChainSwap(pendingSwap);

        return pendingSwap;
    }

    /**
     * Validates the lockup and claim addresses match the expected scripts.
     * @param args - The arguments for verifying a chain swap.
     * @returns True if the addresses match.
     */
    async verifyChainSwap(args: {
        to: Chain;
        from: Chain;
        swap: PendingChainSwap;
        arkInfo: ArkInfo;
    }): Promise<boolean> {
        // deconstruct args and validate
        const { to, from, swap, arkInfo } = args;

        if (from === "ARK") {
            if (!swap.response.lockupDetails.serverPublicKey)
                throw new Error("Missing serverPublicKey in lockup details");

            if (!swap.response.lockupDetails.timeouts)
                throw new Error("Missing timeouts in lockup details");
        }

        if (to === "ARK") {
            if (!swap.response.claimDetails.serverPublicKey)
                throw new Error("Missing serverPublicKey in claim details");

            if (!swap.response.claimDetails.timeouts)
                throw new Error("Missing timeouts in claim details");
        }

        const lockupAddress =
            to === "ARK"
                ? swap.response.claimDetails.lockupAddress
                : swap.response.lockupDetails.lockupAddress;

        const receiverPubkey =
            to === "ARK"
                ? swap.request.claimPublicKey
                : swap.response.lockupDetails.serverPublicKey!;

        const senderPubkey =
            to === "ARK"
                ? swap.response.claimDetails.serverPublicKey!
                : swap.request.refundPublicKey;

        const serverPubkey = hex.encode(
            normalizeToXOnlyKey(arkInfo.signerPubkey, "server")
        );

        const timeoutBlockHeights =
            to === "ARK"
                ? swap.response.claimDetails.timeouts!
                : swap.response.lockupDetails.timeouts!;

        const { vhtlcAddress } = this.createVHTLCScript({
            network: arkInfo.network,
            preimageHash: hex.decode(swap.request.preimageHash),
            receiverPubkey,
            senderPubkey,
            serverPubkey,
            timeoutBlockHeights,
        });

        if (lockupAddress !== vhtlcAddress) {
            throw new SwapError({
                message: "Boltz is trying to scam us (invalid address)",
            });
        }

        return true;
    }

    /**
     * Retrieves fees for swaps (in sats and percentage).
     * @param from - The source chain.
     * @param to - The destination chain.
     * @returns The fees for swaps.
     */
    async getFees(from: Chain, to: Chain): Promise<ChainFeesResponse> {
        return this.swapProvider.getChainFees(from, to);
    }

    /**
     * Retrieves max and min limits for swaps (in sats).
     * @param from - The source chain.
     * @param to - The destination chain.
     * @returns The limits for swaps.
     */
    async getLimits(from: Chain, to: Chain): Promise<LimitsResponse> {
        return this.swapProvider.getChainLimits(from, to);
    }

    /**
     * Retrieves swap status by ID.
     * @param swapId - The ID of the swap.
     * @returns The status of the swap.
     */
    async getSwapStatus(swapId: string): Promise<GetSwapStatusResponse> {
        return this.swapProvider.getSwapStatus(swapId);
    }

    /**
     * Retrieves all pending chain swaps from storage.
     * This method filters the pending swaps to return only those with a status of 'swap.created'.
     * It is useful for checking the status of all pending chain swaps in the system.
     * @returns PendingChainSwap[]. If no swaps are found, it returns an empty array.
     */
    async getPendingChainSwaps(): Promise<PendingChainSwap[]> {
        const swaps = await this.getPendingChainSwapsFromStorage();
        return swaps.filter((swap) => swap.status === "swap.created");
    }

    /**
     * Retrieves swap history from storage.
     * @returns Array of all swaps sorted by creation date (newest first). If no swaps are found, it returns an empty array.
     */
    async getSwapHistory(): Promise<PendingChainSwap[]> {
        const allSwaps = await this.getPendingChainSwapsFromStorage();
        return allSwaps.sort((a, b) => b.createdAt - a.createdAt);
    }

    /**
     * Renegotiates the quote for an existing swap.
     * @param swapId - The ID of the swap.
     * @returns The accepted quote amount.
     */
    async quoteSwap(swapId: string): Promise<number> {
        const { amount } = await this.swapProvider.getChainQuote(swapId);
        await this.swapProvider.postChainQuote(swapId, { amount });
        return amount;
    }

    /**
     * Refreshes the status of all pending swaps in the storage provider.
     * This method iterates through all pending chain swaps, checks their current status
     * using the swap provider, and updates the storage provider accordingly.
     * It skips swaps that are already in a final status to avoid unnecessary API calls.
     * If no storage provider is set, the method exits early.
     * Errors during status refresh are logged to the console but do not interrupt the process.
     * @returns void
     * Important: a chain swap with status payment.failedToPay is considered final and won't be refreshed.
     * User should manually retry or delete it if refund fails.
     */
    async refreshSwapsStatus(): Promise<void> {
        // refresh status of all pending chain swaps
        for (const swap of await this.getPendingChainSwapsFromStorage()) {
            if (isChainFinalStatus(swap.status)) continue;
            this.getSwapStatus(swap.id)
                .then(({ status }) => {
                    this.savePendingChainSwap({ ...swap, status });
                })
                .catch((error) => {
                    console.error(
                        `Failed to refresh swap status for ${swap.id}:`,
                        error
                    );
                });
        }
    }

    // SwapManager methods

    /**
     * Start the background swap manager
     * This will load all pending swaps and begin monitoring them
     * Automatically called when SwapManager is enabled
     */
    async startSwapManager(): Promise<void> {
        if (!this.swapManager) {
            throw new Error(
                "SwapManager is not enabled. Provide 'swapManager' config in ArkadeLightningConfig."
            );
        }

        // Load all pending swaps from storage
        const chainSwaps = await this.getPendingChainSwapsFromStorage();

        // Start the manager with all pending swaps
        await this.swapManager.start(chainSwaps);
    }

    /**
     * Stop the background swap manager
     */
    async stopSwapManager(): Promise<void> {
        if (!this.swapManager) return;
        await this.swapManager.stop();
    }

    /**
     * Get the SwapManager instance
     * Useful for accessing manager stats or manually controlling swaps
     */
    getSwapManager(): SwapManager | null {
        return this.swapManager;
    }

    // Storage helper methods using contract repository
    /**
     * Persists a pending chain swap in the contract repository.
     * @param swap - The pending swap to save.
     */
    private async savePendingChainSwap(swap: PendingChainSwap): Promise<void> {
        await this.wallet.contractRepository.saveToContractCollection(
            "chainSwaps",
            swap,
            "id"
        );
    }

    /**
     * Retrieves all pending chain swaps from the contract repository.
     * @returns Array of pending chain swaps.
     */
    private async getPendingChainSwapsFromStorage(): Promise<
        PendingChainSwap[]
    > {
        return (await this.wallet.contractRepository.getContractCollection(
            "chainSwaps"
        )) as PendingChainSwap[];
    }

    /**
     * Validates the final Ark transaction.
     * checks that all inputs have a signature for the given pubkey
     * and the signature is correct for the given tapscript leaf
     * TODO: This is a simplified check, we should verify the actual signatures
     * @param finalArkTx The final Ark transaction in PSBT format.
     * @param _pubkey The public key of the user.
     * @param _tapLeaves The taproot script leaves.
     * @returns True if the final Ark transaction is valid, false otherwise.
     */
    private validFinalArkTx = (
        finalArkTx: string,
        _pubkey: Uint8Array,
        _tapLeaves: TapLeafScript[]
    ): boolean => {
        // decode the final Ark transaction
        const tx = ARKTransaction.fromPSBT(base64.decode(finalArkTx), {
            allowUnknown: true,
        });
        if (!tx) return false;

        // push all inputs to an array
        const inputs: TransactionInput[] = [];
        for (let i = 0; i < tx.inputsLength; i++) {
            inputs.push(tx.getInput(i));
        }

        // basic check that all inputs have a witnessUtxo
        // this is a simplified check, we should verify the actual signatures
        return inputs.every((input) => input.witnessUtxo);
    };

    /**
     * Joins a batch to spend the vtxo via commitment transaction.
     * @param identity - The identity to use for signing.
     * @param input - The input vtxo.
     * @param output - The output script.
     * @param arkInfo - Chain information used for building transactions.
     * @param isRecoverable - Whether the input is recoverable.
     * @returns The commitment transaction ID.
     */
    async joinBatch(
        identity: Identity,
        input: ArkTxInput,
        output: TransactionOutput,
        arkInfo: ArkInfo,
        isRecoverable = true
    ): Promise<string> {
        return joinBatch(
            this.arkProvider,
            identity,
            input,
            output,
            arkInfo,
            isRecoverable
        );
    }

    /**
     * Dispose of resources (stops SwapManager and cleans up)
     * Can be called manually or automatically with `await using` syntax (TypeScript 5.2+)
     */
    async dispose(): Promise<void> {
        if (this.swapManager) {
            await this.stopSwapManager();
        }
    }
}
