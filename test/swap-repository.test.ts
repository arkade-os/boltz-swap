import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemorySwapRepository } from "../src/repositories/inMemory/swap-repository";
import { IndexedDbSwapRepository } from "../src/repositories/IndexedDb/swap-repository";
import { PendingReverseSwap, PendingSubmarineSwap } from "../src/types";

const createReverseSwap = (
    id: string,
    status: PendingReverseSwap["status"]
): PendingReverseSwap => ({
    id,
    type: "reverse",
    createdAt: Date.now() / 1000,
    preimage: "0".repeat(64),
    status,
    request: {
        claimPublicKey: "0".repeat(66),
        invoiceAmount: 10000,
        preimageHash: "0".repeat(64),
    },
    response: {
        id,
        invoice: "lnbc100n1p0",
        onchainAmount: 10000,
        lockupAddress: "ark1test",
        refundPublicKey: "0".repeat(66),
        timeoutBlockHeights: {
            refund: 100,
            unilateralClaim: 200,
            unilateralRefund: 300,
            unilateralRefundWithoutReceiver: 400,
        },
    },
});

const createSubmarineSwap = (
    id: string,
    status: PendingSubmarineSwap["status"]
): PendingSubmarineSwap => ({
    id,
    type: "submarine",
    createdAt: Date.now() / 1000,
    status,
    request: {
        invoice: "lnbc100n1p0",
        refundPublicKey: "0".repeat(66),
    },
    response: {
        id,
        address: "ark1test",
        expectedAmount: 10000,
        claimPublicKey: "0".repeat(66),
        acceptZeroConf: false,
        timeoutBlockHeights: {
            refund: 100,
            unilateralClaim: 200,
            unilateralRefund: 300,
            unilateralRefundWithoutReceiver: 400,
        },
    },
});

