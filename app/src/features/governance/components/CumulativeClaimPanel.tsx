"use client";

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/components/CumulativeClaimPanel`
 * Purpose: Wallet-connected panel on /gov/holdings letting the connected wallet claim its CUMULATIVE DAO tokens (all unclaimed epochs at once).
 * Scope: Client component. Connect wallet → useCumulativeClaim (latest manifest leaf + on-chain cumulativeClaimed) → call CumulativeMerkleDrop.claim() via wagmi. Does not perform DB access.
 * Invariants:
 *   - CUMULATIVE_MODEL: claim(account, cumulativeAmount, root, proof) pays cumulativeAmount − cumulativeClaimed. A single claim covers ALL unclaimed epochs.
 *   - HONEST_STATE: after a claim tx confirms, re-read cumulativeClaimed so claimable reflects 0 until the next root.
 *   - ALL_MATH_BIGINT: amounts stay bigint; formatted only at display.
 *   - PUBLIC_NO_SECRETS: all inputs come from the public latest-distribution route + the connected wallet.
 * Side-effects: blockchain read (cumulativeClaimed via hook), blockchain write (claim tx via wallet signing).
 * Links: app/src/features/governance/hooks/useCumulativeClaim.ts, packages/cogni-contracts/src/cumulative-merkle-distributor/abi.ts
 * @public
 */

import { CUMULATIVE_MERKLE_DISTRIBUTOR_ABI } from "@cogni/cogni-contracts";
import { getTransactionExplorerUrl } from "@cogni/node-shared";
import { useCallback, useEffect, useState } from "react";
import {
  useAccount,
  useChainId,
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
import { useCumulativeClaim } from "@/features/governance/hooks/useCumulativeClaim";
import { getChainName } from "@/features/governance/lib/proposal-utils";
import { formatTokenAmount } from "@/features/governance/lib/token-display";

export function CumulativeClaimPanel({
  bare = false,
  tokenAddress = null,
  chainId,
}: {
  /**
   * Render without the outer Card chrome (header/border) — for embedding inside an existing
   * SectionCard (e.g. YourPositionPanel) so the claim UX reads as a flat section, not a card-in-card.
   */
  bare?: boolean;
  /** Public node token identity, so balance remains readable without a claim leaf. */
  tokenAddress?: string | null;
  chainId?: number;
} = {}) {
  const { address, isConnected } = useAccount();

  const body =
    !isConnected || !address ? (
      <div className="space-y-2">
        <p className="text-muted-foreground text-sm">
          Connect your wallet to check what you can claim.
        </p>
        <WalletConnectButton />
      </div>
    ) : (
      <ConnectedClaim
        account={address}
        tokenAddress={tokenAddress}
        configuredChainId={chainId}
      />
    );

  if (bare) {
    return (
      <div className="space-y-3 border-border/50 border-t pt-4">
        <div>
          <p className="font-semibold text-sm">Claim your tokens</p>
          <p className="text-muted-foreground text-sm">
            A single claim releases every unclaimed epoch you&apos;ve earned.
          </p>
        </div>
        {body}
      </div>
    );
  }

  return (
    <Card className="border-border/50 bg-card/50">
      <CardHeader>
        <CardTitle>Claim your tokens</CardTitle>
        <CardDescription>
          A single claim releases every unclaimed epoch you&apos;ve earned.
        </CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

function ConnectedClaim({
  account,
  tokenAddress,
  configuredChainId,
}: {
  account: `0x${string}`;
  tokenAddress: string | null;
  configuredChainId: number | undefined;
}) {
  const {
    claim,
    cumulativeClaimed,
    claimable,
    tokenBalance,
    tokenDecimals,
    isTokenBalanceLoading,
    tokenBalanceError,
    isLoading,
    isClaimedLoading,
    error,
    refetchAfterClaim,
  } = useCumulativeClaim(
    account,
    { kind: "latest" },
    true,
    configuredChainId
      ? { tokenAddress, chainId: configuredChainId }
      : undefined
  );

  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const {
    writeContract,
    isPending,
    error: writeError,
    data: txHash,
  } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash });
  const [refreshState, setRefreshState] = useState<
    "idle" | "refreshing" | "complete"
  >("idle");

  // Confirmation is terminal immediately. Chain reads must both settle before
  // the component can leave the terminal state (a remount starts a fresh read).
  useEffect(() => {
    if (!isConfirmed || refreshState !== "idle") return;
    setRefreshState("refreshing");
    void refetchAfterClaim().finally(() => setRefreshState("complete"));
  }, [isConfirmed, refreshState, refetchAfterClaim]);

  const distributor = (claim?.distributor ?? null) as `0x${string}` | null;
  const isCorrectChain = claim ? chainId === claim.chainId : true;
  const chainName = claim
    ? getChainName(claim.chainId)
    : configuredChainId
      ? getChainName(configuredChainId)
      : "";
  const explorerUrl =
    txHash && claim ? getTransactionExplorerUrl(claim.chainId, txHash) : null;

  const onClaim = useCallback(() => {
    if (!claim || !distributor || !isCorrectChain) return;
    writeContract({
      abi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
      address: distributor,
      functionName: "claim",
      // claim(account, cumulativeAmount, expectedMerkleRoot, merkleProof)
      args: [
        claim.account as `0x${string}`,
        BigInt(claim.amount),
        claim.root as `0x${string}`,
        claim.proof as `0x${string}`[],
      ],
      account,
    });
  }, [claim, distributor, isCorrectChain, writeContract, account]);

  if (isLoading) {
    return (
      <p className="text-muted-foreground text-sm">
        Checking your allocation&hellip;
      </p>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load your claim</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }

  // No leaf for this wallet in the latest manifest → no allocation.
  if (!claim) {
    return (
      <div className="space-y-5">
        <AllocationSummary
          tokenBalance={tokenBalance}
          tokenConfigured={Boolean(tokenAddress)}
          isTokenBalanceLoading={isTokenBalanceLoading}
          tokenBalanceError={tokenBalanceError}
          cumulativeAmount={undefined}
          cumulativeClaimed={undefined}
          claimable={undefined}
          chainName={chainName}
          decimals={tokenDecimals}
        />
        <Alert>
          <AlertTitle>No allocation for this wallet</AlertTitle>
          <AlertDescription>
            Your token balance is shown above, but this wallet has no cumulative
            allocation yet. If you contributed with a different wallet, connect
            that one.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const cumulativeAmount = BigInt(claim.amount);
  const showConfirmed = isConfirmed || refreshState !== "idle";

  return (
    <div className="space-y-5">
      <AllocationSummary
        tokenBalance={tokenBalance}
        tokenConfigured={Boolean(claim.tokenAddress || tokenAddress)}
        isTokenBalanceLoading={isTokenBalanceLoading}
        tokenBalanceError={tokenBalanceError}
        cumulativeAmount={cumulativeAmount}
        cumulativeClaimed={cumulativeClaimed}
        claimable={claimable}
        chainName={chainName}
        decimals={tokenDecimals}
      />

      {showConfirmed ? (
        <Alert>
          <AlertTitle>Tokens claimed</AlertTitle>
          <AlertDescription>
            {refreshState === "refreshing"
              ? "Confirmed. Refreshing your token balance and claimed amount…"
              : `Your claim confirmed on ${chainName}.`}{" "}
            {explorerUrl && (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline transition-colors hover:text-foreground"
              >
                View transaction
              </a>
            )}
          </AlertDescription>
        </Alert>
      ) : !distributor ? (
        <Alert>
          <AlertTitle>Claiming not open yet</AlertTitle>
          <AlertDescription>
            The distribution contract for this node hasn&apos;t been recorded
            yet. Check back once tokens are on-chain.
          </AlertDescription>
        </Alert>
      ) : isClaimedLoading || claimable === undefined ? (
        <p className="text-muted-foreground text-sm">
          Reading on-chain claim state&hellip;
        </p>
      ) : claimable === 0n ? (
        <Alert>
          <AlertTitle>Nothing to claim right now</AlertTitle>
          <AlertDescription>
            You&apos;ve claimed everything allocated to you so far. New tokens
            become claimable when the next cumulative root is published.
          </AlertDescription>
        </Alert>
      ) : !isCorrectChain ? (
        <Button
          variant="outline"
          onClick={() => switchChain?.({ chainId: claim.chainId })}
        >
          Switch to {chainName}
        </Button>
      ) : (
        <>
          <Button onClick={onClaim} disabled={isPending || isConfirming}>
            {isPending
              ? "Confirm in wallet…"
              : isConfirming
                ? "Claiming…"
                : `Claim ${formatTokenAmount(claimable, tokenDecimals)}`}
          </Button>

          {explorerUrl && (isPending || isConfirming) && (
            <p className="text-muted-foreground text-sm">
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline transition-colors hover:text-foreground"
              >
                View transaction
              </a>
            </p>
          )}
        </>
      )}

      {writeError && !showConfirmed && (
        <Alert variant="destructive">
          <AlertTitle>Claim failed</AlertTitle>
          <AlertDescription>
            {writeError.message?.includes("User rejected")
              ? "Transaction cancelled."
              : writeError.message?.includes("insufficient funds")
                ? "Insufficient funds for gas."
                : (writeError.message ?? "Unknown error")}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function AllocationSummary({
  tokenBalance,
  tokenConfigured,
  isTokenBalanceLoading,
  tokenBalanceError,
  cumulativeAmount,
  cumulativeClaimed,
  claimable,
  chainName,
  decimals,
}: {
  tokenBalance: bigint | undefined;
  tokenConfigured: boolean;
  isTokenBalanceLoading: boolean;
  tokenBalanceError: Error | null;
  cumulativeAmount: bigint | undefined;
  cumulativeClaimed: bigint | undefined;
  claimable: bigint | undefined;
  chainName: string;
  decimals: number;
}) {
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-3">
        <PositionMetric
          label="Token balance"
          value={
            !tokenConfigured
              ? "Not configured"
              : isTokenBalanceLoading
                ? "…"
                : tokenBalanceError || tokenBalance === undefined
                  ? "Unavailable"
                  : formatTokenAmount(tokenBalance, decimals)
          }
        />
        <PositionMetric
          label="Claimable now"
          value={
            cumulativeAmount === undefined
              ? "Not available"
              : claimable === undefined
              ? "…"
              : formatTokenAmount(claimable, decimals)
          }
          emphasized
        />
        <PositionMetric
          label="Cumulative entitlement"
          value={
            cumulativeAmount === undefined
              ? "No allocation"
              : formatTokenAmount(cumulativeAmount, decimals)
          }
        />
        <PositionMetric
          label="Already claimed"
          value={
            cumulativeAmount === undefined
              ? "Not available"
              : cumulativeClaimed === undefined
              ? "…"
              : formatTokenAmount(cumulativeClaimed, decimals)
          }
        />
      </dl>
      <dl className="text-muted-foreground text-sm">
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

function PositionMetric({
  label,
  value,
  emphasized = false,
}: {
  label: string;
  value: string;
  emphasized?: boolean;
}) {
  return (
    <div
      className={
        emphasized
          ? "min-w-0 rounded-lg border border-primary/40 bg-primary/5 p-3"
          : "min-w-0 rounded-lg border border-border p-3"
      }
    >
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-1 break-words font-semibold text-foreground text-sm tabular-nums sm:text-base">
        {value}
      </dd>
    </div>
  );
}
