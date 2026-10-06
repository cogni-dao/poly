#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@scripts/dev/siwe-login`
 * Purpose: Headless SIWE login — mint an authed NextAuth session for any env
 *   without MetaMask or a browser, and export Playwright storageState.
 * Scope: One-off developer/agent helper. Pure node (fetch + viem signing).
 *   Talks only to the target env's /api/auth/* endpoints. Does not connect
 *   wallets, does not trade, does not touch CLOB creds.
 * Invariants:
 *   - Default key is a freshly generated THROWAWAY (brand-new empty user).
 *     The private key is never written to disk; `--pk` holders manage their own.
 *   - Output goes only to `.local-auth/` (gitignored).
 *   - Server contract (app/src/auth.ts, provider id "credentials"):
 *     nonce MUST equal the NextAuth CSRF token, domain MUST equal the host of
 *     the server's NEXTAUTH_URL, callback endpoint is
 *     /api/auth/callback/credentials (form-encoded message+signature+csrfToken).
 * Side-effects: IO (HTTPS to target env; writes one JSON file under .local-auth/).
 * Usage:
 *   node scripts/dev/siwe-login.mjs <base-url> [--slug name] [--pk 0x...] [--chain-id 8453]
 *   node scripts/dev/siwe-login.mjs https://poly-test.cognidao.org --slug candidate-a-poly
 * Links: docs/guides/candidate-auth-bootstrap.md, app/src/auth.ts
 * @internal
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const positional = [];
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    flags[a.slice(2)] = argv[i + 1];
    i++;
  } else {
    positional.push(a);
  }
}
const baseUrl = positional[0];
if (!baseUrl) {
  console.error(
    "Usage: node scripts/dev/siwe-login.mjs <base-url> [--slug name] [--pk 0x...] [--chain-id 8453]"
  );
  process.exit(1);
}
const base = new URL(baseUrl);
const origin = base.origin;
const chainId = Number(flags["chain-id"] ?? 8453); // app's active chain is BASE (packages/node-shared web3/chain.ts)
const slug = flags.slug ?? base.hostname.replaceAll(".", "-");

// ---------------------------------------------------------------------------
// viem resolution — viem is an `app/` workspace dependency, not a root one.
// Resolve it from (in order): $SIWE_VIEM_DIR, this repo's app/, cwd's app/, cwd.
// ---------------------------------------------------------------------------
async function loadViemAccounts() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.SIWE_VIEM_DIR,
    path.resolve(here, "..", "..", "app"),
    path.resolve(process.cwd(), "app"),
    process.cwd(),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      const req = createRequire(path.join(dir, "package.json"));
      const entry = req.resolve("viem/accounts");
      const mod = await import(pathToFileURL(entry).href);
      const api = mod.privateKeyToAccount ? mod : (mod.default ?? mod);
      if (api.privateKeyToAccount) return api;
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    "Could not resolve `viem` — run from a checkout with app/ deps installed, or set SIWE_VIEM_DIR=/path/to/dir-with-node_modules"
  );
}

// ---------------------------------------------------------------------------
// minimal cookie jar (name -> {value, attrs}) built from Set-Cookie headers
// ---------------------------------------------------------------------------
const jar = new Map();

function absorbSetCookies(res) {
  for (const raw of res.headers.getSetCookie()) {
    const [pair, ...attrParts] = raw.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const attrs = {};
    for (const p of attrParts) {
      const [k, v] = p.split("=");
      attrs[k.trim().toLowerCase()] = v?.trim() ?? true;
    }
    if (attrs["max-age"] === "0" || value === "") jar.delete(name);
    else jar.set(name, { value, attrs });
  }
}

function cookieHeader() {
  return [...jar.entries()].map(([n, c]) => `${n}=${c.value}`).join("; ");
}

async function fetchWithJar(url, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (jar.size > 0) headers.cookie = cookieHeader();
  const res = await fetch(url, { ...init, headers, redirect: "manual" });
  absorbSetCookies(res);
  return res;
}

