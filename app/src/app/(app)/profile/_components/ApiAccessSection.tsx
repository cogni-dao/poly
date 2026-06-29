// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/profile/_components/ApiAccessSection`
 * Purpose: Profile-page section that surfaces the calling user's tenant ids and lets them mint a one-time-reveal agent bearer.
 *   Pairs with the new `/api/v1/agent/keys` + `/api/v1/users/me/account` routes;
 *   gives a logged-in human a path to bearer + billing_account_id without DB-poking.
 * Scope: Client component; does not server-render keys, persist secrets to storage, or list prior keys.
 *   Renders identifiers + mint button + modal. Self-fetches `/users/me/account` via SWR-on-mount.
 * Invariants: ONE_TIME_REVEAL_UI — minted key lives only in React state of the modal; cleared on
 *   dismiss/route-change/refresh. No localStorage / sessionStorage / cookie writes.
 * Side-effects: IO (fetch to two endpoints; clipboard write on user click).
 * Links: nodes/poly/app/src/app/api/v1/agent/keys/route.ts · nodes/poly/app/src/app/api/v1/users/me/account/route.ts
 * @public
 */

"use client";

import { Copy } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components";

type Account = {
  userId: string;
  billingAccountId: string;
  displayName: string | null;
};

type MintedKey = {
  apiKey: string;
  issuedAt: string;
};

function CopyableId({
  label,
  value,
}: {
  label: string;
  value: string | null;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = useCallback((): void => {
    if (!value) return;
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="font-medium text-foreground text-sm">{label}</div>
      <div className="flex items-center gap-2">
        <span className="rounded-md border border-input bg-background px-3 py-1.5 font-mono text-foreground text-xs">
          {value ?? "—"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={!value}
          onClick={copy}
          aria-label={`Copy ${label}`}
        >
          <Copy className="size-4" />
          <span className="sr-only">Copy</span>
        </Button>
        {copied ? (
          <span className="text-muted-foreground text-xs">copied</span>
        ) : null}
      </div>
    </div>
  );
}

function ApiKeyRevealDialog({
  minted,
  onDismiss,
}: {
  minted: MintedKey | null;
  onDismiss: () => void;
}): ReactElement {
  const [copied, setCopied] = useState(false);

  // ONE_TIME_REVEAL_UI: clear local copy-flag whenever the underlying key
  // changes or is cleared. The minted key itself is held in the parent's
  // state and cleared via onDismiss(); we never persist it.
  useEffect(() => {
    setCopied(false);
  }, []);

  const copy = useCallback((): void => {
    if (!minted) return;
    navigator.clipboard.writeText(minted.apiKey).then(() => {
      setCopied(true);
    });
  }, [minted]);

  return (
    <Dialog
      open={minted !== null}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New API key</DialogTitle>
          <DialogDescription>
            Copy this key now. For your security, it won't be shown again. Lost
            it? Generate a new one — prior keys remain valid until they expire.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="break-all rounded-md border border-input bg-background p-3 font-mono text-foreground text-xs">
            {minted?.apiKey ?? ""}
          </div>
          <Alert>
            <AlertTitle>Treat this like a password</AlertTitle>
            <AlertDescription>
              Anyone with this key can act as you against the Cogni-poly API.
              Don't paste it into chat threads, screenshots, or public repos.
            </AlertDescription>
          </Alert>
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button onClick={copy} variant="default">
            <Copy className="mr-2 size-4" />
            {copied ? "Copied" : "Copy key"}
          </Button>
          <Button onClick={onDismiss} variant="ghost">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ApiAccessSection(): ReactElement {
  const [account, setAccount] = useState<Account | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintedKey | null>(null);
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const res = await fetch("/api/v1/users/me/account", {
          credentials: "include",
        });
        if (!res.ok) {
          if (!cancelled) setLoadError(`Failed to load (${res.status})`);
          return;
        }
        const data = (await res.json()) as Account;
        if (!cancelled) setAccount(data);
      } catch {
        if (!cancelled) setLoadError("Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const generate = useCallback(async (): Promise<void> => {
    setMintError(null);
    setMinting(true);
    try {
      const res = await fetch("/api/v1/agent/keys", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        setMintError(body.message ?? body.error ?? `Error ${res.status}`);
        return;
      }
      const data = (await res.json()) as MintedKey;
      setMinted(data);
    } catch {
      setMintError("Failed to mint key");
    } finally {
      setMinting(false);
    }
  }, []);

  return (
    <>
      <CopyableId label="User ID" value={account?.userId ?? null} />
      <CopyableId
        label="Billing Account ID"
        value={account?.billingAccountId ?? null}
      />
      {loadError ? (
        <p className="py-2 text-destructive text-xs">{loadError}</p>
      ) : null}
      <div className="flex items-center justify-between gap-4 py-2">
        <div>
          <div className="font-medium text-foreground text-sm">API Key</div>
          <div className="mt-1 text-muted-foreground text-xs">
            Generate a bearer token to authenticate scripts and agents. Shown
            once.
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={minting || !account}
          onClick={generate}
        >
          {minting ? "Generating…" : "Generate API key"}
        </Button>
      </div>
      {mintError ? (
        <p className="py-2 text-destructive text-xs">{mintError}</p>
      ) : null}
      <ApiKeyRevealDialog
        minted={minted}
        onDismiss={() => {
          setMinted(null);
        }}
      />
    </>
  );
}
