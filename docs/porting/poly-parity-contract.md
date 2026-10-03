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

Every resolution record names exactly one source path and includes the expected source/target blobs and modes, rationale, behavior expectation, and proof references. A changed hash or mode invalidates the record. Every one of the 79 P0/P1 divergences belongs to exactly one delivery group.

## Delivery groups

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

PR #113 owns only `trading-wallet-overview-service.ts` and `wallet-analysis-service.ts` plus focused tests. The observer and current-position read model delivered in PR #110 are classified from evidence; they are not reopened in PR #113.

## Commands

- `pnpm poly:port:refresh -- --legacy-repo PATH` regenerates the complete ledger from the pinned source tree.
- `pnpm poly:port:verify` proves the committed ledger and report match policy and the current worktree.
- `pnpm poly:port:regression -- --base REF` rejects P0/P1 scope drift or a terminal/gate regression relative to `REF`.
- `pnpm poly:port:check-group -- GROUP` succeeds only when every file and gate in one delivery group is resolved.
- `pnpm poly:port:complete -- --through P1` succeeds only when every P0/P1 file and behavioral gate is resolved; unresolved P2/P3 entries remain reported.
