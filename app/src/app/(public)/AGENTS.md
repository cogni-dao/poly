# (public) · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Public (unauthenticated) pages wrapped in `AppHeader` + `AppFooter` shell. Server-side session check redirects signed-in users to `/dashboard`. Primary auth routing enforced at proxy level (`src/proxy.ts`).

## Pointers

- [App AGENTS.md](../AGENTS.md)
- [Architecture](../../../../../docs/spec/architecture.md)

## Boundaries

```json
{
  "layer": "app",
  "may_import": ["features", "shared", "components", "contracts"],
  "must_not_import": ["adapters", "core", "ports"]
}
```

## Public Surface

- **Exports:** none
- **Routes:** `/` (homepage — redirects signed-in users to `/dashboard`)
- **Files considered API:** `layout.tsx`, `page.tsx`
- **Client transition helper:** `AuthRedirect.tsx` overlays SIWE completion and hard-navigates to `/dashboard`.

## Responsibilities

- This directory **does**: Render the public page shell (header + footer), redirect authenticated users to `/dashboard` via server-side session check (defense-in-depth; proxy.ts is the primary authority), and use `AuthRedirect` to complete SIWE transitions.
- This directory **does not**: Handle authentication, render protected content, or manage session state.

## Usage

```bash
pnpm dev     # start dev server
pnpm build   # build for production
```

## Standards

- Server-side redirect (`getServerSessionUser` + `redirect()`) is defense-in-depth; `proxy.ts` handles primary auth routing.
- Client-side auth transition redirects are limited to `AuthRedirect`; proxy.ts remains the access-control authority.
- No auth guard — pages render for unauthenticated visitors.

## Dependencies

- **Internal:** `@/features/layout` (AppHeader, AppFooter), `@/components` (Hero, MarketCards, BrainFeed), `@/lib/auth/server` (getServerSessionUser)
- **External:** next, react

## Change Protocol

- Update this file when **Routes** change
- Bump **Last reviewed** date

## Notes

- `AuthRedirect` is retained for the legacy Poly homepage SIWE transition and redirects to `/dashboard`.
