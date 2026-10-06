---
id: guide.candidate-auth-bootstrap
type: guide
title: Candidate Auth Bootstrap — Authed Playwright via CDP Attach
status: draft
trust: draft
summary: Mint an authed session for any env headlessly via scripts/dev/siwe-login.mjs (no browser, no MetaMask), export Playwright storageState, and drive authed Playwright flows. MetaMask + CDP-attach capture remains as the fallback for human-owned accounts.
read_when: An agent needs an authed browser/API session for candidate or prod, capturing a new env's storageState, or troubleshooting why a captured session no longer authenticates
owner: derekg1729
created: 2026-06-18
verified: null
tags: [auth, playwright, candidate-a, validate, metamask]
---

# Candidate Auth Bootstrap — Authed Playwright via CDP Attach

> Goal: capture a reusable signed-in browser session for `<node>-test.cognidao.org` (this node's candidate-a env) so AI agents (Claude, qa-agent) can drive authed Playwright flows without re-prompting MetaMask on every run.
>
> Human effort: one-time MetaMask install into a dedicated Chrome profile (~2 min), then 1–2 clicks to sign in per env. Recapture when the session cookie expires (days–weeks).

## Headless SIWE login (no MetaMask) — PRIMARY PATH

Fully headless, zero human effort, works against any env. `scripts/dev/siwe-login.mjs` performs the whole SIWE handshake with plain `fetch` + viem signing — no browser involved:

1. `GET {base}/api/auth/csrf` → CSRF token (the server uses this same token as the SIWE **nonce**; the CSRF cookie must travel with the callback POST)
2. Build the EIP-4361 message: `domain` = host of the env's `NEXTAUTH_URL`, `uri` = origin, `chainId` = **8453** (Base — the app's single active chain, `packages/node-shared` `ACTIVE_CHAIN_KEY`), `nonce` = csrfToken
3. Sign with a viem local account, `POST {base}/api/auth/callback/credentials` (provider id is `credentials`, not `siwe`/`ethereum` — see `app/src/auth.ts:149`)
4. Verify `GET /api/auth/session` returns a user, then export Playwright `storageState` (including the httpOnly `__Secure-next-auth.session-token`) to `.local-auth/{slug}.storageState.json`

```bash
# throwaway key (default) — mints a brand-new empty user, harmless
node scripts/dev/siwe-login.mjs https://poly-test.cognidao.org --slug candidate-a-poly

# prod works identically
node scripts/dev/siwe-login.mjs https://poly.cognidao.org --slug prod-poly

# re-login as a specific (agent-owned) wallet
node scripts/dev/siwe-login.mjs https://poly-test.cognidao.org --slug candidate-a-poly --pk 0x<private-key>

# viem is an app/ workspace dep; if this checkout has no node_modules, point at one that does
SIWE_VIEM_DIR=/path/to/installed-checkout/app node scripts/dev/siwe-login.mjs ...
```

Prints `userId` + `walletAddress` on success. The generated private key is never persisted — a throwaway session authenticates a fresh empty user, which is exactly what page-rendering / API-shape validation needs. For flows that require a *specific* human-owned account (funded wallet, admin/approver), use the MetaMask fallback below or `--pk` with an agent-owned key from a secrets store. **Never commit keys or storageState — `.local-auth/` is gitignored.**

Then drive the authed page with `playwright-cli`:

```bash
playwright-cli -s=validate open
playwright-cli -s=validate state-load .local-auth/candidate-a-poly.storageState.json
playwright-cli -s=validate goto https://poly-test.cognidao.org/research
playwright-cli -s=validate snapshot
playwright-cli -s=validate network   # lists the /api/v1/poly/* calls the page fired
playwright-cli -s=validate close
```

> **bug.5059 verdict (measured 2026-10-05, playwright-cli 1.59.0-alpha-1771104257000):** `state-load` does **NOT** drop httpOnly cookies anymore — all three httpOnly NextAuth cookies (incl. the session token) survived load and the research page rendered authenticated. If a future playwright-cli regresses, the workaround is to inject the session cookie explicitly: `playwright-cli cookie-set __Secure-next-auth.session-token <value> --domain=<host> --httpOnly --secure`, or `context.addCookies(state.cookies)` from a `@playwright/test` script.

Everything below is the **fallback** path for sessions that must belong to a human-owned MetaMask account.

