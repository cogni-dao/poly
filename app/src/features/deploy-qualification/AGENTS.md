# deploy-qualification · AGENTS.md

## Purpose

Bounded release proof for Poly's declared private paper companion. The service owns useful-work policy; bootstrap composes its dependencies and the route only validates and maps HTTP.

## Public Surface

- `verifyQualificationChallenge`: wire v1 HKDF/jose verification against runtime node, environment and full source SHA.
- `qualifyRelease`: fixed-fixture reservation, authorized placement, cancellation, persisted receipt and current-helper readback.
- `qualificationFixtures`: public IDs created through normal per-environment agent registration. Keys never belong here.
- `assertQualificationFixture`: registered machine owner, consent principal, paper-only connection and real wallet-grant checks under owner RLS.

## Invariants

- Only a confirmed committed ledger-PK insertion winner may place once. Errors, conflicts, pending operations and caller restarts are readback-only.
- Qualification and readback use the normal authorized paper executor. The service never POSTs directly to the helper.
- Known open/partial/pending receipts get bounded normal cancellation even if persistence fails; the original save error wins. Unknown outcomes never qualify or permit another dispatch.
- The purpose-specific capability is verified before reading the strict mode body (256 bytes / 1 second). Authentication, body and action share a 19-second request deadline.
- Discovery and executor HTTP use native abort signals. Fixture, authorization and ledger transactions share the remaining deadline on one action-owned app-role connection; only that connection is closed on abort. At most one qualification connection per process; shared pools are never closed.
- Every proof binds the exact signed release, digest set, attempt, allocation and current helper boot. Changed subjects fail closed.
- A missing fixture, real grant, terminal receipt, fresh boot or market is a named failure. No user fixture, live venue, SQL repair or fabricated fill is allowed.
- Helper state is volatile. A restarted helper cannot recover success by placing again.
- Production explicitly returns not_declared; only candidate-a and preview select this companion.
