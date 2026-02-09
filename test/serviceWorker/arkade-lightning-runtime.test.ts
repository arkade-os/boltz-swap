import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ServiceWorkerArkadeLightning } from "../../src/serviceWorker/arkade-lightning-runtime";
import { DEFAULT_MESSAGE_TAG } from "../../src/serviceWorker/arkade-lightning-message-handler";
import type { PendingReverseSwap, PendingSubmarineSwap } from "../../src/types";
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

const TAG = DEFAULT_MESSAGE_TAG;

function createRuntime(fakeSw: FakeServiceWorker) {
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            serviceWorker: fakeSw,
        },
    });

    return ServiceWorkerArkadeLightning.create({
        serviceWorker: fakeSw as any,
        swapProvider: {
            getApiUrl: () => "http://example.com",
        } as any,
        swapManager: true,
    });
}

describe("SwArkadeLightningRuntime events", () => {
    let fakeSw: FakeServiceWorker;
    let sendMessageSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        fakeSw = new FakeServiceWorker();
        sendMessageSpy = vi.spyOn(
            ServiceWorkerArkadeLightning.prototype as any,
            "sendMessage"
        );
        sendMessageSpy.mockResolvedValue({
            id: "init",
            tag: TAG,
            type: "ARKADE_LIGHTNING_INITIALIZED",
        } as any);
    });

    afterEach(() => {
        // cleanup navigator stub
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (globalThis as any).navigator;
        sendMessageSpy.mockRestore();
    });

    it("forwards swap update events to listeners", async () => {
        const runtime = await createRuntime(fakeSw);
        const mgr = runtime.getSwapManager()!;

        const spy = vi.fn();
        await mgr.onSwapUpdate(spy);

        const swap = {
            id: "1",
            type: "reverse",
            status: "swap.created",
        } as PendingReverseSwap;
        fakeSw.emit({
            tag: TAG,
            type: "SM-EVENT-SWAP_UPDATE",
            payload: { swap, oldStatus: "swap.created" as BoltzSwapStatus },
        });

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(swap, "swap.created");
    });

    it("unsubscribe stops receiving events", async () => {
        const runtime = await createRuntime(fakeSw);
        const mgr = runtime.getSwapManager()!;

        const spy = vi.fn();
        const unsub = await mgr.onSwapCompleted(spy);

        const swap = {
            id: "2",
            type: "submarine",
            status: "transaction.claimed",
        } as PendingSubmarineSwap;
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
        const runtime = await createRuntime(fakeSw);
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
