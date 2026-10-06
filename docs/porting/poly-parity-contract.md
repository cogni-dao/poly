# Poly P0/P1 parity contract

This contract is the immutable completion boundary for `story.5000`. Delivery may add evidence, but it must not weaken, narrow, or reinterpret the outcome below.

## Locked outcome

1. All 28 P0 and 51 P1 legacy divergences resolve as `exact`, `upgraded`, or `retired`, with pinned source and target blobs, file modes, rationale, expected behavior, and proof references.
2. Hub, dashboard, wallet, trading, provider, and research behaviors are observable end to end. Unavailable or stale data never collapses to false zero.
3. Candidate proves exact-SHA deployability, contracts, failure semantics, authenticated UI behavior, and feature-specific logs. Production proves the existing user and algorithm path through passive observation.
4. The scanner rejects incomplete, duplicate, orphaned, or stale resolution records and emits all 1,736 legacy files. P2 and P3 remain visibly queued.
5. Validation must not fund a wallet, change strategy or configuration, or place a manual order.

## Pinned source

- Repository: `https://github.com/Cogni-DAO/cogni-poly.git`
- Revision: `95a934e57d51b99aa9891fc8084d20c13d0ed78a`
- Subtree: `nodes/poly`
- Subtree object: `0e10d2baa4acbf50914476562c06788ff2a3d040`
- Legacy file count: `1736`
- Source-entry digest (path + mode + blob): `69e4ca164104ed6f1d6e8dde8337274acc09b0be3cf1b3d983d1bc64cc82309e`

The source revision, subtree object, subtree root, and file count are one indivisible pin. Changing any of them is a new parity project, not maintenance of this contract.

## Resolution states

- `unresolved`: the target is missing or differs, a required resolution record is absent, or evidence is incomplete. This is never a completion state.
- `exact`: source and target path bytes and modes satisfy an explicit resolution record.
- `upgraded`: a deliberate current implementation satisfies an explicit, hash-pinned resolution record and its candidate/production proof obligations.
- `retired`: removal satisfies an explicit, source-pinned resolution record and proves the behavior is intentionally obsolete or replaced.

Every resolution record names exactly one source path and includes the expected source/target blobs and modes, rationale, behavior expectation, applicable behavior-gate IDs, and candidate/production proof references pinned to build SHA and observation time. A changed hash or mode invalidates the record. Every one of the 79 P0/P1 divergences belongs to exactly one delivery group.

## Delivery groups

<!-- amendment-exempt:begin -->
| Group | P0 | P1 | Proof outcome |
| --- | ---: | ---: | --- |
| `hub-control-plane` | 8 | 0 | Candidate and production CRUD, claim/heartbeat, UI/read, delete, and restart persistence |
| `saved-facts` | 2 | 2 | Candidate read semantics plus production saved-fact/oracle reconciliation |
| `dashboard-truth` | 7 | 3 | Candidate API/UI/log behavior plus production wallet truth |
| `visible-p0` | 11 | 0 | Candidate and production authenticated desktop/mobile behavior |
| `p1-provider-foundation` | 0 | 14 | Candidate contracts/failures plus passive production provider evidence |
| `p1-execution-wallet` | 0 | 18 | Candidate safety/idempotency plus passive production algorithm evidence |
| `p1-research-reads` | 0 | 14 | Candidate bounded/failure behavior plus passive production research evidence |
| **Total** | **28** | **51** | |

Scope counts mirror the current policy and may grow additively under Amendment 1. The ratified 28 P0 + 51 P1 split is a floor the scanner enforces; it can never shrink.
<!-- amendment-exempt:end -->

PR #113 owns only `trading-wallet-overview-service.ts` and `wallet-analysis-service.ts` plus focused tests. The observer and current-position read model delivered in PR #110 are classified from evidence; they are not reopened in PR #113.

## Commands

- `pnpm poly:port:refresh -- --legacy-repo PATH` regenerates the complete ledger from the pinned source tree.
- `pnpm poly:port:verify` proves the committed ledger and report match policy and the current worktree.
- `pnpm poly:port:regression -- --base REF` rejects P0/P1 scope drift or a terminal/gate regression relative to `REF`.
- `pnpm poly:port:check-group -- GROUP` succeeds only when every file and gate in one delivery group is resolved.
- `pnpm poly:port:complete -- --through P1` succeeds only when every P0/P1 file and behavioral gate is resolved; unresolved P2/P3 entries remain reported.

## Amendments

### Amendment 1 — additive-only mission scope growth

PR #129 proved that a legitimately validated product divergence of a previously `exact` file could never become terminal: an `upgraded` resolution requires delivery-group membership, and the regression gate rejected any `sourcePaths` change. Delivery-group membership may now grow **additively only**: every added path must already exist in the pinned 1,736-file inventory, removals and renames still fail the regression gate, the delivery-group set and the seven behavioral gates remain frozen, and the ratified 28 P0 + 51 P1 scope is a floor that can never shrink. Only the scope-count table above is exempt from the frozen contract digest; every other section remains hash-frozen, and any future contract change requires appending a newly ratified digest to the scanner's amendment lineage in the same reviewed change.

### Amendment 2 — the trading identity is the funder address, never a signer fallback

The ratified `dashboard.wallet_identity` requirement read *"`funder_address` when present, otherwise the legacy signer address."* That fallback described a real era: before migration `0066_green_magik.sql` added `funder_address`, the Privy signer traded directly and so genuinely was the funder. Polymarket no longer honours that EOA-direct path, and 0066 added the column nullable with no backfill, so today a null funder marks a connection that has no usable trading identity until it is migrated to a V2 deposit wallet. Resolving it to the signer reports a wallet that cannot trade as though it could — the exact false-truth this contract exists to forbid (locked outcome 2), and it reports it to the observer and the executor alike.

The gate requirement is re-ratified as: **the observer and every dashboard read model resolve the tenant trading identity from `funder_address` alone; an absent funder is an explicit unprovisioned state and is never substituted with another address.**

This amendment narrows nothing. It makes the gate stricter, and it moves the gate from red-because-ambiguous to red-because-unbuilt: the eight live `funder ?? signer` substitution sites are now work this gate owns, not unapproved product change. No other gate, no delivery group, no source pin, and no scope count moves. `requirement` remains a frozen field for every gate the amendment does not name; the scanner enforces that a requirement may change only in the same reviewed change that advances the contract to this ratified digest and names the gate.
