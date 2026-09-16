"use client";

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/components/ExecuteDistributionPanel`
 * Purpose: Node-owner LATEST-GLOBAL-SETTLEMENT publish surface. Publishing is
 *   a SINGLE clean action — once the node is set up, a settlement publishes in one transaction with NO
 *   vote: the wallet calls the DAO DIRECTLY, `DAO.execute(callId, [mint, setMerkleRoot], 0)`. There is
 *   no authorize step here — the one-time SCOPED grant lives on the canonical Cogni Operator node
 *   page. This child-node panel only PUBLISHES.
 * Scope: Client component. Fetch the publish payload (useExecuteDistribution) + read hasPermission
 *   (useHasExecutePermission) → wagmi useWriteContract. Connect-wallet + chain(chainId) gating, mint +
 *   root preview, tx hash + explorer link, success state. Does NOT perform DB access; the fold/worker
 *   NEVER sends these txs — this surface serves what R3 built and the wallet publishes.
 * Invariants:
 *   - PUBLISH_IS_DIRECT_EXECUTE: per-epoch publish is DAO.execute([mint,setRoot],0) — a direct call,
 *     one transaction, no vote; labeled as such. Never called a "proposal".
 *   - SETUP_GATES_PUBLISH: read DAO.hasPermission(DAO, wallet, EXECUTE_PERMISSION, <probe>). NOT granted ⇒
 *     do NOT offer authorize here; show a quiet "finish distribution setup" notice. Granted ⇒ the single
 *     publish button. The authorize governance step lives in Operator setup, never here.
 *   - TWO_ACTIONS_ORDERED: [0] token.mint(distributor, mintDelta) then [1] distributor.setMerkleRoot(root),
 *     both run as msg.sender=DAO (DAO holds MINT + owns the distributor).
 *   - ALL_MATH_BIGINT: mintDelta stays bigint (BigInt(payload.mintDelta)); formatted only at display.
 *   - VERIFIED_ABI: execute/hasPermission use DAO_ABI (Aragon OSx v1.3 IDAO).
 *   - PUBLIC_NO_SECRETS: all inputs come from the authed payload route + the connected wallet.
 * Side-effects: blockchain writes (direct DAO.execute tx).
 * Links: src/features/governance/hooks/useExecuteDistribution.ts,
 *   src/features/governance/lib/proposal-abis.ts,
 *   packages/cogni-contracts/src/cumulative-merkle-distributor/abi.ts
 * @public
 */

import { CUMULATIVE_MERKLE_DISTRIBUTOR_ABI } from "@cogni/cogni-contracts";
import { getTransactionExplorerUrl } from "@cogni/node-shared";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { encodeFunctionData, parseAbi } from "viem";
import {
  useAccount,
  useChainId,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  WalletConnectButton,
} from "@/components";
import {
  type ExecuteDistributionPayload,
  useExecuteDistribution,
  useHasExecutePermission,
} from "@/features/governance/hooks/useExecuteDistribution";
import { DAO_ABI } from "@/features/governance/lib/proposal-abis";
import { getChainName } from "@/features/governance/lib/proposal-utils";

/** Minimal GovernanceERC20 mint ABI (DAO holds MINT_PERMISSION on the token). */
const TOKEN_MINT_ABI = parseAbi(["function mint(address to, uint256 amount)"]);
/** Distributor view for the publish idempotency guard (is this root already live?). */
const DISTRIBUTOR_MERKLE_ROOT_ABI = parseAbi([
  "function merkleRoot() view returns (bytes32)",
]);

export function ExecuteDistributionPanel({
  epochId,
  operatorSetupUrl,
  onConfirmed,
}: {
  /** Finalized epoch id (decimal string). */
  epochId: string;
  /** Canonical operator-owned one-time setup surface for this node. */
  operatorSetupUrl: string;
  /** Optional workspace-level terminal feedback that survives lifecycle advancement. */
  onConfirmed?: (explorerUrl: string) => void;
}) {
  const { payload, notReady, isLoading, error } =
    useExecuteDistribution(epochId);
  const [confirmedExplorerUrl, setConfirmedExplorerUrl] = useState<
    string | null
  >(null);
  const handleConfirmed = useCallback(
    (explorerUrl: string) => {
      setConfirmedExplorerUrl(explorerUrl);
      onConfirmed?.(explorerUrl);
    },
    [onConfirmed]
  );

  return (
    <Card className="border-border/50 bg-card/50">
      <CardHeader>
        <CardTitle>Publish latest settlement</CardTitle>
        <CardDescription>
          Put the latest global settlement on-chain so every proven allocation
          can be claimed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {confirmedExplorerUrl ? (
          <Alert>
            <AlertTitle>Latest settlement published</AlertTitle>
            <AlertDescription>
              The transaction is confirmed.{" "}
              <TxLink url={confirmedExplorerUrl}>View transaction</TxLink>
            </AlertDescription>
          </Alert>
        ) : isLoading ? (
          <p className="text-muted-foreground text-sm">
            Loading distribution payload&hellip;
          </p>
        ) : error ? (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t load the distribution</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        ) : notReady || !payload ? (
          <NotReadyNotice
            reason={notReady}
            operatorSetupUrl={operatorSetupUrl}
          />
        ) : (
          <PublishBody
            payload={payload}
            operatorSetupUrl={operatorSetupUrl}
            onConfirmed={handleConfirmed}
          />
        )}
      </CardContent>
    </Card>
  );
}

function NotReadyNotice({
  reason,
  operatorSetupUrl,
}: {
  reason: string | null;
  operatorSetupUrl: string;
}) {
  if (
    reason === "distributor_not_recorded" ||
    reason === "node_missing_governance"
  ) {
    return (
      <OperatorSetupNotice
        operatorSetupUrl={operatorSetupUrl}
        body="This node’s DAO distribution contracts are not fully configured in the app yet."
      />
    );
  }

  const copy: Record<string, { title: string; body: string }> = {
    epoch_not_finalized: {
      title: "Epoch not finalized yet",
      body: "Finalize the selected epoch before publishing the latest global settlement.",
    },
    no_settlement_revision: {
      title: "No settlement built yet",
      body: "No wallet-resolved global settlement is ready to publish yet.",
    },
    negative_mint_delta: {
      title: "Nothing to mint",
      body: "The new cumulative total does not increase over the live distribution.",
    },
    live_root_unavailable: {
      title: "Can’t verify the live distribution",
      body: "The chain root is temporarily unavailable. Publishing is paused to protect token supply.",
    },
    live_root_unknown: {
      title: "Live distribution needs reconciliation",
      body: "The on-chain root isn't present in this node's settlement history.",
    },
    live_root_not_ancestor: {
      title: "Settlement history diverged",
      body: "The newest settlement does not descend from the live on-chain root.",
    },
    already_published: {
      title: "Published",
      body: "The newest settlement root is already live on-chain.",
    },
  };
  const { title, body } = copy[reason ?? ""] ?? {
    title: "Not ready to execute",
    body: "This distribution can't be executed yet.",
  };
  return (
    <Alert>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{body}</AlertDescription>
    </Alert>
  );
}

/**
 * Publish body. Reads the wallet's on-chain EXECUTE_PERMISSION and gates:
 * NOT authorized ⇒ a quiet "finish setup" notice (this panel never offers the authorize governance
 * step); authorized ⇒ the per-epoch direct `DAO.execute` publish. Connect-wallet + chain gating live here.
 */
function PublishBody({
  payload,
  operatorSetupUrl,
  onConfirmed,
}: {
  payload: ExecuteDistributionPayload;
  operatorSetupUrl: string;
  onConfirmed: (explorerUrl: string) => void;
}) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();

  const mintDelta = useMemo(
    () => BigInt(payload.mintDelta),
    [payload.mintDelta]
  );
  const isCorrectChain = chainId === payload.chainId;
  const chainName = getChainName(payload.chainId);

  // SETUP_GATES_PUBLISH: does the connected wallet already hold scoped EXECUTE_PERMISSION on the
  // DAO? Probed with token + distributor so the scoped condition evaluates a real publish shape.
  const { hasPermission, isLoading: isPermLoading } = useHasExecutePermission({
    daoAddress: payload.daoAddress,
    wallet: address,
    tokenAddress: payload.tokenAddress,
    distributorAddress: payload.distributorAddress,
    chainId: payload.chainId,
  });

  if (!isConnected || !address) {
    return (
      <div className="space-y-4">
        <DistributionSummary
          mintDelta={mintDelta}
          merkleRoot={payload.merkleRoot}
          chainName={chainName}
        />
        <div className="space-y-2">
          <p className="text-muted-foreground text-sm">
            Connect the node owner wallet to publish this distribution.
          </p>
          <WalletConnectButton />
        </div>
      </div>
    );
  }

  if (!isCorrectChain) {
    return (
      <div className="space-y-5">
        <DistributionSummary
          mintDelta={mintDelta}
          merkleRoot={payload.merkleRoot}
          chainName={chainName}
        />
        <Button
          variant="outline"
          onClick={() => switchChain?.({ chainId: payload.chainId })}
        >
          Switch to {chainName}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <DistributionSummary
        mintDelta={mintDelta}
        merkleRoot={payload.merkleRoot}
        chainName={chainName}
      />

      {hasPermission === undefined ? (
        <p className="text-muted-foreground text-sm">
          {isPermLoading
            ? "Checking your publish authority…"
            : "Reading your publish authority…"}
        </p>
      ) : hasPermission ? (
        <PublishStep
          payload={payload}
          mintDelta={mintDelta}
          address={address}
          chainName={chainName}
          onConfirmed={onConfirmed}
        />
      ) : (
        <OperatorSetupNotice
          operatorSetupUrl={operatorSetupUrl}
          body="This wallet does not have the strict on-chain authority required to publish this node’s distributions."
        />
      )}
    </div>
  );
}

/**
 * Quiet notice shown when the wallet is NOT yet authorized to publish. The authorize governance step
 * is deliberately NOT offered here — it belongs to the operator-owned one-time distribution setup.
 */
function OperatorSetupNotice({
  operatorSetupUrl,
  body,
}: {
  operatorSetupUrl: string;
  body: string;
}) {
  return (
    <Alert>
      <AlertTitle>Finish distribution setup in Cogni Operator</AlertTitle>
      <AlertDescription>
        {body} Complete the one-time setup on the canonical operator node page.{" "}
        <Link
          href={operatorSetupUrl}
          target="_blank"
          rel="noreferrer"
          className="hover:text-foreground underline transition-colors"
        >
          Open Cogni Operator →
        </Link>
      </AlertDescription>
    </Alert>
  );
}

/**
 * PER-EPOCH PUBLISH — a direct execute, NO vote. Calls the DAO directly:
 *   DAO.execute(callId, [mint(distributor, delta), setMerkleRoot(root)], 0)
 * runnable because the wallet holds EXECUTE_PERMISSION. Both actions run as msg.sender=DAO.
 */
function PublishStep({
  payload,
  mintDelta,
  address,
  chainName,
  onConfirmed,
}: {
  payload: ExecuteDistributionPayload;
  mintDelta: bigint;
  address: `0x${string}`;
  chainName: string;
  onConfirmed: (explorerUrl: string) => void;
}) {
  const queryClient = useQueryClient();
  const refetchedConfirmation = useRef(false);
  const {
    writeContract,
    isPending,
    error: writeError,
    data: txHash,
  } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash });

  // IDEMPOTENCY GUARD (bug: a re-publish re-minted the delta into the distributor). Read the
  // distributor's LIVE merkle root; if it already equals this epoch's root, the epoch is already
  // published — minting again would strand tokens with no matching claim. Never emit the tx.
  const { data: onChainRoot, refetch: refetchOnChainRoot } = useReadContract({
    abi: DISTRIBUTOR_MERKLE_ROOT_ABI,
    address: payload.distributorAddress,
    functionName: "merkleRoot",
    chainId: payload.chainId,
  });
  const alreadyPublished =
    typeof onChainRoot === "string" &&
    onChainRoot.toLowerCase() === payload.merkleRoot.toLowerCase();
  // A zero delta means there is nothing new to mint — publishing would only re-set the root.
  const nothingToMint = mintDelta === 0n;
  const published = alreadyPublished || isConfirmed;

  const explorerUrl = txHash
    ? getTransactionExplorerUrl(payload.chainId, txHash)
    : null;

  useEffect(() => {
    if (!isConfirmed || !explorerUrl || refetchedConfirmation.current) return;
    refetchedConfirmation.current = true;
    onConfirmed(explorerUrl);
    void (async () => {
      try {
        await Promise.all([
          refetchOnChainRoot(),
          queryClient.refetchQueries({
            queryKey: [
              "governance",
              "execute-distribution",
              payload.epochId,
            ],
          }),
        ]);
        await queryClient.refetchQueries({
          queryKey: ["governance", "finish-epoch"],
        });
      } catch {
        await queryClient.invalidateQueries({
          queryKey: ["governance", "finish-epoch"],
        });
      }
    })().catch(() => undefined);
  }, [
    explorerUrl,
    isConfirmed,
    onConfirmed,
    payload.epochId,
    queryClient,
    refetchOnChainRoot,
  ]);

  // TWO_ACTIONS_ORDERED: [0] mint the delta into the distributor, then [1] set the
  // new cumulative root. Built identically to before; run as msg.sender=DAO on execute.
  const actions = useMemo(() => {
    const mintData = encodeFunctionData({
      abi: TOKEN_MINT_ABI,
      functionName: "mint",
      args: [payload.distributorAddress, mintDelta],
    });
    const setRootData = encodeFunctionData({
      abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
      functionName: "setMerkleRoot",
      args: [payload.merkleRoot],
    });
    return [
      { to: payload.tokenAddress, value: 0n, data: mintData },
      { to: payload.distributorAddress, value: 0n, data: setRootData },
    ] as const;
  }, [payload, mintDelta]);

  const onPublish = useCallback(() => {
    // PUBLISH_IS_DIRECT_EXECUTE: no proposal, no vote — a single DAO.execute call.
    writeContract({
      abi: DAO_ABI,
      address: payload.daoAddress,
      functionName: "execute",
      // CAS V2: callId is the server-observed root that MUST still be live when the DAO
      // evaluates permission. A concurrent/stale publish is denied before mint executes.
      args: [payload.alreadyExecutedRoot, actions, 0n],
      account: address,
    });
  }, [
    actions,
    address,
    payload.daoAddress,
    payload.alreadyExecutedRoot,
    writeContract,
  ]);

  // Already live on-chain (this session or a prior one) → terminal state, no button.
  if (published) {
    return (
      <Alert>
        <AlertTitle>Published</AlertTitle>
        <AlertDescription>
          The latest global settlement is live on {chainName}.{" "}
          {explorerUrl && <TxLink url={explorerUrl}>View transaction</TxLink>}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <Button
        onClick={onPublish}
        disabled={isPending || isConfirming || nothingToMint}
      >
        {isPending
          ? "Confirm in wallet…"
          : isConfirming
            ? "Publishing…"
            : "Publish latest settlement"}
      </Button>

      {nothingToMint ? (
        <p className="text-muted-foreground text-sm">
          Nothing to mint for the latest settlement (zero delta).
        </p>
      ) : null}

      {explorerUrl && (isPending || isConfirming) && (
        <p className="text-muted-foreground text-sm">
          <TxLink url={explorerUrl}>View transaction</TxLink>
        </p>
      )}

      <WriteErrorAlert error={writeError} title="Publish failed" />
    </div>
  );
}

/** Shared Basescan/explorer link. */
function TxLink({ url, children }: { url: string; children: ReactNode }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:text-foreground underline transition-colors"
    >
      {children}
    </a>
  );
}

/** Shared write-error alert with friendly copy for the common wallet failures. */
function WriteErrorAlert({
  error,
  title,
}: {
  error: Error | null;
  title: string;
}) {
  if (!error) return null;
  const message = error.message?.includes("User rejected")
    ? "Transaction cancelled."
    : error.message?.includes("insufficient funds")
      ? "Insufficient funds for gas."
      : (error.message ?? "Unknown error");
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function DistributionSummary({
  mintDelta,
  merkleRoot,
  chainName,
}: {
  mintDelta: bigint;
  merkleRoot: string;
  chainName: string;
}) {
  return (
    <div className="border-border rounded-lg border p-5">
      <p className="text-muted-foreground text-sm">
        Minting for the latest settlement
      </p>
      <p className="text-2xl font-bold tracking-tight">
        {formatAmount(mintDelta)}
      </p>
      <dl className="text-muted-foreground mt-3 space-y-1 text-sm">
        <div className="flex justify-between gap-4">
          <dt>New claim root</dt>
          <dd className="truncate font-mono" title={merkleRoot}>
            {shortenHash(merkleRoot)}
          </dd>
        </div>
        {chainName && (
          <div className="flex justify-between gap-4">
            <dt>Network</dt>
            <dd>{chainName}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/** Format an 18-decimal base-unit amount for display, trimming trailing zeros. */
function formatAmount(base: bigint): string {
  const DECIMALS = 18n;
  const divisor = 10n ** DECIMALS;
  const whole = base / divisor;
  const frac = base % divisor;
  if (frac === 0n) return `${whole.toLocaleString()} tokens`;
  const fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
  return `${whole.toLocaleString()}.${fracStr.slice(0, 4)} tokens`;
}

/** 0x1234…abcd for a 32-byte hash. */
function shortenHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
}
