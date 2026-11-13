CREATE TABLE "agent_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	CONSTRAINT "agent_claims_claimed_together" CHECK (("agent_claims"."claimed_at" IS NULL) = ("agent_claims"."claimed_by" IS NULL)),
	CONSTRAINT "agent_claims_claimant_not_agent" CHECK ("agent_claims"."claimed_by" IS NULL OR "agent_claims"."claimed_by" <> "agent_claims"."agent_user_id")
);
--> statement-breakpoint
ALTER TABLE "agent_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN "resource_kind" text DEFAULT 'node' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_claims" ADD CONSTRAINT "agent_claims_agent_user_id_users_id_fk" FOREIGN KEY ("agent_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_claims" ADD CONSTRAINT "agent_claims_claimed_by_users_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_claims_agent_idx" ON "agent_claims" USING btree ("agent_user_id");--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_resource_kind_canonical" CHECK ("agent_roles"."resource_kind" IN ('node','delegated'));--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_owner_shape" CHECK (("agent_roles"."resource_kind" = 'node') = ("agent_roles"."owner_user_id" IS NULL));--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_personal_approver" CHECK ("agent_roles"."resource_kind" = 'node' OR "agent_roles"."approved_by" IS NULL OR ("agent_roles"."approved_by" = "agent_roles"."owner_user_id" AND "agent_roles"."approved_by" <> "agent_roles"."principal_user_id" AND "agent_roles"."expires_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_personal_scope_delegable" CHECK ("agent_roles"."resource_kind" = 'node' OR "agent_roles"."scope" IN ('knowledge:read','knowledge:contribute'));
--> statement-breakpoint
-- Hand-written below: FORCE RLS is outside Drizzle's DDL scope. EXPAND-ONLY: three nullable or defaulted columns and four CHECKs on a table whose every
-- existing row is a node row (the DEFAULT 'node' backfills them; each CHECK holds for a node row with no owner and no end), and one new table.
-- Shape follows the @cogni-dao/agent-grants migration template `agent_personal_grants.sql`.
-- A personal row is the owner's decision (approved_by = owner_user_id, never the agent), always ends (expires_at), and only for the delegable list.
-- agent_claims has NO policy: ENABLE + FORCE = deny-all for the app role. Only the BYPASSRLS service role reads or writes it (the claim routes).
ALTER TABLE "agent_claims" FORCE ROW LEVEL SECURITY;
