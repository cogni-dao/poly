# Shared position comparison and saved metadata

Source: bug.5043, story.5024; provider domain and wallet-analysis saved readers.

`@cogni/poly-market-provider` exports pure `normalizePositionIdentity`,
`positionIdentityKey`, `comparePositionIdentity` and `selectPositionMetadata`.
The identity is lowercased bare condition hex plus the exact decimal token string;
labels, array order, wallet primary/hedge rank and algorithm never select a match.
An opposite relationship requires mutual token mapping. The newest meaningful
mapping at the selected source/timestamp must be unique; tied witnesses and both
valid raw aliases participate in that check. A contradictory mapping produces
`oppositeProofAvailability=conflict` and a null opposite token, independently of
valid display labels and exact same-token identity. Consumers must not revive a
rejected mapping from a legacy fallback. Older disagreements do not override a
uniquely newer mapping. Missing identity is
unavailable. Condition metadata may supply a title; outcome labels require exact
condition/token provenance. These functions perform no I/O or economic arithmetic.

The app's `position-metadata-read` batches saved metadata probes over requested
keys. `positionMetadataRequestKey` includes the requested wallet. Wallet observations
never widen to another wallet when the requested wallet is unregistered; requests
without a wallet read global canonical/outcome sources only. Each field selects
its newest meaningful saved value independently, with the request cutoff applied
to every source. Bounded results do not imply constant work across a requested
token's sparse history; existing exact-key indexes exclude unrelated history.
Target books retain optional display metadata without making algorithm
eligibility depend on it. Sparse publication cannot erase known exact-token
labels or canonical titles. Attempts, target positions and market participants
consume the same saved resolver. Current/history integration consumes that seam
with the canonical economic projection; ordinary market overlap remains
condition-scoped and wallet research aggregates remain wallet-scoped.

Market participants expose all legs, with compatibility primary/hedge ranking
kept wallet-relative. `tokenComparisons` anchors each counterpart to our exact
outcome, so a target's hedge can be the same-token match while its primary is
opposite. `oppositeTargetTokenIds` retains proven opposite holdings even when an
exact counterpart also exists. Canonical economic facts are selected by requested
live/paper mode plus exact identity. Unknown economics stays nullable; lifetime P/L cannot be inferred from
partial local BUY activity, nor can remaining basis be reconstructed by subtracting
lifetime P/L from current value. Unrealized P/L is reported separately. Existing
Modified-Dietz gaps remain unavailable without complete cash-flow evidence.

The frozen synthetic identity oracle and independent source-backed reporting
oracle are distinct benchmarks. Report known/unavailable denominators, metadata
coverage, precision, recall and accuracy separately; any wrong-token match or
borrowed outcome label blocks release. These fixtures do not establish a
statistically precise all-market production success rate.
