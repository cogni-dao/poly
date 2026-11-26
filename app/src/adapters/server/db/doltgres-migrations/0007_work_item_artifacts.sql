CREATE TABLE "work_item_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"item_revision" integer DEFAULT 0 NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"verdict" text NOT NULL,
	"rows" jsonb,
	"note" text,
	"body" text,
	"url" text,
	"author" text NOT NULL,
	"run_id" text,
	"run_kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "status_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "work_items" SET "status_revision" = "revision";--> statement-breakpoint
CREATE INDEX "idx_work_item_artifacts_item_created" ON "work_item_artifacts" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_item_artifacts_item_seq" ON "work_item_artifacts" USING btree ("item_id","seq");