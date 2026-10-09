# credits · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Status:** draft

## Purpose

Protected Money page on the stable `/credits` route. It composes the generic AI
credits panel with Poly's per-tenant trading-wallet lifecycle. The wallet panel
is the first-user path for provisioning, funding, approvals, and withdrawals.

## Pointers

- [Root AGENTS.md](../../../AGENTS.md)
- [App AGENTS.md](../../AGENTS.md)
- [Repo-spec helper](../../../shared/config/repoSpec.server.ts)
- [Credits page client](./CreditsPage.client.tsx)

## Boundaries

```json
{
  "layer": "app",
  "may_import": [
    "app",
    "features",
    "ports",
    "shared",
    "contracts",
    "styles",
    "components"
  ],
  "must_not_import": ["adapters/server", "adapters/worker", "core"]
}
```

## Public Surface

- **Exports:** none
- **Route:** `/credits` (sidebar label: Money)
- **Files considered API:** `page.tsx`, `CreditsPage.client.tsx`,
  `AiCreditsPanel.tsx`, `TradingWalletPanel.tsx`,
  `TradingWalletConnectFlow.tsx`, `TradingWalletWithdrawDialog.tsx`,
  `TradingReadinessSection.tsx`

## Responsibilities

- **Does:** Render the responsive AI credits + trading-wallet composition.
- **Does not:** Read env vars on the client; hardcode wallets or chain IDs;
  bypass wallet API contracts.

## Usage

- `CreditsPageClient` renders both panels on desktop and a two-tab switcher on mobile.
- `TradingWalletPanel` must remain rendered here; orphaning it removes the only
  production wallet onboarding path while leaving its APIs deceptively healthy.

## Standards

- Payment and wallet configuration must come from their server APIs; no env
  overrides or client-side file reads.

## Dependencies

- **Internal:** `@/shared/config`, `@/components/vendor/depay`, `@tanstack/react-query`
- **External:** none

## Change Protocol

- Update this file when route shape or config source changes.
- Keep widget config sourced from repo-spec; adjust boundaries if imports change.

## Notes

- Changing wallet/chain/provider requires editing `.cogni/repo-spec.yaml` and redeploying; no env overrides.
- Client code must treat widget configuration as props only.
