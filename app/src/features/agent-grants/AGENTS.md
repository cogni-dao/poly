# agent-grants · AGENTS.md

> Scope: this directory only.

## Purpose

Owner-managed, expiring capability delegation between authenticated human and
machine principals.

## Public Surface

- `resolvePerformanceRead(tx, input)` — owner-or-active-delegate read decision.
- `listOwnedAgentGrants`, `replaceOwnedAgentGrant`, `revokeOwnedAgentGrant` —
  owner lifecycle operations that run inside an app-role tenant transaction.
- `createAgentAccessRequest`, `pollAgentAccessRequest`,
  `listAgentAccessRequests` — bearer-agent self-only request lifecycle.
- `previewAgentAccessRequest`, `decideAgentAccessRequest`,
  `listOwnerAgentAccessRequests` — token-bound browser-owner approval and
  lifecycle reads; grant creation commits in the same transaction as approval.

## Invariants

- Story 1 consumes only `performance:read`.
- Missing, expired, revoked, and wrong-scope grants fail closed.
- Grant replacement is atomic and revocation is always a soft revoke.
- Access-request rows are tracking only; the linked grant is sole authority.
- Raw approval tokens never persist and are consumed by one owner decision.
- Callers use app-role transactions with `app.current_user_id` set; never use
  the service-role bypass.