describe("SwapRepository implementations", () => {
    describe("InMemorySwapRepository", () => {
        let repo: InMemorySwapRepository;

        beforeEach(() => {
            repo = new InMemorySwapRepository();
        });

        afterEach(async () => {
            await repo.clear();
        });

        it("saves and retrieves swaps", async () => {
            const reverse = createReverseSwap("reverse-1", "swap.created");
            const submarine = createSubmarineSwap(
                "submarine-1",
                "invoice.set"
            );

            await repo.saveReverseSwap(reverse);
            await repo.saveSubmarineSwap(submarine);

            const reverseSwaps = await repo.getAllReverseSwaps();
            const submarineSwaps = await repo.getAllSubmarineSwaps();

            expect(reverseSwaps).toHaveLength(1);
            expect(reverseSwaps[0].id).toBe(reverse.id);
            expect(submarineSwaps).toHaveLength(1);
            expect(submarineSwaps[0].id).toBe(submarine.id);
        });

        it("filters swaps by id and status", async () => {
            const reverseA = createReverseSwap("reverse-a", "swap.created");
            const reverseB = createReverseSwap("reverse-b", "swap.expired");
            const submarineA = createSubmarineSwap(
                "submarine-a",
                "invoice.set"
            );
            const submarineB = createSubmarineSwap(
                "submarine-b",
                "transaction.mempool"
            );

            await repo.saveReverseSwap(reverseA);
            await repo.saveReverseSwap(reverseB);
            await repo.saveSubmarineSwap(submarineA);
            await repo.saveSubmarineSwap(submarineB);

            const byId = await repo.getAllReverseSwaps({ id: "reverse-b" });
            expect(byId).toHaveLength(1);
            expect(byId[0].id).toBe("reverse-b");

            const byStatus = await repo.getAllSubmarineSwaps({
                status: "invoice.set",
            });
            expect(byStatus).toHaveLength(1);
            expect(byStatus[0].id).toBe("submarine-a");
        });

        it("deletes swaps", async () => {
            const reverse = createReverseSwap("reverse-1", "swap.created");
            const submarine = createSubmarineSwap(
                "submarine-1",
                "invoice.set"
            );
            await repo.saveReverseSwap(reverse);
            await repo.saveSubmarineSwap(submarine);

            await repo.deleteReverseSwap(reverse.id);
            await repo.deleteSubmarineSwap(submarine.id);

            expect(await repo.getAllReverseSwaps()).toHaveLength(0);
            expect(await repo.getAllSubmarineSwaps()).toHaveLength(0);
        });

        it("clears all swaps", async () => {
            await repo.saveReverseSwap(
                createReverseSwap("reverse-1", "swap.created")
            );
            await repo.saveSubmarineSwap(
                createSubmarineSwap("submarine-1", "invoice.set")
            );

            await repo.clear();

            expect(await repo.getAllReverseSwaps()).toHaveLength(0);
            expect(await repo.getAllSubmarineSwaps()).toHaveLength(0);
        });
    });

    describe("IndexedDbSwapRepository", () => {
        let repo: IndexedDbSwapRepository;

        beforeEach(() => {
            const dbName = `swap-repo-test-${Date.now()}-${Math.random()}`;
            repo = new IndexedDbSwapRepository(dbName);
        });

        afterEach(async () => {
            await repo.clear();
            await repo[Symbol.asyncDispose]();
        });

        it("saves and retrieves swaps", async () => {
            const reverse = createReverseSwap("reverse-1", "swap.created");
            const submarine = createSubmarineSwap(
                "submarine-1",
                "invoice.set"
            );

            await repo.saveReverseSwap(reverse);
            await repo.saveSubmarineSwap(submarine);

            const reverseSwaps = await repo.getAllReverseSwaps();
            const submarineSwaps = await repo.getAllSubmarineSwaps();

            expect(reverseSwaps).toHaveLength(1);
            expect(reverseSwaps[0].id).toBe(reverse.id);
            expect(submarineSwaps).toHaveLength(1);
            expect(submarineSwaps[0].id).toBe(submarine.id);
        });

        it("filters swaps by id and status", async () => {
            const reverseA = createReverseSwap("reverse-a", "swap.created");
            const reverseB = createReverseSwap("reverse-b", "swap.expired");
            const submarineA = createSubmarineSwap(
                "submarine-a",
                "invoice.set"
            );
            const submarineB = createSubmarineSwap(
                "submarine-b",
                "transaction.mempool"
            );

            await repo.saveReverseSwap(reverseA);
            await repo.saveReverseSwap(reverseB);
            await repo.saveSubmarineSwap(submarineA);
            await repo.saveSubmarineSwap(submarineB);

            const byId = await repo.getAllReverseSwaps({ id: "reverse-b" });
            expect(byId).toHaveLength(1);
            expect(byId[0].id).toBe("reverse-b");

            const byStatus = await repo.getAllSubmarineSwaps({
                status: "invoice.set",
            });
            expect(byStatus).toHaveLength(1);
            expect(byStatus[0].id).toBe("submarine-a");
        });

        it("deletes swaps", async () => {
            const reverse = createReverseSwap("reverse-1", "swap.created");
            const submarine = createSubmarineSwap(
                "submarine-1",
                "invoice.set"
            );
            await repo.saveReverseSwap(reverse);
            await repo.saveSubmarineSwap(submarine);

            await repo.deleteReverseSwap(reverse.id);
            await repo.deleteSubmarineSwap(submarine.id);

            expect(await repo.getAllReverseSwaps()).toHaveLength(0);
            expect(await repo.getAllSubmarineSwaps()).toHaveLength(0);
        });

        it("clears all swaps", async () => {
            await repo.saveReverseSwap(
                createReverseSwap("reverse-1", "swap.created")
            );
            await repo.saveSubmarineSwap(
                createSubmarineSwap("submarine-1", "invoice.set")
            );

            await repo.clear();

            expect(await repo.getAllReverseSwaps()).toHaveLength(0);
            expect(await repo.getAllSubmarineSwaps()).toHaveLength(0);
        });
    });
});
