import {
    InvoiceExpiredError,
    InvoiceFailedToPayError,
    SwapError,
    SwapExpiredError,
    TransactionFailedError,
    TransactionLockupFailedError,
    TransactionRefundedError,
} from "./errors";
import {
    ArkAddress,
    ArkProvider,
    IndexerProvider,
    buildOffchainTx,
    ConditionWitness,
    CSVMultisigTapscript,
    setArkPsbtField,
    TapLeafScript,
    Wallet,
    VHTLC,
    ServiceWorkerWallet,
    verifyTapscriptSignatures,
    combineTapscriptSigs,
} from "@arkade-os/sdk";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64, hex } from "@scure/base";
import type {
    ArkadeLightningConfig,
    CreateLightningInvoiceResponse,
    SendLightningPaymentRequest,
    SendLightningPaymentResponse,
    PendingReverseSwap,
    PendingSubmarineSwap,
    CreateLightningInvoiceRequest,
    LimitsResponse,
    FeesResponse,
} from "./types";
import { randomBytes } from "@noble/hashes/utils.js";
import {
    BoltzSwapStatus,
    BoltzSwapProvider,
    CreateSubmarineSwapRequest,
    CreateReverseSwapRequest,
    GetSwapStatusResponse,
    isSubmarineFinalStatus,
    isReverseFinalStatus,
} from "./boltz-swap-provider";
import { Transaction } from "@scure/btc-signer";
import { TransactionInput } from "@scure/btc-signer/psbt.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { decodeInvoice, getInvoicePaymentHash } from "./utils/decoding";

function getSignerSession(wallet: Wallet | ServiceWorkerWallet): any {
    const signerSession = wallet.identity.signerSession;

    // If signerSession is a function (factory), call it to get the actual session
    if (typeof signerSession === "function") {
        return signerSession();
    }

    // Otherwise return it directly (could be the session object or undefined)
    return signerSession;
}

async function signTransaction(
    wallet: Wallet | ServiceWorkerWallet,
    tx: Transaction,
    inputIndexes?: number[]
): Promise<Transaction> {
    return wallet.identity.sign(tx, inputIndexes);
}

export class ArkadeLightning {
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

    // Storage helper methods using contract repository
    private async savePendingReverseSwap(
        swap: PendingReverseSwap
    ): Promise<void> {
        await this.wallet.contractRepository.saveToContractCollection(
            "reverseSwaps",
            swap,
            "id"
        );
    }

    private async savePendingSubmarineSwap(
        swap: PendingSubmarineSwap
    ): Promise<void> {
        await this.wallet.contractRepository.saveToContractCollection(
            "submarineSwaps",
            swap,
            "id"
        );
    }

    private async getPendingReverseSwapsFromStorage(): Promise<
        PendingReverseSwap[]
    > {
        return (await this.wallet.contractRepository.getContractCollection(
            "reverseSwaps"
        )) as PendingReverseSwap[];
    }

    private async getPendingSubmarineSwapsFromStorage(): Promise<
        PendingSubmarineSwap[]
    > {
        return (await this.wallet.contractRepository.getContractCollection(
            "submarineSwaps"
        )) as PendingSubmarineSwap[];
    }

    // receive from lightning = reverse submarine swap
    //
    // 1. create invoice by creating a reverse swap
    // 2. monitor incoming payment by waiting for the hold invoice to be paid
    // 3. claim the VHTLC by creating a virtual transaction that spends the VHTLC output
    // 4. return the preimage and the swap info

    /**
     * Creates a Lightning invoice.
     * @param args - The arguments for creating a Lightning invoice.
     * @returns The response containing the created Lightning invoice.
     */
    async createLightningInvoice(
        args: CreateLightningInvoiceRequest
    ): Promise<CreateLightningInvoiceResponse> {
        return new Promise((resolve, reject) => {
            this.createReverseSwap(args)
                .then((pendingSwap) => {
                    const decodedInvoice = decodeInvoice(
                        pendingSwap.response.invoice
                    );
                    //
                    resolve({
                        amount: pendingSwap.response.onchainAmount,
                        expiry: decodedInvoice.expiry,
                        invoice: pendingSwap.response.invoice,
                        paymentHash: decodedInvoice.paymentHash,
                        pendingSwap,
                        preimage: pendingSwap.preimage,
                    } as CreateLightningInvoiceResponse);
                })
                .catch(reject);
        });
    }

