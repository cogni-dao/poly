// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/contracts/cumulative-merkle-distributor`
 * Purpose: Barrel export for the vendored 1inch CumulativeMerkleDrop artifacts.
 * Scope: Re-exports the ABI (the R4 claim-read surface reads merkleRoot,
 *   cumulativeClaimed and calls claim) AND the creation bytecode (the distribution
 *   SETUP surface deploys ONE distributor per node from the owner's wallet, then
 *   transfers ownership to the DAO).
 * Invariants: Must export all public symbols from submodules.
 * Side-effects: none
 * Links: docs/spec/attribution-pipeline-overview.md
 * @public
 */

export { CUMULATIVE_MERKLE_DISTRIBUTOR_ABI } from "./abi";
export { CUMULATIVE_MERKLE_DISTRIBUTOR_BYTECODE } from "./bytecode";
