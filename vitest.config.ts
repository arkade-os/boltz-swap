/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        setupFiles: ["./test/polyfill.js"],
        globals: true,
        environment: "node",
        mockReset: true,
        restoreMocks: true,
    },
});
