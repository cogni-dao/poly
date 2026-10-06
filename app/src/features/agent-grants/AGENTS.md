# agent-grants · AGENTS.md

> Scope: this directory only.

## Purpose

Owner-managed, expiring capability delegation between authenticated human and
machine principals.

## Public Surface

- `authorize(tx, { principalId, accountId, requiredScope })` — THE account-read
  decision. Owner-or-active-delegate; returns null for every denial. This is
  the only place account-read authorization may be decided, so the substrate
  (OpenFGA is a named future story) can be swapped behind it.
- `aliasesFor(scope)` — the expand-phase scope alias set.
- `resolvePrincipalAccountId(tx, principalId)` — the account a principal owns,
  for descriptors declaring `accountFrom: "principal"`.
- `listOwnedAgentGrants`, `replaceOwnedAgentGrant`, `revokeOwnedAgentGrant` —
  owner lifecycle operations that run inside an app-role tenant transaction.
- `createAgentAccessRequest`, `pollAgentAccessRequest`,
  `listAgentAccessRequests` — bearer-agent self-only request lifecycle.
- `previewAgentAccessRequest`, `decideAgentAccessRequest`,
  `listOwnerAgentAccessRequests` — token-bound browser-owner approval and
  lifecycle reads; grant creation commits in the same transaction as approval.

## Invariants

- `account:read` is the canonical delegated account-read scope.
  `performance:read` is its retained legacy alias; `authorize()` matches EITHER
  via array OVERLAP, and the delegated SELECT policies on
  poly_copy_trade_{fills,decisions,targets} use the SAME overlap (migration
  0074). Never express this as containment of a single name — the app check and
  RLS disagreeing produces "zero rows" instead of "denied".
- New grants are minted with BOTH names; `agent_access_requests.requested_scopes`
  still writes only the legacy name because its equality CHECK was not widened.
- Access decisions are never cached, and `authorize()` must run before any
  account-keyed cache lookup (AUTHORIZE_BEFORE_CACHE).
- Missing, expired, revoked, and wrong-scope grants fail closed.
- Grant replacement is atomic and revocation is always a soft revoke.
- Access-request rows are tracking only; the linked grant is sole authority.
- Raw approval tokens never persist and are consumed by one owner decision.
- Callers use app-role transactions with `app.current_user_id` set; never use
  the service-role bypass.