// ---------------------------------------------------------------------------
// EIP-4361 message (exact ABNF layout — server parses with `new SiweMessage(str)`)
// ---------------------------------------------------------------------------
function buildSiweMessage({ domain, address, statement, uri, chainId, nonce, issuedAt }) {
  return (
    `${domain} wants you to sign in with your Ethereum account:\n` +
    `${address}\n` +
    `\n` +
    `${statement}\n` +
    `\n` +
    `URI: ${uri}\n` +
    `Version: 1\n` +
    `Chain ID: ${chainId}\n` +
    `Nonce: ${nonce}\n` +
    `Issued At: ${issuedAt}`
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const { generatePrivateKey, privateKeyToAccount } = await loadViemAccounts();

const pk = flags.pk ?? generatePrivateKey();
if (!flags.pk) {
  console.log("Generated THROWAWAY key (not persisted anywhere). Fresh empty user.");
}
const account = privateKeyToAccount(pk);
console.log(`Address:  ${account.address}`);
console.log(`Target:   ${origin} (chainId ${chainId})`);

// 1. CSRF token — the SIWE nonce. Cookie must travel with the callback POST.
const csrfRes = await fetchWithJar(`${origin}/api/auth/csrf`);
if (!csrfRes.ok) {
  console.error(`GET /api/auth/csrf failed: ${csrfRes.status}`);
  process.exit(2);
}
const { csrfToken } = await csrfRes.json();
if (!csrfToken) {
  console.error("No csrfToken in /api/auth/csrf response");
  process.exit(2);
}

// 2. Build + sign the SIWE message. domain must match the server's NEXTAUTH_URL host.
const message = buildSiweMessage({
  domain: base.host,
  address: account.address,
  statement: "Sign in with Ethereum to the app.",
  uri: origin,
  chainId,
  nonce: csrfToken,
  issuedAt: new Date().toISOString(),
});
const signature = await account.signMessage({ message });

// 3. Callback — provider id is "credentials" (app/src/auth.ts:149).
const body = new URLSearchParams({
  message,
  signature,
  csrfToken,
  callbackUrl: `${origin}/`,
  json: "true",
});
const cbRes = await fetchWithJar(`${origin}/api/auth/callback/credentials`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: body.toString(),
});
const cbText = await cbRes.text();
let cbUrl = "";
try {
  cbUrl = JSON.parse(cbText).url ?? "";
} catch {
  // 302 flows have no JSON body — fall back to Location
  cbUrl = cbRes.headers.get("location") ?? "";
}
const sessionCookieName = [...jar.keys()].find((n) => n.includes("session-token"));
if (!sessionCookieName || /error=/i.test(cbUrl)) {
  console.error(`SIWE callback rejected (status ${cbRes.status}, url=${cbUrl || "<none>"})`);
  console.error("Check: domain vs NEXTAUTH_URL host, nonce freshness, provider id.");
  process.exit(3);
}

// 4. Prove the session server-side.
const sessRes = await fetchWithJar(`${origin}/api/auth/session`);
const session = await sessRes.json().catch(() => ({}));
const user = session?.user;
if (!user) {
  console.error(`GET /api/auth/session returned no user: ${JSON.stringify(session)}`);
  process.exit(4);
}
console.log(
  `Session:  userId=${user.id ?? "<n/a>"} walletAddress=${user.walletAddress ?? "<n/a>"}`
);

// 5. Export Playwright storageState (includes the httpOnly session cookie).
const toSameSite = (v) =>
  typeof v === "string"
    ? { lax: "Lax", strict: "Strict", none: "None" }[v.toLowerCase()] ?? "Lax"
    : "Lax";
const cookies = [...jar.entries()].map(([name, c]) => ({
  name,
  value: c.value,
  domain: base.hostname,
  path: c.attrs.path ?? "/",
  expires: c.attrs["max-age"]
    ? Math.floor(Date.now() / 1000) + Number(c.attrs["max-age"])
    : c.attrs.expires
      ? Math.floor(new Date(c.attrs.expires).getTime() / 1000)
      : -1,
  httpOnly: Boolean(c.attrs.httponly),
  secure: Boolean(c.attrs.secure) || name.startsWith("__Secure-") || name.startsWith("__Host-"),
  sameSite: toSameSite(c.attrs.samesite),
}));
const outDir = path.join(process.cwd(), ".local-auth");
const outFile = path.join(outDir, `${slug}.storageState.json`);
await mkdir(outDir, { recursive: true });
await writeFile(outFile, JSON.stringify({ cookies, origins: [] }, null, 2));
console.log(`Saved:    ${outFile}`);
console.log(
  `Cookies:  ${cookies.length} (${cookies.filter((c) => c.httpOnly).length} httpOnly, session=${sessionCookieName})`
);
