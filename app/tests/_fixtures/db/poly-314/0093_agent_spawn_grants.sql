CREATE TABLE "agent_spawn_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer_user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"redeemed_user_id" text,
	CONSTRAINT "agent_spawn_grants_redeemed_together" CHECK (("agent_spawn_grants"."redeemed_at" IS NULL) = ("agent_spawn_grants"."redeemed_user_id" IS NULL)),
	CONSTRAINT "agent_spawn_grants_expiry_after_issue" CHECK ("agent_spawn_grants"."expires_at" > "agent_spawn_grants"."created_at")
);
--> statement-breakpoint
ALTER TABLE "agent_spawn_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "agent_spawn_grants" ADD CONSTRAINT "agent_spawn_grants_issuer_user_id_users_id_fk" FOREIGN KEY ("issuer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_spawn_grants" ADD CONSTRAINT "agent_spawn_grants_redeemed_user_id_users_id_fk" FOREIGN KEY ("redeemed_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_spawn_grants_token_hash_unique" ON "agent_spawn_grants" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "agent_spawn_grants_issuer_idx" ON "agent_spawn_grants" USING btree ("issuer_user_id");--> statement-breakpoint
ALTER TABLE "agent_principals" ADD CONSTRAINT "agent_principals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_principals_owner_idx" ON "agent_principals" USING btree ("owner_user_id");--> statement-breakpoint
ALTER TABLE "agent_principals" ADD CONSTRAINT "agent_principals_owner_external_only" CHECK ("agent_principals"."kind" = 'external' OR "agent_principals"."owner_user_id" IS NULL);--> statement-breakpoint
ALTER TABLE "agent_principals" ADD CONSTRAINT "agent_principals_owner_not_self" CHECK ("agent_principals"."owner_user_id" IS NULL OR "agent_principals"."owner_user_id" <> "agent_principals"."user_id");
--> statement-breakpoint
-- Hand-written below: FORCE RLS is outside Drizzle's DDL scope. EXPAND-ONLY: one nullable column, one new table; nothing is rewritten.
-- Shape follows the @cogni-dao/agent-grants migration template `agent_spawn_grants.sql`.
-- agent_spawn_grants has NO policy: ENABLE + FORCE = deny-all for the app role. Only the BYPASSRLS service role reads or writes it (the issue and
-- redeem routes). Existing agent_principals rows keep owner_user_id NULL (ownerless); the existing select policy and FORCE RLS are unchanged.
ALTER TABLE "agent_spawn_grants" FORCE ROW LEVEL SECURITY;
