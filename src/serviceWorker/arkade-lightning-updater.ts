import { IUpdater } from "@arkade-os/sdk";

export const  DEFAULT_MESSAGE_TAG = "ARKADE_LIGHTNING_UPDATER"

export type ArkadeLightningUpdaterRequest = {};
export type ArkadeLightningUpdaterResponse = {};

export class ArkadeLightningUpdater
    implements IUpdater<ArkadeLightningUpdaterRequest,ArkadeLightningUpdaterResponse> {
    static messageTag = "arkade-lightning-updater";
    readonly messageTag = ArkadeLightningUpdater.messageTag;

    constructor() {
        // TODO:    wallet is WalletUpdater
        //          sendBitcoin()
        //          compressedPublicKey
        //          getAddress()
        //          xOnlyPubkey()
        //          sign()
        //          signerSession()

    }

    async update(): Promise<ArkadeLightningUpdaterResponse> {
        return {};
    }
}

export default ArkadeLightningUpdater;