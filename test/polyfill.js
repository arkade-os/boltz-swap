import setGlobalVars from "indexeddbshim/src/node.js";
globalThis.window = globalThis;
setGlobalVars(null, { checkOrigin: false, memoryDatabase: "" });
import { EventSource } from "eventsource";
globalThis.EventSource = EventSource;
