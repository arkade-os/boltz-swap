/**
 * Expo/React Native foreground entrypoint for `@arkade-os/boltz-swap`.
 *
 * Exposes the {@link ExpoArkadeSwaps} wrapper plus foreground-only
 * primitives (providers, the queue's task-type identifier, public
 * config types). Has no static or dynamic dependency on
 * `expo-task-manager` / `expo-background-task`.
 *
 * For OS background-task scheduling, import explicitly from
 * `@arkade-os/boltz-swap/expo/background`. That entrypoint owns the
 * static imports of the Expo background packages.
 */
export { ExpoArkadeSwaps, ExpoArkadeLightning } from "./arkade-lightning";
export { SWAP_POLL_TASK_TYPE } from "./swap-poll-task-type";
export type {
    SwapTaskDependencies,
    PersistedSwapBackgroundConfig,
    ExpoSwapBackgroundConfig,
    DefineSwapBackgroundTaskOptions,
    ExpoArkadeSwapsConfig,
    ExpoArkadeLightningConfig,
} from "./types";
