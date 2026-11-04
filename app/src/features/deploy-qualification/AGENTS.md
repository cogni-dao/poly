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
- Every proof binds the exact signed release, digest set, attempt, allocation and current helper boot. Changed subjects fail closed.
- A missing fixture, real grant, terminal receipt, fresh boot or market is a named failure. No user fixture, live venue, SQL repair or fabricated fill is allowed.
- Helper state is volatile. A restarted helper cannot recover success by placing again.
- Production explicitly returns not_declared; only candidate-a and preview select this companion.
