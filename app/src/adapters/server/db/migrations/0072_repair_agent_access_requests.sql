-- Reconcile Story 5002 after candidate-a recorded a different migration at
-- ordinal 0071. On a clean database, 0071 already created this exact table;
-- every statement below is therefore intentionally idempotent. On the
-- polluted candidate, the table is absent and this migration creates it.
CREATE TABLE IF NOT EXISTS "public"."agent_access_requests" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"requester_principal_id" text NOT NULL,
	"requester_display_name" text NOT NULL,
	"requested_scopes" text[] NOT NULL,
	"grant_expires_at" timestamp with time zone NOT NULL,
	"approval_token_hash" text NOT NULL,
	"approval_token_expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"billing_account_id" text,
	"approved_grant_id" uuid,
	"decision_by_user_id" text,
	"decided_at" timestamp with time zone,
	"token_consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- CREATE TABLE IF NOT EXISTS does not repair a partially-created relation.
-- These clauses make the forward repair additive while preserving any rows.
ALTER TABLE "public"."agent_access_requests"
	ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL,
	ADD COLUMN IF NOT EXISTS "requester_principal_id" text NOT NULL,
	ADD COLUMN IF NOT EXISTS "requester_display_name" text NOT NULL,
	ADD COLUMN IF NOT EXISTS "requested_scopes" text[] NOT NULL,
	ADD COLUMN IF NOT EXISTS "grant_expires_at" timestamp with time zone NOT NULL,
	ADD COLUMN IF NOT EXISTS "approval_token_hash" text NOT NULL,
	ADD COLUMN IF NOT EXISTS "approval_token_expires_at" timestamp with time zone NOT NULL,
	ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'pending' NOT NULL,
	ADD COLUMN IF NOT EXISTS "billing_account_id" text,
	ADD COLUMN IF NOT EXISTS "approved_grant_id" uuid,
	ADD COLUMN IF NOT EXISTS "decision_by_user_id" text,
	ADD COLUMN IF NOT EXISTS "decided_at" timestamp with time zone,
	ADD COLUMN IF NOT EXISTS "token_consumed_at" timestamp with time zone,
	ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL,
	ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'public.agent_access_requests'::regclass
			AND contype = 'p'
	) THEN
		ALTER TABLE "public"."agent_access_requests"
			ADD CONSTRAINT "agent_access_requests_pkey" PRIMARY KEY ("id");
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'public.agent_access_requests'::regclass
			AND conname = 'agent_access_requests_status_canonical'
	) THEN
		ALTER TABLE "public"."agent_access_requests"
			ADD CONSTRAINT "agent_access_requests_status_canonical"
			CHECK ("status" IN ('pending','approved','denied','expired','revoked'));
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'public.agent_access_requests'::regclass
			AND conname = 'agent_access_requests_scope_performance_read'
	) THEN
		ALTER TABLE "public"."agent_access_requests"
			ADD CONSTRAINT "agent_access_requests_scope_performance_read"
			CHECK ("requested_scopes" = ARRAY['performance:read']::text[]);
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'public.agent_access_requests'::regclass
			AND conname = 'agent_access_requests_expiry_after_creation'
	) THEN
		ALTER TABLE "public"."agent_access_requests"
			ADD CONSTRAINT "agent_access_requests_expiry_after_creation"
			CHECK ("grant_expires_at" > "created_at" AND "approval_token_expires_at" > "created_at");
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'public.agent_access_requests'::regclass
			AND conname = 'agent_access_requests_lifecycle_consistent'
	) THEN
		ALTER TABLE "public"."agent_access_requests"
			ADD CONSTRAINT "agent_access_requests_lifecycle_consistent" CHECK ((
				"status" IN ('pending','expired')
				AND "billing_account_id" IS NULL
				AND "approved_grant_id" IS NULL
				AND "decision_by_user_id" IS NULL
				AND "decided_at" IS NULL
				AND "token_consumed_at" IS NULL
			) OR (
				"status" = 'denied'
				AND "billing_account_id" IS NOT NULL
				AND "approved_grant_id" IS NULL
				AND "decision_by_user_id" IS NOT NULL
				AND "decided_at" IS NOT NULL
				AND "token_consumed_at" IS NOT NULL
			) OR (
				"status" IN ('approved','revoked')
				AND "billing_account_id" IS NOT NULL
				AND "approved_grant_id" IS NOT NULL
				AND "decision_by_user_id" IS NOT NULL
				AND "decided_at" IS NOT NULL
				AND "token_consumed_at" IS NOT NULL
			));
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'public.agent_access_requests'::regclass
			AND conname = 'agent_access_requests_requester_principal_id_users_id_fk'
	) THEN
		ALTER TABLE "public"."agent_access_requests"
			ADD CONSTRAINT "agent_access_requests_requester_principal_id_users_id_fk"
			FOREIGN KEY ("requester_principal_id") REFERENCES "public"."users"("id")
			ON DELETE cascade ON UPDATE no action;
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'public.agent_access_requests'::regclass
			AND conname = 'agent_access_requests_billing_account_id_billing_accounts_id_fk'
	) THEN
		ALTER TABLE "public"."agent_access_requests"
			ADD CONSTRAINT "agent_access_requests_billing_account_id_billing_accounts_id_fk"
			FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id")
			ON DELETE cascade ON UPDATE no action;
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'public.agent_access_requests'::regclass
			AND conname = 'agent_access_requests_approved_grant_id_agent_capability_grants_id_fk'
	) THEN
		ALTER TABLE "public"."agent_access_requests"
			ADD CONSTRAINT "agent_access_requests_approved_grant_id_agent_capability_grants_id_fk"
			FOREIGN KEY ("approved_grant_id") REFERENCES "public"."agent_capability_grants"("id")
			ON DELETE no action ON UPDATE no action;
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'public.agent_access_requests'::regclass
			AND conname = 'agent_access_requests_decision_by_user_id_users_id_fk'
	) THEN
		ALTER TABLE "public"."agent_access_requests"
			ADD CONSTRAINT "agent_access_requests_decision_by_user_id_users_id_fk"
			FOREIGN KEY ("decision_by_user_id") REFERENCES "public"."users"("id")
			ON DELETE no action ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "agent_access_requests_token_hash_idx"
	ON "public"."agent_access_requests" USING btree ("approval_token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_access_requests_approved_grant_idx"
	ON "public"."agent_access_requests" USING btree ("approved_grant_id")
	WHERE "approved_grant_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_access_requests_requester_pending_idx"
	ON "public"."agent_access_requests" USING btree ("requester_principal_id")
	WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_access_requests_account_created_idx"
	ON "public"."agent_access_requests" USING btree ("billing_account_id", "created_at");
--> statement-breakpoint

ALTER TABLE "public"."agent_access_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."agent_access_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- PostgreSQL has no CREATE POLICY IF NOT EXISTS. Replacing policies inside the
-- migration transaction both repairs drift and makes re-execution deterministic.
DROP POLICY IF EXISTS "agent_access_requests_select" ON "public"."agent_access_requests";
--> statement-breakpoint
CREATE POLICY "agent_access_requests_select" ON "public"."agent_access_requests"
	AS PERMISSIVE FOR SELECT TO public USING (
		"requester_principal_id" = current_setting('app.current_user_id', true)
		OR "billing_account_id" IN (
			SELECT id FROM billing_accounts
			WHERE owner_user_id = current_setting('app.current_user_id', true)
		)
		OR (
			"status" = 'pending'
			AND "approval_token_hash" = current_setting('app.agent_access_request_token_hash', true)
			AND "approval_token_expires_at" > now()
		)
	);
--> statement-breakpoint

DROP POLICY IF EXISTS "agent_access_requests_insert" ON "public"."agent_access_requests";
--> statement-breakpoint
CREATE POLICY "agent_access_requests_insert" ON "public"."agent_access_requests"
	AS PERMISSIVE FOR INSERT TO public WITH CHECK (
		"requester_principal_id" = current_setting('app.current_user_id', true)
		AND "status" = 'pending'
		AND "billing_account_id" IS NULL
		AND "approved_grant_id" IS NULL
		AND "decision_by_user_id" IS NULL
	);
--> statement-breakpoint

DROP POLICY IF EXISTS "agent_access_requests_requester_expire" ON "public"."agent_access_requests";
--> statement-breakpoint
CREATE POLICY "agent_access_requests_requester_expire" ON "public"."agent_access_requests"
	AS PERMISSIVE FOR UPDATE TO public USING (
		"requester_principal_id" = current_setting('app.current_user_id', true)
		AND "status" = 'pending'
		AND "approval_token_expires_at" <= now()
	) WITH CHECK (
		"requester_principal_id" = current_setting('app.current_user_id', true)
		AND "status" = 'expired'
		AND "billing_account_id" IS NULL
		AND "approved_grant_id" IS NULL
		AND "decision_by_user_id" IS NULL
	);
--> statement-breakpoint

DROP POLICY IF EXISTS "agent_access_requests_owner_update" ON "public"."agent_access_requests";
--> statement-breakpoint
CREATE POLICY "agent_access_requests_owner_update" ON "public"."agent_access_requests"
	AS PERMISSIVE FOR UPDATE TO public USING (
		"billing_account_id" IN (
			SELECT id FROM billing_accounts
			WHERE owner_user_id = current_setting('app.current_user_id', true)
		) OR (
			"status" = 'pending'
			AND "approval_token_hash" = current_setting('app.agent_access_request_token_hash', true)
			AND "approval_token_expires_at" > now()
		)
	) WITH CHECK (
		"billing_account_id" IN (
			SELECT id FROM billing_accounts
			WHERE owner_user_id = current_setting('app.current_user_id', true)
		)
		AND "decision_by_user_id" = current_setting('app.current_user_id', true)
	);
