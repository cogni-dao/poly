---
work_item_id: task.5006
status: in_progress
branch: agent/task-5006-poly-runtime-migration-repair
last_commit: 83a0f82196e78ed87a783ce7c3b4ef03e28976a0
---

**Mission**

Pickup: continue the Cogni Poly source port and manage it as an E2E launch project, not a one-off UI patch. The immediate responsibility is to get Poly’s production candidate from the merged foundation into a functioning, deploy-safe node where legacy cogni-poly behavior is ported verbatim unless the repo’s current architecture forces an explicit adaptation.

**Goal**

Poly should expose the legacy product surfaces, runtime APIs, jobs, wallet flows, copy-trading, market research, graph/tooling behavior, and candidate/prod deployment path through this node repo. The clear E2E signal is a candidate-a flight at the exact PR SHA, `https://poly-test.cognidao.org/version` returning that SHA, `https://poly-test.cognidao.org/readyz` healthy, trading-wallet enablement no longer blocked by missing runtime secrets, and DB migrations applying through the normal initContainer with no manual SQL.

For the current deployment thread, PR #15 merged at `fbd658a50d4a9333f73b020c4ce7691f5d376f12`. Production was still serving `b53af9f9215635dadb2d2d9fae325351e3d1d200` when this handoff was written. Follow-up PR #16 carries the required `0061` migration repair at `83a0f82196e78ed87a783ce7c3b4ef03e28976a0`; candidate-a proof must show that commit deployed and that `0061` is present in `drizzle.__drizzle_migrations`.

**Start By Reading**

- `work/items/story.5000.poly-fully-online-live-and-paper-trading.md`
- `work/items/task.5003.port-legacy-schema-and-migrations.md`
- `work/items/task.5005.port-runtime-apis-and-jobs.md`
- `work/items/task.5006.port-ui-graphs-and-candidate-proof.md`
- `.cogni/secrets-catalog.yaml`
- `app/src/adapters/server/db/migrations/0061_poly_runtime_schema_repair.sql`
- `app/src/app/(app)/credits/TradingWalletPanel.tsx`
- `app/src/bootstrap/capabilities/poly-trade-executor.ts`
- `app/src/features/copy-trade/AGENTS.md`
- `docs/guides/candidate-auth-bootstrap.md`

**Current State**

- PR #15, `feat: port Cogni Poly source surfaces`, is merged to `main` at `fbd658a`.
- PR #15 candidate-a flight `28359535667` succeeded; `poly-test` served `fbd658a` and had `/readyz` healthy.
- Candidate-a live pod had the six wallet/runtime secret env keys present: `PRIVY_USER_WALLETS_APP_ID`, `PRIVY_USER_WALLETS_APP_SECRET`, `PRIVY_USER_WALLETS_SIGNING_KEY`, `POLY_WALLET_AEAD_KEY_HEX`, `POLY_WALLET_AEAD_KEY_ID`, `POLYGON_RPC_URL`.
- Candidate-a required manual schema repair before the `poly_%` runtime tables existed, because the Drizzle journal showed later migrations as applied while tables were absent.
- PR #16, `fix: repair Poly runtime migrations`, adds `0061_poly_runtime_schema_repair.sql` to make that schema repair automatic and idempotent in candidate/preview/prod.
- `0061` was rehearsed against the repaired candidate-a DB through the app pod and passed as 101 idempotent statements; local validation also passed `pnpm --filter @cogni/node-template-app typecheck`, `git diff --check`, and JSON journal parsing.
- `work/README.md`, `work/_templates/handoff.md`, and `work/handoffs/` were absent in this checkout; this handoff follows the attached command contract directly.

**Design / Implementation Target**

1. Land PR #16 before treating preview/prod migrations as unattended-safe; do not rely on the earlier manual candidate-a SQL replay as deploy proof.
2. Preserve the node-repo boundary: app code, packages, graphs, migrations, secrets catalog, and CI live here; operator owns deploy overlays, Argo, and environment secret values.
3. Port legacy cogni-poly behavior verbatim first, then document any intentional divergence with a reason and validation signal.
4. Keep trading-wallet enablement fail-fast but environment-aware: missing true credentials should disable wallet UX cleanly, not crash unrelated read-only pages.
5. Keep copy-trade, wallet-watch, redeem, market metadata, and CLOB execution behavior tenant-safe and idempotent; no BYPASSRLS reads outside sanctioned adapter seams.
6. Maintain candidate proof as a merge gate: exact SHA match, `/readyz`, route/API smoke, DB migration journal proof, and relevant logs/metrics where behavior is runtime-only.
7. Do not put secret values in git, logs, handoffs, PR descriptions, or screenshots.

**Next Actions / Risks**

- Watch candidate flight `28365781848` for PR #16 commit `83a0f82196e78ed87a783ce7c3b4ef03e28976a0`.
- After it deploys, verify `poly-test` `/version.buildSha == 83a0f82196e78ed87a783ce7c3b4ef03e28976a0`.
- Query candidate-a `drizzle.__drizzle_migrations` and confirm `0061`/`created_at=1782738900000` landed through the migrator, not manual SQL.
- Verify `poly_%` runtime tables still exist and wallet secret env keys remain present in the app pod.
- Wait for PR #16 CI, mark ready, merge through the normal queue, then monitor production until `/version.buildSha` moves to the merged repair commit or later.
- Risk: PR #15 already merged without `0061`; if preview/prod auto-roll before PR #16, they may need the follow-up deploy before Poly runtime tables are trustworthy.
- Risk: this task is only a foundation. The next manager still needs to continue legacy surface parity, especially richer research routes, copy-trade controls, graph catalog parity, and live paper-trading validation.
