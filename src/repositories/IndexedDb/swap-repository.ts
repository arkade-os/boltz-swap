import { GetSwapsFilter, SwapRepository } from "../swap-repository";
import { closeDatabase,  openDatabase } from "@arkade-os/sdk";
import { PendingReverseSwap, PendingSubmarineSwap } from "../../types";

const DEFAULT_DB_NAME = "arkade-boltz-swap";
const STORE_REVERSE_SWAPS_STATE = "reverseSwaps";
const STORE_SUBMARINE_SWAPS_STATE = "submarineSwaps";

function initDatabase(db: IDBDatabase) {
    if (!db.objectStoreNames.contains(STORE_REVERSE_SWAPS_STATE)) {
        const reverseStore = db.createObjectStore(STORE_REVERSE_SWAPS_STATE, {
            keyPath: "id",
        });
        reverseStore.createIndex("statusIndex", "status", { unique: false });
    }
    if (!db.objectStoreNames.contains(STORE_SUBMARINE_SWAPS_STATE)) {
        const submarineStore = db.createObjectStore(STORE_SUBMARINE_SWAPS_STATE, {
            keyPath: "id",
        });
        submarineStore.createIndex("statusIndex", "status", { unique: false });
    }
}

export class IndexedDbSwapRepository implements SwapRepository {
    private db: IDBDatabase | null = null;

    constructor(private readonly dbName: string = DEFAULT_DB_NAME) {}

    private async getDB(): Promise<IDBDatabase> {
        if (this.db) return this.db;
        this.db = await openDatabase(this.dbName, 2, initDatabase);
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

    async getAllReverseSwaps(
        filter?: GetSwapsFilter
    ): Promise<PendingReverseSwap[]> {
        const db = await this.getDB();
        const store = db
            .transaction([STORE_REVERSE_SWAPS_STATE], "readonly")
            .objectStore(STORE_REVERSE_SWAPS_STATE);

        if (!filter || Object.keys(filter).length === 0) {
            return new Promise((resolve, reject) => {
                const request = store.getAll();
                request.onsuccess = () =>
                    resolve((request.result ?? []) as PendingReverseSwap[]);
                request.onerror = () => reject(request.error);
            });
        }

        const normalizedFilter = normalizeFilter(filter);

        if (normalizedFilter.has("id")) {
            const ids = normalizedFilter.get("id")!;
            const swaps = await Promise.all(
                ids.map(
                    (id) =>
                        new Promise<PendingReverseSwap | undefined>(
                            (resolve, reject) => {
                                const request = store.get(id);
                                request.onsuccess = () =>
                                    resolve(request.result);
                                request.onerror = () => reject(request.error);
                            }
                        )
                )
            );
            return this.applySwapsFilter(swaps, normalizedFilter);
        }

        if (normalizedFilter.has("status")) {
            const ids = normalizedFilter.get("status")!;
            const swaps = await this.getSwapsByIndexValues<PendingReverseSwap>(store, "status", ids);
            return this.applySwapsFilter(swaps, normalizedFilter);
        }

        const allSwaps = await new Promise<PendingReverseSwap[]>((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () =>
                resolve(request.result ?? [])
            request.onerror = () => reject(request.error);
        });

        return this.applySwapsFilter(allSwaps, normalizedFilter);
    }

    async getAllSubmarineSwaps(
        filter?: GetSwapsFilter
    ): Promise<PendingSubmarineSwap[]> {
        const db = await this.getDB();
        const store = db
            .transaction([STORE_SUBMARINE_SWAPS_STATE], "readonly")
            .objectStore(STORE_SUBMARINE_SWAPS_STATE);

        if (!filter || Object.keys(filter).length === 0) {
            return new Promise((resolve, reject) => {
                const request = store.getAll();
                request.onsuccess = () =>
                    resolve((request.result ?? []) as PendingSubmarineSwap[]);
                request.onerror = () => reject(request.error);
            });
        }

        const normalizedFilter = normalizeFilter(filter);

        if (normalizedFilter.has("id")) {
            const ids = normalizedFilter.get("id")!;
            const swaps = await Promise.all(
                ids.map(
                    (id) =>
                        new Promise<PendingSubmarineSwap | undefined>(
                            (resolve, reject) => {
                                const request = store.get(id);
                                request.onsuccess = () =>
                                    resolve(request.result);
                                request.onerror = () => reject(request.error);
                            }
                        )
                )
            );
            return this.applySwapsFilter(swaps, normalizedFilter);
        }

        if (normalizedFilter.has("status")) {
            const ids = normalizedFilter.get("status")!;
            const swaps =
                await this.getSwapsByIndexValues<PendingSubmarineSwap>(
                    store,
                    "status",
                    ids
                );
            return this.applySwapsFilter(swaps, normalizedFilter);
        }

        const allSwaps = await new Promise<PendingSubmarineSwap[]>(
            (resolve, reject) => {
                const request = store.getAll();
                request.onsuccess = () => resolve(request.result ?? []);
                request.onerror = () => reject(request.error);
            }
        );

        return this.applySwapsFilter(allSwaps, normalizedFilter);
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

    private getSwapsByIndexValues<T>(
        store: IDBObjectStore,
        indexName: string,
        values: string[]
    ): Promise<T[]> {
        if (values.length === 0) return Promise.resolve([]);
        const index = store.index(indexName);
        const requests = values.map(
            (value) =>
                new Promise<T[]>((resolve, reject) => {
                    const request = index.getAll(value);
                    request.onerror = () => reject(request.error);
                    request.onsuccess = () => resolve(request.result ?? []);
                })
        );
        return Promise.all(requests).then((results) =>
            results.flatMap((result) => result)
        );
    }

    private applySwapsFilter<T extends { id: string; status: string }>(
        swaps: (T | undefined)[],
        filter: ReturnType<typeof normalizeFilter>
    ): T[] {
        return swaps.filter((swap): swap is T => {
            if (swap === undefined) return false;
            if (filter.has("id") && !filter.get("id")?.includes(swap.id))
                return false;
            if (
                filter.has("status") &&
                !filter.get("status")?.includes(swap.status)
            )
                return false;
            return true;
        });
    }

    async [Symbol.asyncDispose](): Promise<void> {
        if (!this.db) return;
        await closeDatabase(this.dbName);
        this.db = null;
    }
}

const FILTER_FIELDS = ["id", "state"] as (keyof GetSwapsFilter)[];

// Transform all filter fields into an array of values
function normalizeFilter(filter: GetSwapsFilter) {
    const res = new Map<keyof GetSwapsFilter, string[]>();
    FILTER_FIELDS.forEach((current) => {
        if (!filter?.[current]) return;
        if (Array.isArray(filter[current])) {
            res.set(current, filter[current]);
        } else {
            res.set(current, [filter[current]]);
        }
    });
    return res;
}