## Why this exists

Playwright launches a fresh Chromium profile with no extensions — MetaMask and other wallet extensions therefore do not work in the normal `browser.newContext()` flow. Work around it by launching **a dedicated Chrome profile** (with MetaMask installed), signing in once, then exporting the resulting session cookies via CDP attach. Future Playwright runs load the exported `storageState.json` and are authenticated without needing a wallet at all.

The session cookie is the auth artifact. MetaMask only participates in the _first_ signin to mint the cookie.

## Why a dedicated profile (not your default Chrome)

Chrome 136+ **disables** `--remote-debugging-port` when launched against the default user data dir, as a security mitigation (default profile cookies are an attractive target for malware using CDP). A dedicated profile dir bypasses this cleanly. One-time MetaMask install into the new profile is the only setup cost.

## Storage layout (in repo, gitignored)

```
.local-auth/
  chrome-profile/                          # dedicated Chrome user data dir (MetaMask lives here)
  credentials.md                           # MetaMask password + recovery phrase (test wallet only)
  candidate-a-<node>.storageState.json     # <node>-test.cognidao.org
  ...
```

`.local-auth` lives in the node's **main workspace checkout**; Conductor worktree spawns symlink it in via `scripts/conductor-worktree-setup.sh`. Root `.gitignore` excludes the entire `.local-auth` directory. Never commit — these files hold live session cookies, and the profile dir holds the MetaMask vault.

> **Future state:** this whole stack is a crawl-step MVP wedge. Long-term it should be:
>
> - test wallet seed in a secrets manager (1Password CLI / Doppler), not a gitignored markdown file
> - Chrome profile under `~/.cogni-auth/chrome-profile/` (or OS-equivalent), not in-repo (profile is hundreds of MB and shared across worktrees)
> - first-class commands `pnpm auth:capture <env>` + `pnpm auth:verify <env>` driven by the node × env matrix

## One-time setup (per laptop)

1. **Quit all Chrome windows** (⌘Q). Verify nothing is running: `pgrep -lf "Google Chrome"` should be empty.
2. Launch Chrome pointed at the dedicated profile, with CDP enabled:

   ```bash
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
     --remote-debugging-port=9222 \
     --user-data-dir="$PWD/.local-auth/chrome-profile"
   ```

   Keep that terminal tab open — closing it kills Chrome.

3. **Install MetaMask** into this profile:
   - **Skip / reject every Google sign-in prompt.** Don't sign into Chrome with a Google account, don't enable sync, dismiss any "Turn on sync" banners. This profile is a throwaway test rig — signing in pollutes it with your real identity and defeats the isolation.
   - Go to `https://chrome.google.com/webstore/detail/metamask/nkbihfbeogaeaoehlefnkodbefgpgknn`
   - Click "Add to Chrome"
   - MetaMask setup: choose **Create a new wallet** (preferred) or **Import existing** if you already have a dedicated test seed.
   - **Suggested password:** `cogni-is-the-goat` (low-stakes — this profile is test-only and gitignored). If you pick something else, write it down in `.local-auth/credentials.md` so the next agent/session can unlock.
   - Finish setup. MetaMask shows you a 12-word recovery phrase — **save it into `.local-auth/credentials.md` immediately**. That file is gitignored. Without it, a wiped profile means a lost wallet.
   - **Seed confirmation step:** MetaMask then asks the user to fill in 3 specific word positions (e.g. "2, 5, 8") from a shuffled word pool. The AI agent should read `.local-auth/credentials.md`, map the requested positions to the saved phrase, and tell the user exactly which word goes in each slot. Don't make the user count words manually.
   - Unlock MetaMask.

4. Verify CDP is listening:

   ```bash
   curl -s http://localhost:9222/json/version | jq .Browser
   # -> "Chrome/<version>"
   ```

The profile now persists under `.local-auth/chrome-profile/`. Future launches reuse it — MetaMask stays installed, stays funded with whatever account you imported.

## Per-environment: sign in and capture

1. In the debuggable Chrome, navigate to the target env (e.g. `https://<node>-test.cognidao.org`).
2. Sign-in is typically **2 MetaMask prompts** (up to 4 clicks total):
   - Click "Sign in" / "Connect wallet"
   - MetaMask **Connect** popup → approve the connection
   - Site then issues a SIWE message
   - MetaMask **Sign** popup → sign the message
