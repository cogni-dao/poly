-- bug.0015 — repair for deployed Doltgres `knowledge` tables that lack the
-- columns 0004 added. A knowledge contribution carrying metricSpec or
-- kpiBindings writes metric_spec / kpi_bindings and returns 500 when they are
-- absent; reads tolerate the gap (row.metric_spec ?? null), so only those writes
-- fail. Forward-only: 0004 stays untouched (applied-migration immutability).
--
-- Plain ADD COLUMN on purpose: Doltgres 0.57.3 rejects ADD COLUMN IF NOT EXISTS
-- ("not supported yet"). scripts/db/migrate-doltgres.mjs skips an ADD COLUMN
-- whose live column already exists, so this is a no-op where 0004 landed
-- (candidate-a, fresh births) and the repair where it did not.
ALTER TABLE "knowledge" ADD COLUMN "metric_spec" jsonb;--> statement-breakpoint
ALTER TABLE "knowledge" ADD COLUMN "kpi_bindings" jsonb;