    /**
     * Sends a Lightning payment.
     * 1. decode the invoice to get the amount and destination
     * 2. create submarine swap with the decoded invoice
     * 3. send the swap address and expected amount to the wallet to create a transaction
     * 4. wait for the swap settlement and return the preimage and txid
     * @param args - The arguments for sending a Lightning payment.
     * @returns The result of the payment.
     */
    async sendLightningPayment(
        args: SendLightningPaymentRequest
    ): Promise<SendLightningPaymentResponse> {
        const pendingSwap = await this.createSubmarineSwap(args);

        // save pending swap to storage
        await this.savePendingSubmarineSwap(pendingSwap);

        // send funds to the swap address
        const txid = await this.wallet.sendBitcoin({
            address: pendingSwap.response.address,
            amount: pendingSwap.response.expectedAmount,
        });

        try {
            const { preimage } = await this.waitForSwapSettlement(pendingSwap);
            return {
                amount: pendingSwap.response.expectedAmount,
                preimage,
                txid,
            };
        } catch (error: any) {
            if (error.isRefundable) {
                await this.refundVHTLC(pendingSwap);
                const finalStatus = await this.getSwapStatus(pendingSwap.id);
                await this.savePendingSubmarineSwap({
                    ...pendingSwap,
                    status: finalStatus.status,
                });
            }
            throw new TransactionFailedError();
        }
    }

    /**
     * Creates a submarine swap.
     * @param args - The arguments for creating a submarine swap.
     * @returns The created pending submarine swap.
     */
    async createSubmarineSwap(
        args: SendLightningPaymentRequest
    ): Promise<PendingSubmarineSwap> {
        const refundPublicKey = hex.encode(
            await this.wallet.identity.compressedPublicKey()
        );
        if (!refundPublicKey)
            throw new SwapError({
                message: "Failed to get refund public key from wallet",
            });

        const invoice = args.invoice;
        if (!invoice) throw new SwapError({ message: "Invoice is required" });

        const swapRequest: CreateSubmarineSwapRequest = {
            invoice,
            refundPublicKey,
        };

        // make submarine swap request
        const swapResponse =
            await this.swapProvider.createSubmarineSwap(swapRequest);

        // create pending swap object
        const pendingSwap: PendingSubmarineSwap = {
            id: swapResponse.id,
            type: "submarine",
            createdAt: Math.floor(Date.now() / 1000),
            request: swapRequest,
            response: swapResponse,
            status: "invoice.set",
        };

        // save pending swap to storage if available
        await this.savePendingSubmarineSwap(pendingSwap);

        return pendingSwap;
    }

    /**
     * Creates a reverse swap.
     * @param args - The arguments for creating a reverse swap.
     * @returns The created pending reverse swap.
     */
    async createReverseSwap(
        args: CreateLightningInvoiceRequest
    ): Promise<PendingReverseSwap> {
        // validate amount
        if (args.amount <= 0)
            throw new SwapError({ message: "Amount must be greater than 0" });

        const claimPublicKey = hex.encode(
            await this.wallet.identity.compressedPublicKey()
        );
        if (!claimPublicKey)
            throw new SwapError({
                message: "Failed to get claim public key from wallet",
            });

        // create random preimage and its hash
        const preimage = randomBytes(32);
        const preimageHash = hex.encode(sha256(preimage));
        if (!preimageHash)
            throw new SwapError({ message: "Failed to get preimage hash" });

        // build request object for reverse swap
        const swapRequest: CreateReverseSwapRequest = {
            invoiceAmount: args.amount,
            claimPublicKey,
            preimageHash,
            ...(args.description?.trim()
                ? { description: args.description.trim() }
                : {}),
        };

        // make reverse swap request
        const swapResponse =
            await this.swapProvider.createReverseSwap(swapRequest);

        const pendingSwap: PendingReverseSwap = {
            id: swapResponse.id,
            type: "reverse",
            createdAt: Math.floor(Date.now() / 1000),
            preimage: hex.encode(preimage),
            request: swapRequest,
            response: swapResponse,
            status: "swap.created",
        };

        // save pending swap to storage if available
        await this.savePendingReverseSwap(pendingSwap);

        return pendingSwap;
    }

