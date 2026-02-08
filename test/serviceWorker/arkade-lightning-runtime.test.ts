import { describe, it, expect, vi, beforeEach } from "vitest";
import { SwArkadeLightningRuntime } from "../../src/serviceWorker/arkade-lightning-runtime";
import type {
    PendingReverseSwap,
    PendingSubmarineSwap,
} from "../../src/types";
import { BoltzSwapStatus } from "../../src/boltz-swap-provider";

class FakeServiceWorker {
    listeners: ((e: MessageEvent) => void)[] = [];
    postMessage = vi.fn();
    addEventListener = (type: string, cb: (e: MessageEvent) => void) => {
        if (type === "message") this.listeners.push(cb);
    };
    removeEventListener = (type: string, cb: (e: MessageEvent) => void) => {
        if (type === "message") {
            this.listeners = this.listeners.filter((l) => l !== cb);
        }
    };
    emit(data: any) {
        const evt = { data } as MessageEvent;
        this.listeners.forEach((cb) => cb(evt));
    }
}

const TAG = "ARKADE_LIGHTNING_UPDATER";

function createRuntime(fakeSw: FakeServiceWorker) {
    (globalThis as any).navigator = {
        serviceWorker: fakeSw,
    } as any;

    return SwArkadeLightningRuntime.create({
        serviceWorker: fakeSw as any,
        swapProvider: {} as any,
        swapManager: true,
    });
}

describe("SwArkadeLightningRuntime events", () => {
    let fakeSw: FakeServiceWorker;

    beforeEach(() => {
        fakeSw = new FakeServiceWorker();
    });

    it("forwards swap update events to listeners", async () => {
        const runtime = createRuntime(fakeSw);
        const mgr = runtime.getSwapManager()!;

        const spy = vi.fn();
        await mgr.onSwapUpdate(spy);

        const swap = { id: "1", type: "reverse", status: "swap.created" } as PendingReverseSwap;
        fakeSw.emit({
            tag: TAG,
            type: "SM-EVENT-SWAP_UPDATE",
            payload: { swap, oldStatus: "swap.created" as BoltzSwapStatus },
        });

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(swap, "swap.created");
    });

    it("unsubscribe stops receiving events", async () => {
        const runtime = createRuntime(fakeSw);
        const mgr = runtime.getSwapManager()!;

        const spy = vi.fn();
        const unsub = await mgr.onSwapCompleted(spy);

        const swap = { id: "2", type: "submarine", status: "transaction.claimed" } as PendingSubmarineSwap;
        fakeSw.emit({
            tag: TAG,
            type: "SM-EVENT-SWAP_COMPLETED",
            payload: { swap },
        });
        expect(spy).toHaveBeenCalledTimes(1);

        unsub();
        fakeSw.emit({
            tag: TAG,
            type: "SM-EVENT-SWAP_COMPLETED",
            payload: { swap },
        });
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("ignores events for other tags", async () => {
        const runtime = createRuntime(fakeSw);
        const mgr = runtime.getSwapManager()!;
        const spy = vi.fn();
        await mgr.onSwapFailed(spy);

        fakeSw.emit({
            tag: "OTHER",
            type: "SM-EVENT-SWAP_FAILED",
            payload: { swap: { id: "x" } as any, error: { message: "err" } },
        });

        expect(spy).not.toHaveBeenCalled();
    });
});
