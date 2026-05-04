/**
 * Task type identifier for the swap-polling background task.
 *
 * Foreground-safe constant: foreground code uses this to seed and read
 * the AsyncStorage-backed task queue. The OS task body in
 * `@arkade-os/boltz-swap/expo/background` consumes the same constant.
 */
export const SWAP_POLL_TASK_TYPE = "swap-poll";
