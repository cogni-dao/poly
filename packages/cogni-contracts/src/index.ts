// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/cogni-contracts`
 * Purpose: Cogni-owned smart contract artifacts (ABI, bytecode, types).
 * Scope: Constants only; does not include addresses, tx builders, or RPC logic.
 * Invariants: No runtime dependencies; pure constants.
 * Side-effects: none
 * Links: docs/spec/packages-architecture.md
 * @public
 */

// CogniSignal
export { COGNI_SIGNAL_ABI, COGNI_SIGNAL_BYTECODE } from "./cogni-signal";
// CumulativeMerkleDrop (1inch) — R4 claim-read surface reads/claims against the
// node's ONE deployed distributor; the distribution SETUP surface deploys it once
// from the owner's wallet, so BOTH the ABI and the creation bytecode are vendored.
export {
  CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
  CUMULATIVE_MERKLE_DISTRIBUTOR_BYTECODE,
} from "./cumulative-merkle-distributor";
// DistributionPublishCondition (Cogni-authored) — the scoped Aragon permission
// condition deployed once per node in the ONE-TIME "Authorize publishing" step so a
// wallet's EXECUTE grant is bound to the publish action set only (never unconditional).
export {
  DISTRIBUTION_PUBLISH_CONDITION_ABI,
  DISTRIBUTION_PUBLISH_CONDITION_BYTECODE,
} from "./distribution-publish-condition";
