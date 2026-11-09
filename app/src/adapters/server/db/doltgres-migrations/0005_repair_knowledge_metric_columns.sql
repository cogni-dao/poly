-- bug.0015 — repair for deployed Doltgres `knowledge` tables that lack the
-- columns 0004 added. A knowledge contribution carrying metricSpec or
-- kpiBindings writes metric_spec / kpi_bindings and returns 500 when they are
-- absent; reads tolerate the gap (row.metric_spec ?? null), so only those writes
-- fail. Forward-only: 0004 stays untouched (applied-migration immutability).
--
-- Idempotent on every DB that already has the columns (candidate-a, fresh
-- births): ADD COLUMN IF NOT EXISTS is a no-op there. Plain ADD COLUMN would
-- throw `column ... already exists`, which scripts/db/migrate-doltgres.mjs does
-- not tolerate (isAlreadyExists covers table/index/schema/relation/constraint).
ALTER TABLE "knowledge" ADD COLUMN IF NOT EXISTS "metric_spec" jsonb;--> statement-breakpoint
ALTER TABLE "knowledge" ADD COLUMN IF NOT EXISTS "kpi_bindings" jsonb;