3. Confirm you're signed in (avatar/account visible, or redirect to an authed page).
4. **Leave that tab open**, then from the repo root:

   ```bash
   node scripts/dev/capture-authed-state.mjs candidate-a-<node> https://<node>-test.cognidao.org
   ```

   Writes `.local-auth/candidate-a-<node>.storageState.json` and prints cookie/domain counts as sanity check.

   > Requires `@playwright/test` (a devDependency of this repo) — the script attaches to your already-running Chrome over CDP, so no `playwright install` browser download is needed.

## Using captured state

Two valid consumers:

**1. Ad-hoc / `/validate-candidate` skill — `playwright-cli`** (preferred for one-off validation runs):

```bash
playwright-cli -s=validate state-load .local-auth/candidate-a-<node>.storageState.json
playwright-cli -s=validate open https://<node>-test.cognidao.org
playwright-cli -s=validate snapshot
playwright-cli -s=validate close
```

**2. Committed Playwright test files — `@playwright/test`** (for code that lives in the repo and runs in CI):

```ts
import { chromium } from "@playwright/test";
import path from "node:path";

const storageState = path.join(
  process.cwd(),
  ".local-auth/candidate-a-<node>.storageState.json"
);

const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState });
const page = await ctx.newPage();
await page.goto("https://<node>-test.cognidao.org");
// already signed in — no MetaMask needed
```

The two paths read the **same JSON schema** — `playwright-cli state-save` and `@playwright/test` `storageState` are interchangeable. Pick by context: validation runs use the CLI (zero artifacts, snapshot-driven); committed tests use the library API.

## Refresh cadence

- Sessions generally persist for days to weeks depending on the env's cookie TTL.
- When an agent run hits "unauthenticated", re-run the sign-in + capture flow. MetaMask is only needed to re-mint the cookie.
- Clearing `.local-auth/chrome-profile/` wipes MetaMask — you'd have to re-import the seed phrase.

## Troubleshooting

- **`curl localhost:9222` refused but Chrome is running:** you pointed `--user-data-dir` at the default profile. Chrome 136+ blocks CDP there. Use `.local-auth/chrome-profile/` as shown.
- **Still refused with dedicated profile:** another Chrome instance is holding the profile lock. Run `pgrep -lf "Google Chrome"`, kill stragglers, retry.
- **MetaMask popup doesn't appear on signin:** unlock the extension (click the fox icon, enter password). Extensions stay locked across Chrome restarts.
- **Captured state has no cookies for the expected domain:** you signed in before the capture script could see the tab. Make sure the tab is still open at the target URL when you run the script.
- **Playwright runs but site redirects to signin:** cookie expired — recapture. _Or:_ the site stores auth in `localStorage` rather than cookies, and CDP-attach export reports `origins: 0`. In that case the captured `storageState.json` is insufficient; a dedicated Playwright authfile step (using `browser.newContext({ storageState })` against a Playwright-launched browser + manual signin inside Playwright) may be needed. Tracked as a known gap — update this guide when resolved.

## Done for the session — getting back to your normal browser

When you're finished capturing state:

1. **Fully quit** the debuggable Chrome window: ⌘Q inside that window (closing via the red dot does not quit the process). The agent can also kill it by PID: `pgrep -f "remote-debugging-port" | xargs kill`.
2. Open Chrome normally from Applications / Spotlight / Dock — it launches with your real default profile (bookmarks, extensions, history all there).

Notes:

- The macOS "default browser" setting is **app-level**, not profile-level. If macOS prompted "Make Chrome your default browser" when the debug profile launched, nothing meaningful changed — Chrome-the-app is still the default either way.
- You **can run both at once**: the debug profile and your normal profile coexist as separate Chrome processes because they point at different `--user-data-dir`s. Launch one with the debug flag + `.local-auth/chrome-profile/`, open the other from the Dock. The only conflict is two processes sharing one profile dir (Chrome refuses that with a lock-file error). When both are running, macOS may open new-window link clicks in whichever Chrome launched most recently — keep that in mind while automating.

## Scope / non-goals

- Per-developer primitive. Multi-tenant / credential-broker flows for production agents are tracked separately.
- Headless capture is now the primary path (see top section) — the interactive MetaMask flow remains only for human-owned accounts.
- Not for CI — CI uses API-key or service-account auth, not SIWE.
