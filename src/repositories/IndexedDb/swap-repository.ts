import { SwapRepository } from "../swap-repository";
import { closeDatabase, openDatabase } from "@arkade-os/sdk";
import { PendingReverseSwap, PendingSubmarineSwap } from "../../types";

const DEFAULT_DB_NAME = "arkade-boltz-swap";
const STORE_REVERSE_SWAPS_STATE = "reverseSwaps";
const STORE_SUBMARINE_SWAPS_STATE = "submarineSwaps";

function initDatabase(db: IDBDatabase) {
    if (!db.objectStoreNames.contains(STORE_REVERSE_SWAPS_STATE)) {
        db.createObjectStore(STORE_REVERSE_SWAPS_STATE, {
            keyPath: "id",
        });
    }
    if (!db.objectStoreNames.contains(STORE_SUBMARINE_SWAPS_STATE)) {
        db.createObjectStore(STORE_SUBMARINE_SWAPS_STATE, {
            keyPath: "id",
        });
    }
}

export class IndexedDbSwapRepository implements SwapRepository {
    private db: IDBDatabase | null = null;

    constructor(private readonly dbName: string = DEFAULT_DB_NAME) {}

    private async getDB(): Promise<IDBDatabase> {
        if (this.db) return this.db;
        this.db = await openDatabase(this.dbName, 1, initDatabase);
        return this.db;
    }

    async saveReverseSwap(swap: PendingReverseSwap): Promise<void> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(
                [STORE_REVERSE_SWAPS_STATE],
                "readwrite"
            );
            const store = transaction.objectStore(STORE_REVERSE_SWAPS_STATE);
            const request = store.put(swap);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async saveSubmarineSwap(swap: PendingSubmarineSwap): Promise<void> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(
                [STORE_SUBMARINE_SWAPS_STATE],
                "readwrite"
            );
            const store = transaction.objectStore(STORE_SUBMARINE_SWAPS_STATE);
            const request = store.put(swap);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async deleteReverseSwap(id: string): Promise<void> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(
                [STORE_REVERSE_SWAPS_STATE],
                "readwrite"
            );
            const store = transaction.objectStore(STORE_REVERSE_SWAPS_STATE);
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async deleteSubmarineSwap(id: string): Promise<void> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(
                [STORE_SUBMARINE_SWAPS_STATE],
                "readwrite"
            );
            const store = transaction.objectStore(STORE_SUBMARINE_SWAPS_STATE);
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getReverseSwap(id: string): Promise<PendingReverseSwap | undefined> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(
                [STORE_REVERSE_SWAPS_STATE],
                "readonly"
            );
            const store = transaction.objectStore(STORE_REVERSE_SWAPS_STATE);
            const request = store.get(id);
            request.onsuccess = () =>
                resolve(request.result as PendingReverseSwap | undefined);
            request.onerror = () => reject(request.error);
        });
    }

    async getSubmarineSwap(
        id: string
    ): Promise<PendingSubmarineSwap | undefined> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(
                [STORE_SUBMARINE_SWAPS_STATE],
                "readonly"
            );
            const store = transaction.objectStore(STORE_SUBMARINE_SWAPS_STATE);
            const request = store.get(id);
            request.onsuccess = () =>
                resolve(request.result as PendingSubmarineSwap | undefined);
            request.onerror = () => reject(request.error);
        });
    }

    async getAllReverseSwaps(): Promise<PendingReverseSwap[]> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(
                [STORE_REVERSE_SWAPS_STATE],
                "readonly"
            );
            const store = transaction.objectStore(STORE_REVERSE_SWAPS_STATE);
            const request = store.getAll();
            request.onsuccess = () =>
                resolve((request.result ?? []) as PendingReverseSwap[]);
            request.onerror = () => reject(request.error);
        });
    }

    async getAllSubmarineSwaps(): Promise<PendingSubmarineSwap[]> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(
                [STORE_SUBMARINE_SWAPS_STATE],
                "readonly"
            );
            const store = transaction.objectStore(STORE_SUBMARINE_SWAPS_STATE);
            const request = store.getAll();
            request.onsuccess = () =>
                resolve((request.result ?? []) as PendingSubmarineSwap[]);
            request.onerror = () => reject(request.error);
        });
    }

    async clear(): Promise<void> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(
                [STORE_REVERSE_SWAPS_STATE, STORE_SUBMARINE_SWAPS_STATE],
                "readwrite"
            );
            const reverseStore = transaction.objectStore(
                STORE_REVERSE_SWAPS_STATE
            );
            const submarineStore = transaction.objectStore(
                STORE_SUBMARINE_SWAPS_STATE
            );

            const reverseRequest = reverseStore.clear();
            const submarineRequest = submarineStore.clear();

            let completed = 0;
            const checkComplete = () => {
                completed++;
                if (completed === 2) resolve();
            };

            reverseRequest.onsuccess = checkComplete;
            submarineRequest.onsuccess = checkComplete;

            reverseRequest.onerror = () => reject(reverseRequest.error);
            submarineRequest.onerror = () => reject(submarineRequest.error);
        });
    }

    async [Symbol.asyncDispose](): Promise<void> {
        if (!this.db) return;
        await closeDatabase(this.dbName);
        this.db = null;
    }
}
