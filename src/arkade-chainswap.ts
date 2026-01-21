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
} from "@arkade-os/sdk";
import type {
    ArkadeLightningConfig,
    LimitsResponse,
    PendingChainSwap,
    ChainFeesResponse,
    Chain,
} from "./types";
import {
    BoltzSwapProvider,
    GetSwapStatusResponse,
    isChainFinalStatus,
    BoltzSwapStatus,
} from "./boltz-swap-provider";
import { base64, hex } from "@scure/base";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { TransactionInput } from "@scure/btc-signer/psbt.js";
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
import { normalizeToXOnlyPublicKey } from "./utils/signatures";

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

    constructor(config: ArkadeLightningConfig) {
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
    }

    async sendToBTC(args: {
        toAddress: string;
        amountSats: number;
        feeSatsPerByte?: number;
    }) {
        // deconstruct args and validate
        const feeSatsPerByte = args.feeSatsPerByte ?? 1;
        const { toAddress, amountSats } = args;
        if (!toAddress)
            throw new SwapError({
                message: "Invalid BTC address in sendToBTC",
            });
        if (amountSats <= 0)
            throw new SwapError({
                message: "Invalid amount in sendToBTC",
            });

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
        await this.waitAndClaim({
            arkInfo,
            pendingSwap,
            claimFunction: this.claimBTC.bind(this),
        });

        return pendingSwap;
    }

    async receiveFromBTC(args: {
        amountSats: number;
        feeSatsPerByte?: number;
        onAddressGenerated: (address: string) => void;
    }) {
        // deconstruct args and validate
        const feeSatsPerByte = args.feeSatsPerByte ?? 1;
        const { amountSats, onAddressGenerated } = args;
        if (amountSats <= 0)
            throw new SwapError({
                message: "Invalid amount in receiveFromBTC",
            });

        const arkInfo = await this.arkProvider.getInfo();

        // create chain swap
        const pendingSwap = await this.createChainSwap({
            to: "ARK",
            from: "BTC",
            feeSatsPerByte,
            userLockAmount: amountSats,
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
        await this.waitAndClaim({
            arkInfo,
            pendingSwap,
            claimFunction: this.claimARK.bind(this),
            beNiceFunction: this.signCooperativeClaimForServer.bind(this),
        });

        return pendingSwap;
    }

    /**
     * Waits for the swap to be confirmed and claims it.
     * @param arkInfo - The Ark information.
     * @param pendingSwap - The pending chain swap.
     * @param claimFunction - The function to claim the swap.
     * @param beNiceFunction - Optional function to be called in BTC => ARK transaction.claim.pending.
     * @returns The transaction ID of the claimed VHTLC.
     * @throws SwapExpiredError if the swap has expired.
     * @throws TransactionFailedError if the transaction has failed.
     * @throws TransactionRefundedError if the transaction has been refunded.
     * @throws Error if claim function fails.
     */
    async waitAndClaim(args: {
        arkInfo: ArkInfo;
        pendingSwap: PendingChainSwap;
        claimFunction: (args: {
            pendingSwap: PendingChainSwap;
            arkInfo: ArkInfo;
            data: any;
        }) => Promise<void>;
        beNiceFunction?: (args: {
            pendingSwap: PendingChainSwap;
        }) => Promise<void>;
    }): Promise<{ txid: string }> {
        const { arkInfo, pendingSwap, beNiceFunction, claimFunction } = args;

        return new Promise<{ txid: string }>((resolve, reject) => {
            // https://api.docs.boltz.exchange/lifecycle.html#swap-states
            const onStatusUpdate = async (
                status: BoltzSwapStatus,
                data: any
            ) => {
                switch (status) {
                    case "transaction.server.mempool":
                    case "transaction.server.confirmed":
                        await this.savePendingChainSwap({
                            ...pendingSwap,
                            status,
                        });
                        claimFunction({ pendingSwap, arkInfo, data }).catch(
                            reject
                        );
                        break;
                    case "transaction.claimed":
                        await this.savePendingChainSwap({
                            ...pendingSwap,
                            status,
                        });
                        resolve({ txid: pendingSwap.response.id });
                        break;
                    case "transaction.claim.pending":
                        // Be nice and sign a cooperative claim for the server
                        // Not required: you can treat this as success already,
                        // the server will batch sweep eventually
                        const { from, to } = pendingSwap.request;
                        if (beNiceFunction && from === "BTC" && to === "ARK") {
                            await beNiceFunction({ pendingSwap });
                        }
                        break;
                    case "swap.expired":
                        await this.savePendingChainSwap({
                            ...pendingSwap,
                            status,
                        });
                        reject(
                            new SwapExpiredError({
                                isRefundable: true,
                                pendingSwap,
                            })
                        );
                        break;
                    case "transaction.failed":
                        await this.savePendingChainSwap({
                            ...pendingSwap,
                            status,
                        });
                        reject(new TransactionFailedError());
                        break;
                    case "transaction.refunded":
                        await this.savePendingChainSwap({
                            ...pendingSwap,
                            status,
                        });
                        reject(new TransactionRefundedError());
                        break;
                    default:
                        await this.savePendingChainSwap({
                            ...pendingSwap,
                            status,
                        });
                        break;
                }
            };

            this.swapProvider.monitorSwap(pendingSwap.id, onStatusUpdate);
        });
    }

    /**
     * Claim sats on BTC chain by claiming the HTLC.
     * @param pendingSwap
     */
    async claimBTC(args: {
        pendingSwap: PendingChainSwap;
        arkInfo: ArkInfo;
        data: any;
    }): Promise<void> {
        const { pendingSwap, arkInfo, data } = args;

        if (!pendingSwap.toAddress)
            throw new Error("Destination address is required");

        const lockupTx = Transaction.fromRaw(hex.decode(data.transaction.hex));

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
                        // False to enforce script path
                        cooperative: true,
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

        console.log("Claim transaction:", claimTx.hex);

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

        console.log("Signed transaction:", signedTxData);

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

        const broadcastData = this.swapProvider.postBtcTransaction(claimTx.hex);
        console.log("Broadcast response:", broadcastData);
    }

    /**
     * Claim sats on ARK chain by claiming the VHTLC.
     * @param pendingSwap
     */
    async claimARK(args: {
        arkInfo: ArkInfo;
        pendingSwap: PendingChainSwap;
    }): Promise<void> {
        const { arkInfo, pendingSwap } = args;
        const preimage = hex.decode(pendingSwap.preimage);
        const address = await this.wallet.getAddress();
        const { request, response } = pendingSwap;

        // build expected VHTLC script
        const { vhtlcScript } = this.createVHTLCScript({
            network: arkInfo.network,
            preimageHash: sha256(preimage),
            receiverPubkey: request.claimPublicKey,
            senderPubkey: response.lockupDetails.serverPublicKey,
            serverPubkey: arkInfo.signerPubkey,
            timeoutBlockHeights: response.claimDetails.timeoutBlockHeights,
        });

        if (!vhtlcScript.claimScript)
            throw new Error("Failed to create VHTLC script for chain swap");

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
            xOnlyPublicKey: request.claimPublicKey,
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
     * @param pendingSwap
     */
    async signCooperativeClaimForServer(args: {
        pendingSwap: PendingChainSwap;
    }): Promise<void> {
        const { pendingSwap } = args;

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
     * it creates a VHTLC script that can be used to claim or refund the swap
     * it validates the receiver, sender and server public keys are x-only
     * it encodes the VHTLC address from the VHTLC script
     * @param param0 - The parameters for creating the VHTLC script.
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
        const receiverXOnlyPublicKey = normalizeToXOnlyPublicKey(
            hex.decode(receiverPubkey),
            "receiver"
        );

        // validate we are using a x-only sender public key
        const senderXOnlyPublicKey = normalizeToXOnlyPublicKey(
            hex.decode(senderPubkey),
            "sender"
        );

        // validate we are using a x-only server public key
        const serverXOnlyPublicKey = normalizeToXOnlyPublicKey(
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

    // TODO: implement proper HTLC script creation
    /**
     * Creates a HTLC script for the swap.
     * it creates a HTLC script that can be used to claim or refund the swap
     * it validates the receiver, sender and server public keys are x-only
     * it encodes the HTLC address from the HTLC script
     * @param param0 - The parameters for creating the HTLC script.
     * @returns The created HTLC script and address.
     */
    createHTLCScript({
        network,
        preimageHash,
        receiverPubkey,
        senderPubkey,
        serverPubkey,
        timeoutBlockHeights,
    }: {
        network: string;
        preimageHash: Uint8Array;
        receiverPubkey: string;
        senderPubkey: string;
        serverPubkey: string;
        timeoutBlockHeights: number;
    }): { htlcScript: string; htlcAddress: string } {
        // validate we are using a x-only receiver public key
        const receiverXOnlyPublicKey = normalizeToXOnlyPublicKey(
            hex.decode(receiverPubkey),
            "receiver"
        );

        // validate we are using a x-only sender public key
        const senderXOnlyPublicKey = normalizeToXOnlyPublicKey(
            hex.decode(senderPubkey),
            "sender"
        );

        // validate we are using a x-only server public key
        const serverXOnlyPublicKey = normalizeToXOnlyPublicKey(
            hex.decode(serverPubkey),
            "server"
        );

        console.log({
            refundLocktime: BigInt(timeoutBlockHeights),
            preimageHash: ripemd160(preimageHash),
            receiver: receiverXOnlyPublicKey,
            sender: senderXOnlyPublicKey,
            server: serverXOnlyPublicKey,
            network,
        });

        return { htlcScript: "", htlcAddress: "" };
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
            from === "ARK"
                ? hex.encode(await this.wallet.identity.compressedPublicKey())
                : hex.encode(secp256k1.getPublicKey(ephemeralKey));

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
     * Validates the lockup and claim addresses match the expected scripts
     * @param args - The arguments for creating a chain swap.
     * @returns The created pending chain swap.
     */
    async verifyChainSwap(args: {
        to: Chain;
        from: Chain;
        swap: PendingChainSwap;
        arkInfo: ArkInfo;
    }): Promise<boolean> {
        // deconstruct args and validate
        const { to, from, swap, arkInfo } = args;

        // create vhtlc script
        const { vhtlcAddress } = this.createVHTLCScript({
            network: to === "BTC" ? arkInfo.network : "bitcoin",
            preimageHash: hex.decode(swap.request.preimageHash),
            receiverPubkey: swap.request.claimPublicKey,
            senderPubkey: swap.response.lockupDetails.serverPublicKey,
            serverPubkey: arkInfo.signerPubkey,
            timeoutBlockHeights:
                swap.response.lockupDetails.timeoutBlockHeights,
        });

        // create htlc script
        const { htlcAddress } = this.createHTLCScript({
            network: to === "BTC" ? arkInfo.network : "bitcoin",
            preimageHash: hex.decode(swap.request.preimageHash),
            receiverPubkey: swap.request.claimPublicKey,
            senderPubkey: swap.response.lockupDetails.serverPublicKey,
            serverPubkey: arkInfo.signerPubkey,
            timeoutBlockHeights: 21, // TODO
        });

        // validate lockup address matches expected script
        const expectectLockupAddress =
            from === "ARK" ? vhtlcAddress : htlcAddress;
        if (
            expectectLockupAddress !== swap.response.lockupDetails.lockupAddress
        )
            throw new SwapError({
                message: "Boltz is trying to scam us (invalid lockup address)",
            });

        // validate claim address matches expected script
        const expectectClaimAddress = to === "ARK" ? vhtlcAddress : htlcAddress;
        if (expectectClaimAddress !== swap.response.claimDetails.lockupAddress)
            throw new SwapError({
                message: "Boltz is trying to scam us (invalid claim address)",
            });

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
     * Retrieves all pending reverse swaps from storage.
     * This method filters the pending swaps to return only those with a status of 'swap.created'.
     * It is useful for checking the status of all pending reverse swaps in the system.
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
    async refreshSwapsStatus() {
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

    // Storage helper methods using contract repository
    private async savePendingChainSwap(swap: PendingChainSwap): Promise<void> {
        await this.wallet.contractRepository.saveToContractCollection(
            "chainSwaps",
            swap,
            "id"
        );
    }

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
}
