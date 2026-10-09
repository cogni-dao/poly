ALTER TABLE "poly_copy_trade_decisions" ADD COLUMN "algorithm_id" text;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_decisions" ADD COLUMN "algorithm_version_id" text;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_decisions" ADD COLUMN "config_hash" text;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_decisions" ADD COLUMN "input_snapshot_id" text;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_decisions" ADD COLUMN "assignment_id" text;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_decisions" ADD COLUMN "correlation_id" text;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ADD COLUMN "algorithm_id" text;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ADD COLUMN "algorithm_version_id" text;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ADD COLUMN "config_hash" text;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ADD COLUMN "input_snapshot_id" text;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ADD COLUMN "assignment_id" text;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ADD COLUMN "correlation_id" text;--> statement-breakpoint
CREATE INDEX "poly_copy_trade_decisions_correlation_idx" ON "poly_copy_trade_decisions" USING btree ("billing_account_id","correlation_id");--> statement-breakpoint
CREATE INDEX "poly_copy_trade_fills_correlation_idx" ON "poly_copy_trade_fills" USING btree ("billing_account_id","correlation_id");--> statement-breakpoint
ALTER TABLE "poly_copy_trade_decisions" ADD CONSTRAINT "poly_copy_trade_decisions_algorithm_lineage_complete" CHECK ((
        "poly_copy_trade_decisions"."algorithm_id" IS NULL AND "poly_copy_trade_decisions"."algorithm_version_id" IS NULL AND
        "poly_copy_trade_decisions"."config_hash" IS NULL AND "poly_copy_trade_decisions"."input_snapshot_id" IS NULL AND
        "poly_copy_trade_decisions"."assignment_id" IS NULL AND "poly_copy_trade_decisions"."correlation_id" IS NULL
      ) OR (
        "poly_copy_trade_decisions"."algorithm_id" IS NOT NULL AND "poly_copy_trade_decisions"."algorithm_version_id" IS NOT NULL AND
        "poly_copy_trade_decisions"."config_hash" IS NOT NULL AND "poly_copy_trade_decisions"."input_snapshot_id" IS NOT NULL AND
        "poly_copy_trade_decisions"."assignment_id" IS NOT NULL AND "poly_copy_trade_decisions"."correlation_id" IS NOT NULL
      ));--> statement-breakpoint
ALTER TABLE "poly_copy_trade_decisions" ADD CONSTRAINT "poly_copy_trade_decisions_algorithm_lineage_valid" CHECK ("poly_copy_trade_decisions"."algorithm_id" IS NULL OR (
        "poly_copy_trade_decisions"."algorithm_id" IN (
          'poly.copy-mirror.min-bet',
          'poly.copy-mirror.target-percentile',
          'poly.copy-mirror.target-percentile-scaled',
          'poly.copy-mirror.fill-exact',
          'poly.copy-mirror.position-gap'
        ) AND
        "poly_copy_trade_decisions"."algorithm_version_id" ~ '^sha256:[a-f0-9]{64}$' AND
        "poly_copy_trade_decisions"."config_hash" ~ '^sha256:[a-f0-9]{64}$' AND
        "poly_copy_trade_decisions"."input_snapshot_id" ~ '^sha256:[a-f0-9]{64}$'
      ));--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ADD CONSTRAINT "poly_copy_trade_fills_algorithm_lineage_complete" CHECK ((
        "poly_copy_trade_fills"."algorithm_id" IS NULL AND "poly_copy_trade_fills"."algorithm_version_id" IS NULL AND
        "poly_copy_trade_fills"."config_hash" IS NULL AND "poly_copy_trade_fills"."input_snapshot_id" IS NULL AND
        "poly_copy_trade_fills"."assignment_id" IS NULL AND "poly_copy_trade_fills"."correlation_id" IS NULL
      ) OR (
        "poly_copy_trade_fills"."algorithm_id" IS NOT NULL AND "poly_copy_trade_fills"."algorithm_version_id" IS NOT NULL AND
        "poly_copy_trade_fills"."config_hash" IS NOT NULL AND "poly_copy_trade_fills"."input_snapshot_id" IS NOT NULL AND
        "poly_copy_trade_fills"."assignment_id" IS NOT NULL AND "poly_copy_trade_fills"."correlation_id" IS NOT NULL
      ));--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ADD CONSTRAINT "poly_copy_trade_fills_algorithm_lineage_valid" CHECK ("poly_copy_trade_fills"."algorithm_id" IS NULL OR (
        "poly_copy_trade_fills"."algorithm_id" IN (
          'poly.copy-mirror.min-bet',
          'poly.copy-mirror.target-percentile',
          'poly.copy-mirror.target-percentile-scaled',
          'poly.copy-mirror.fill-exact',
          'poly.copy-mirror.position-gap'
        ) AND
        "poly_copy_trade_fills"."algorithm_version_id" ~ '^sha256:[a-f0-9]{64}$' AND
        "poly_copy_trade_fills"."config_hash" ~ '^sha256:[a-f0-9]{64}$' AND
        "poly_copy_trade_fills"."input_snapshot_id" ~ '^sha256:[a-f0-9]{64}$'
      ));