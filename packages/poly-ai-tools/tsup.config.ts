// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-ai-tools/tsup.config`
 * Purpose: Build configuration for Poly-specific AI tools.
 * Scope: Build tooling only; does not contain runtime code.
 * Invariants: Output must be ESM with type declarations emitted by tsc.
 * Side-effects: IO
 * Links: packages/poly-ai-tools/
 * @internal
 */

import { defineConfig } from "tsup";

export const tsupConfig = defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: false,
  sourcemap: true,
  platform: "node",
  external: [
    "@cogni/ai-core",
    "@cogni/ai-tools",
    "@cogni/poly-market-provider",
    "zod",
  ],
});

// biome-ignore lint/style/noDefaultExport: required by tsup
export default tsupConfig;
