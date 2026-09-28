CREATE TABLE "identity_signin_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"nonce_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_signin_challenges_nonce_hash_unique" UNIQUE("nonce_hash")
);
--> statement-breakpoint
ALTER TABLE "identity_signin_challenges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "identity_signin_challenges_expires_at_idx" ON "identity_signin_challenges" USING btree ("expires_at");--> statement-breakpoint
-- Hand-written: RLS FORCE is outside Drizzle's DDL scope, same as 0027_rls_epoch_coverage.
-- ENABLE + FORCE with NO policy = deny-all, fail-closed. Challenges are minted and
-- consumed exclusively by the service role during sign-in, when there is no app user to
-- scope a policy to -- the row exists precisely because nobody is authenticated yet.
-- Without FORCE the table owner bypasses RLS entirely (docs/spec/database-rls.md,
-- RLS_COVERAGE invariant).
ALTER TABLE "identity_signin_challenges" FORCE ROW LEVEL SECURITY;