    /**
     * Claims the VHTLC for a pending reverse swap.
     * @param pendingSwap - The pending reverse swap to claim the VHTLC.
     */
    async claimVHTLC(pendingSwap: PendingReverseSwap): Promise<void> {
        const preimage = hex.decode(pendingSwap.preimage);
        const aspInfo = await this.arkProvider.getInfo();
        const address = await this.wallet.getAddress();

        // validate we are using a x-only receiver public key
        const ourXOnlyPublicKey = this.normalizeToXOnlyPublicKey(
            await this.wallet.identity.xOnlyPublicKey(),
            "our",
            pendingSwap.id
        );

        // validate we are using a x-only boltz public key
        const boltzXOnlyPublicKey = this.normalizeToXOnlyPublicKey(
            hex.decode(pendingSwap.response.refundPublicKey),
            "boltz",
            pendingSwap.id
        );

        // validate we are using a x-only server public key
        const serverXOnlyPublicKey = this.normalizeToXOnlyPublicKey(
            hex.decode(aspInfo.signerPubkey),
            "server",
            pendingSwap.id
        );

        // build expected VHTLC script
        const { vhtlcScript, vhtlcAddress } = this.createVHTLCScript({
            network: aspInfo.network,
            preimageHash: sha256(preimage),
            receiverPubkey: hex.encode(ourXOnlyPublicKey),
            senderPubkey: hex.encode(boltzXOnlyPublicKey),
            serverPubkey: hex.encode(serverXOnlyPublicKey),
            timeoutBlockHeights: pendingSwap.response.timeoutBlockHeights,
        });

        if (!vhtlcScript)
            throw new Error("Failed to create VHTLC script for reverse swap");
        if (vhtlcAddress !== pendingSwap.response.lockupAddress)
            throw new Error("Boltz is trying to scam us");

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
                let signedTx = await signTransaction(
                    this.wallet,
                    cpy,
                    inputIndexes
                );
                signedTx = Transaction.fromPSBT(signedTx.toPSBT(), {
                    allowUnknown: true,
                });
                setArkPsbtField(signedTx, 0, ConditionWitness, [preimage]);
                return signedTx;
            },
            xOnlyPublicKey: ourXOnlyPublicKey,
            signerSession: getSignerSession(this.wallet),
        };

        // create the server unroll script for checkpoint transactions
        const rawCheckpointTapscript = hex.decode(aspInfo.checkpointTapscript);
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
                serverXOnlyPublicKey,
                vhtlcScript.leaves
            )
        ) {
            throw new Error("Invalid final Ark transaction");
        }

        // sign the checkpoint transactions pre signed by the server
        const finalCheckpoints = await Promise.all(
            signedCheckpointTxs.map(async (c) => {
                const tx = Transaction.fromPSBT(base64.decode(c), {
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
        await this.savePendingReverseSwap({
            ...pendingSwap,
            status: finalStatus.status,
        });
    }

    /**
     * Claims the VHTLC for a pending submarine swap (aka refund).
     * @param pendingSwap - The pending submarine swap to refund the VHTLC.
     */
    async refundVHTLC(pendingSwap: PendingSubmarineSwap): Promise<void> {
        // prepare variables for claiming the VHTLC
        const aspInfo = await this.arkProvider.getInfo();
        const address = await this.wallet.getAddress();
        if (!address) throw new Error("Failed to get ark address from wallet");

        // validate we are using a x-only public key
        const ourXOnlyPublicKey = this.normalizeToXOnlyPublicKey(
            await this.wallet.identity.xOnlyPublicKey(),
            "our",
            pendingSwap.id
        );

        // validate we are using a x-only server public key
        const serverXOnlyPublicKey = this.normalizeToXOnlyPublicKey(
            hex.decode(aspInfo.signerPubkey),
            "server",
            pendingSwap.id
        );

        // validate we are using a x-only boltz public key
        const boltzXOnlyPublicKey = this.normalizeToXOnlyPublicKey(
            hex.decode(pendingSwap.response.claimPublicKey),
            "boltz",
            pendingSwap.id
        );

        const { vhtlcScript, vhtlcAddress } = this.createVHTLCScript({
            network: aspInfo.network,
            preimageHash: hex.decode(
                getInvoicePaymentHash(pendingSwap.request.invoice)
            ),
            receiverPubkey: hex.encode(boltzXOnlyPublicKey),
            senderPubkey: hex.encode(ourXOnlyPublicKey),
            serverPubkey: hex.encode(serverXOnlyPublicKey),
            timeoutBlockHeights: pendingSwap.response.timeoutBlockHeights,
        });

        if (!vhtlcScript)
            throw new Error("Failed to create VHTLC script for reverse swap");
        if (vhtlcAddress !== pendingSwap.response.address)
            throw new Error("Boltz is trying to scam us");

        // get spendable VTXOs from the lockup address
        const spendableVtxos = await this.indexerProvider.getVtxos({
            scripts: [hex.encode(vhtlcScript.pkScript)],
            spendableOnly: true,
        });
        if (spendableVtxos.vtxos.length === 0) {
            throw new Error("No spendable virtual coins found");
        }

        // signing a VTHLC needs an extra witness element to be added to the PSBT input
        // reveal the secret in the PSBT, thus the server can verify the claim script
        // this witness must satisfy the preimageHash condition
        const vhtlcIdentity = {
            sign: async (tx: any, inputIndexes?: number[]) => {
                const cpy = tx.clone();
                let signedTx = await signTransaction(
                    this.wallet,
                    cpy,
                    inputIndexes
                );
                return Transaction.fromPSBT(signedTx.toPSBT(), {
                    allowUnknown: true,
                });
            },
            xOnlyPublicKey: ourXOnlyPublicKey,
            signerSession: getSignerSession(this.wallet),
        };

        // create the server unroll script for checkpoint transactions
        const rawCheckpointTapscript = hex.decode(aspInfo.checkpointTapscript);
        const serverUnrollScript = CSVMultisigTapscript.decode(
            rawCheckpointTapscript
        );

        // create the virtual transaction to claim the VHTLC
        const { arkTx: unsignedRefundTx, checkpoints: checkpointPtxs } =
            buildOffchainTx(
                [
                    {
                        ...spendableVtxos.vtxos[0],
                        tapLeafScript: vhtlcScript.refund(),
                        tapTree: vhtlcScript.encode(),
                    },
                ],
                [
                    {
                        amount: BigInt(spendableVtxos.vtxos[0].value),
                        script: ArkAddress.decode(address).pkScript,
                    },
                ],
                serverUnrollScript
            );

        // validate we have one checkpoint transaction
        if (checkpointPtxs.length !== 1)
            throw new Error(
                `Expected one checkpoint transaction, got ${checkpointPtxs.length}`
            );

        const unsignedCheckpointTx = checkpointPtxs[0];

        // get Boltz to sign its part
        const {
            transaction: boltzSignedRefundTx,
            checkpoint: boltzSignedCheckpointTx,
        } = await this.swapProvider.refundSubmarineSwap(
            pendingSwap.id,
            unsignedRefundTx,
            unsignedCheckpointTx
        );

        // Verify Boltz signatures before combining
        const boltzXOnlyPublicKeyHex = hex.encode(boltzXOnlyPublicKey);
        if (
            !this.verifySignatures(boltzSignedRefundTx, 0, [
                boltzXOnlyPublicKeyHex,
            ])
        ) {
            throw new Error("Invalid Boltz signature in refund transaction");
        }
        if (
            !this.verifySignatures(boltzSignedCheckpointTx, 0, [
                boltzXOnlyPublicKeyHex,
            ])
        ) {
            throw new Error(
                "Invalid Boltz signature in checkpoint transaction"
            );
        }

        // sign our part
        const signedRefundTx = await vhtlcIdentity.sign(unsignedRefundTx);
        const signedCheckpointTx =
            await vhtlcIdentity.sign(unsignedCheckpointTx);

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
            await this.arkProvider.submitTx(
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

        if (!this.verifySignatures(tx, inputIndex, requiredSigners)) {
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
        await this.arkProvider.finalizeTx(arkTxid, [
            base64.encode(finalCheckpointTx.toPSBT()),
        ]);

        // update the pending swap on storage if available
        await this.savePendingSubmarineSwap({
            ...pendingSwap,
            refundable: true,
            refunded: true,
        });
    }

    /**
     * Waits for the swap to be confirmed and claims the VHTLC.
     * @param pendingSwap - The pending reverse swap.
     * @returns The transaction ID of the claimed VHTLC.
     */
    async waitAndClaim(
        pendingSwap: PendingReverseSwap
    ): Promise<{ txid: string }> {
        return new Promise<{ txid: string }>((resolve, reject) => {
            // https://api.docs.boltz.exchange/lifecycle.html#swap-states
            const onStatusUpdate = async (status: BoltzSwapStatus) => {
                switch (status) {
                    case "transaction.mempool":
                    case "transaction.confirmed":
                        await this.savePendingReverseSwap({
                            ...pendingSwap,
                            status,
                        });
                        this.claimVHTLC(pendingSwap).catch(reject);
                        break;
                    case "invoice.settled": {
                        await this.savePendingReverseSwap({
                            ...pendingSwap,
                            status,
                        });
                        const swapStatus =
                            await this.swapProvider.getReverseSwapTxId(
                                pendingSwap.id
                            );
                        const txid = swapStatus.id;

                        if (!txid || txid.trim() === "") {
                            reject(
                                new SwapError({
                                    message: `Transaction ID not available for settled swap ${pendingSwap.id}.`,
                                })
                            );
                            break;
                        }

                        resolve({ txid });
                        break;
                    }
                    case "invoice.expired":
                        await this.savePendingReverseSwap({
                            ...pendingSwap,
                            status,
                        });
                        reject(
                            new InvoiceExpiredError({
                                isRefundable: true,
                                pendingSwap,
                            })
                        );
                        break;
                    case "swap.expired":
                        await this.savePendingReverseSwap({
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
                        await this.savePendingReverseSwap({
                            ...pendingSwap,
                            status,
                        });
                        reject(new TransactionFailedError());
                        break;
                    case "transaction.refunded":
                        await this.savePendingReverseSwap({
                            ...pendingSwap,
                            status,
                        });
                        reject(new TransactionRefundedError());
                        break;
                    default:
                        await this.savePendingReverseSwap({
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
     * Waits for the swap settlement.
     * @param pendingSwap - The pending submarine swap.
     * @returns The status of the swap settlement.
     */
    async waitForSwapSettlement(
        pendingSwap: PendingSubmarineSwap
    ): Promise<{ preimage: string }> {
        return new Promise<{ preimage: string }>((resolve, reject) => {
            let isResolved = false;

            // https://api.docs.boltz.exchange/lifecycle.html#swap-states
            const onStatusUpdate = async (status: BoltzSwapStatus) => {
                if (isResolved) return; // Prevent multiple resolutions

                switch (status) {
                    case "swap.expired":
                        isResolved = true;
                        await this.savePendingSubmarineSwap({
                            ...pendingSwap,
                            refundable: true,
                            status,
                        });
                        reject(
                            new SwapExpiredError({
                                isRefundable: true,
                                pendingSwap,
                            })
                        );
                        break;
                    case "invoice.failedToPay":
                        isResolved = true;
                        await this.savePendingSubmarineSwap({
                            ...pendingSwap,
                            refundable: true,
                            status,
                        });
                        reject(
                            new InvoiceFailedToPayError({
                                isRefundable: true,
                                pendingSwap,
                            })
                        );
                        break;
                    case "transaction.lockupFailed":
                        isResolved = true;
                        await this.savePendingSubmarineSwap({
                            ...pendingSwap,
                            refundable: true,
                            status,
                        });
                        reject(
                            new TransactionLockupFailedError({
                                isRefundable: true,
                                pendingSwap,
                            })
                        );
                        break;
                    case "transaction.claimed": {
                        isResolved = true;
                        const { preimage } =
                            await this.swapProvider.getSwapPreimage(
                                pendingSwap.id
                            );
                        await this.savePendingSubmarineSwap({
                            ...pendingSwap,
                            preimage,
                            status,
                        });
                        resolve({ preimage });
                        break;
                    }
                    default:
                        await this.savePendingSubmarineSwap({
                            ...pendingSwap,
                            status,
                        });
                        break;
                }
            };

            // Start monitoring - the WebSocket will auto-close on terminal states
            this.swapProvider
                .monitorSwap(pendingSwap.id, onStatusUpdate)
                .catch((error) => {
                    if (!isResolved) {
                        isResolved = true;
                        reject(error);
                    }
                });
        });
    }

    // validators

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
        const tx = Transaction.fromPSBT(base64.decode(finalArkTx), {
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

    private verifySignatures = (
        tx: Transaction,
        inputIndex: number,
        requiredSigners: string[]
    ): boolean => {
        try {
            verifyTapscriptSignatures(tx, inputIndex, requiredSigners);
            return true;
        } catch (_) {
            return false;
        }
    };

    /**
     * Creates a VHTLC script for the swap.
     * works for submarine swaps and reverse swaps
     * it creates a VHTLC script that can be used to claim or refund the swap
     * it validates the receiver, sender and server public keys are x-only
     * it validates the VHTLC script matches the expected lockup address
     * @param param0 - The parameters for creating the VHTLC script.
     * @returns The created VHTLC script.
     */
    createVHTLCScript({
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
        timeoutBlockHeights: {
            refund: number;
            unilateralClaim: number;
            unilateralRefund: number;
            unilateralRefundWithoutReceiver: number;
        };
    }): { vhtlcScript: VHTLC.Script; vhtlcAddress: string } {
        // validate we are using a x-only receiver public key
        const receiverXOnlyPublicKey = this.normalizeToXOnlyPublicKey(
            hex.decode(receiverPubkey),
            "receiver"
        );

        // validate we are using a x-only sender public key
        const senderXOnlyPublicKey = this.normalizeToXOnlyPublicKey(
            hex.decode(senderPubkey),
            "sender"
        );

        // validate we are using a x-only server public key
        const serverXOnlyPublicKey = this.normalizeToXOnlyPublicKey(
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

        if (!vhtlcScript) throw new Error("Failed to create VHTLC script");

        // validate vhtlc script
        const hrp = network === "bitcoin" ? "ark" : "tark";
        const vhtlcAddress = vhtlcScript
            .address(hrp, serverXOnlyPublicKey)
            .encode();

        return { vhtlcScript, vhtlcAddress };
    }

    /**
     * Retrieves fees for swaps (in sats and percentage).
     * @returns The fees for swaps.
     */
    async getFees(): Promise<FeesResponse> {
        return this.swapProvider.getFees();
    }

    /**
     * Retrieves max and min limits for swaps (in sats).
     * @returns The limits for swaps.
     */
    async getLimits(): Promise<LimitsResponse> {
        return this.swapProvider.getLimits();
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
     * Retrieves all pending submarine swaps from storage.
     * This method filters the pending swaps to return only those with a status of 'invoice.set'.
     * It is useful for checking the status of all pending submarine swaps in the system.
     * @returns PendingSubmarineSwap[]. If no swaps are found, it returns an empty array.
     */
    async getPendingSubmarineSwaps(): Promise<PendingSubmarineSwap[]> {
        const swaps = await this.getPendingSubmarineSwapsFromStorage();
        if (!swaps) return [];
        return swaps.filter(
            (swap: PendingSubmarineSwap) => swap.status === "invoice.set"
        );
    }

    /**
     * Retrieves all pending reverse swaps from storage.
     * This method filters the pending swaps to return only those with a status of 'swap.created'.
     * It is useful for checking the status of all pending reverse swaps in the system.
     * @returns PendingReverseSwap[]. If no swaps are found, it returns an empty array.
     */
    async getPendingReverseSwaps(): Promise<PendingReverseSwap[]> {
        const swaps = await this.getPendingReverseSwapsFromStorage();
        if (!swaps) return [];
        return swaps.filter(
            (swap: PendingReverseSwap) => swap.status === "swap.created"
        );
    }

    /**
     * Retrieves swap history from storage.
     * @returns Array of all swaps sorted by creation date (newest first). If no swaps are found, it returns an empty array.
     */
    async getSwapHistory(): Promise<
        (PendingReverseSwap | PendingSubmarineSwap)[]
    > {
        const reverseSwaps = await this.getPendingReverseSwapsFromStorage();
        const submarineSwaps = await this.getPendingSubmarineSwapsFromStorage();
        const allSwaps = [...(reverseSwaps || []), ...(submarineSwaps || [])];
        return allSwaps.sort(
            (
                a: PendingReverseSwap | PendingSubmarineSwap,
                b: PendingReverseSwap | PendingSubmarineSwap
            ) => b.createdAt - a.createdAt
        );
    }

    /**
     * Refreshes the status of all pending swaps in the storage provider.
     * This method iterates through all pending reverse and submarine swaps,
     * checks their current status using the swap provider, and updates the storage provider accordingly.
     * It skips swaps that are already in a final status to avoid unnecessary API calls.
     * If no storage provider is set, the method exits early.
     * Errors during status refresh are logged to the console but do not interrupt the process.
     * @returns void
     * Important: a submarine swap with status payment.failedToPay is considered final and won't be refreshed.
     * User should manually retry or delete it if refund fails.
     */
    async refreshSwapsStatus() {
        // refresh status of all pending reverse swaps
        for (const swap of await this.getPendingReverseSwapsFromStorage()) {
            if (isReverseFinalStatus(swap.status)) continue;
            this.getSwapStatus(swap.id)
                .then(({ status }) => {
                    this.savePendingReverseSwap({ ...swap, status });
                })
                .catch((error) => {
                    console.error(
                        `Failed to refresh swap status for ${swap.id}:`,
                        error
                    );
                });
        }
        for (const swap of await this.getPendingSubmarineSwapsFromStorage()) {
            if (isSubmarineFinalStatus(swap.status)) continue;
            this.getSwapStatus(swap.id)
                .then(({ status }) => {
                    this.savePendingSubmarineSwap({ ...swap, status });
                })
                .catch((error) => {
                    console.error(
                        `Failed to refresh swap status for ${swap.id}:`,
                        error
                    );
                });
        }
    }

    /**
     * Validate we are using a x-only public key
     * @param publicKey
     * @param keyName
     * @param swapId
     * @returns Uint8Array
     */
    private normalizeToXOnlyPublicKey(
        publicKey: Uint8Array,
        keyName: string,
        swapId?: string
    ): Uint8Array {
        if (publicKey.length === 33) {
            return publicKey.slice(1);
        } else if (publicKey.length !== 32) {
            throw new Error(
                `Invalid ${keyName} public key length: ${publicKey.length} ${swapId ? "for swap " + swapId : ""}`
            );
        }
        return publicKey;
    }
}
