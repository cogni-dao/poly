// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** PAGE_LOAD_DB_ONLY: exact saved metadata, bounded scalar results, no economics. */
import {
  normalizePositionIdentity,
  type PositionIdentityInput,
  type PositionMetadataCandidate,
  type ResolvedPositionMetadata,
  selectPositionMetadata,
} from "@cogni/poly-market-provider";
import { type SQL, sql } from "drizzle-orm";
import { derivePaperAccountAddress } from "@/features/paper-accounts";
import { targetIdFromWallet } from "@/shared/util/poly-target-id";

type Db = { execute(query: SQL): Promise<unknown> };
export type PositionMetadataKey = PositionIdentityInput & {
  walletAddress?: string | null;
  mode?: "live" | "paper";
};

export type PositionMetadataAccountScope = Readonly<{
  billingAccountId: string;
}>;
type MetadataKey = {
  conditionId: string;
  tokenId: string;
  wallet: string | null;
  mode?: "live" | "paper";
};
export type PositionMetadataResolution = ResolvedPositionMetadata & {
  originAvailability: "available" | "unavailable" | "overflow";
};

/** Wallet provenance is part of the lookup; null requests only global venue facts. */
export function positionMetadataRequestKey(
  input: PositionMetadataKey,
  accountScope?: PositionMetadataAccountScope,
): string | null {
  const identity = normalizePositionIdentity(input);
  return identity.availability === "available"
    ? `${identity.key}:${input.walletAddress?.toLowerCase() ?? "global"}:${input.mode ?? "live"}${accountScope ? `:account:${accountScope.billingAccountId}` : ""}`
    : null;
}

type EvidenceRow = {
  condition_id: string;
  token_id: string;
  requested_wallet: string | null;
  requested_mode: "live" | "paper";
  source: string;
  observed_at: string | Date;
  raw: Record<string, unknown> | null;
};

export async function readPositionMetadata(input: {
  db: Db;
  keys: readonly PositionMetadataKey[];
  capturedAt?: string;
  accountScope?: PositionMetadataAccountScope;
}): Promise<Map<string, PositionMetadataResolution>> {
  const keys = input.keys.flatMap((k) => {
    const identity = normalizePositionIdentity(k);
    return identity.availability === "available"
      ? [{ ...identity, wallet: k.walletAddress?.toLowerCase() ?? null, mode: k.mode ?? "live" }]
      : [];
  });
  const unique = [
    ...new Map(
      keys.map((k) => [`${k.key}:${k.wallet ?? "global"}:${k.mode}`, k]),
    ).values(),
  ];
  const out = new Map<string, PositionMetadataResolution>();
  // Batch size bounds SQL parameters and memory, never truncates requested keys.
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100);
    const accountId = input.accountScope?.billingAccountId;
    const ownPaperWallet = accountId
      ? derivePaperAccountAddress(accountId)
      : null;
    const originKeys = accountId
      ? batch.filter((k) => k.mode === "paper" && k.wallet === ownPaperWallet)
      : [];
    const descriptors =
      originKeys.length && accountId
        ? resultRows<OriginDescriptor>(
            await input.db.execute(
              positionMetadataOriginSelect(
                originKeys,
                accountId,
                input.capturedAt,
              ),
            ),
          )
        : [];
    const verified: OriginDescriptor[] = [];
    const overflowed = new Set<string>();
    for (const key of originKeys) {
      const matching = descriptors.filter(
        (r) =>
          r.condition_id === key.conditionId &&
          r.token_id === key.tokenId &&
          r.requested_wallet === key.wallet,
      );
      const requestKey =
        positionMetadataRequestKey(
          { ...key, walletAddress: key.wallet },
          input.accountScope,
        ) ?? "";
      if (matching.length > ORIGIN_CANDIDATE_LIMIT) {
        overflowed.add(requestKey);
        continue;
      }
      const eligible = matching.filter(
        (r) =>
          r.billing_account_id === accountId &&
          r.mode === key.mode &&
          r.market_id === `prediction-market:polymarket:${key.conditionId}` &&
          r.ledger_condition_id?.toLowerCase() === key.conditionId &&
          r.ledger_token_id === key.tokenId &&
          r.order_id !== null &&
          r.order_id.length > 0 &&
          r.connection_proof &&
          r.target_proof &&
          /^0x[0-9a-f]{40}$/.test(r.target_wallet ?? "") &&
          r.target_id === targetIdFromWallet(r.target_wallet as `0x${string}`),
      );
      verified.push(...eligible);
    }
    const result = await input.db.execute(
      positionMetadataSelect(batch, input.capturedAt, verified),
    );
    const rows = (
      Array.isArray(result)
        ? result
        : ((result as { rows?: unknown[] })?.rows ?? [])
    ) as EvidenceRow[];
    for (const key of batch) {
      const candidates: PositionMetadataCandidate[] = rows
        .filter(
          (r) =>
            r.condition_id === key.conditionId &&
            r.token_id === key.tokenId &&
            r.requested_wallet === key.wallet &&
            r.requested_mode === key.mode,
        )
        .flatMap((r) => {
          const raw = r.raw ?? {};
          const text = (v: unknown): string | null =>
            typeof v === "string" ? v : null;
          const candidate: PositionMetadataCandidate = {
            conditionId: r.condition_id,
            tokenId: r.source === "canonical" ? null : r.token_id,
            source: r.source,
            observedAt:
              r.observed_at instanceof Date
                ? r.observed_at.toISOString()
                : r.observed_at,
            marketTitle: text(raw.title),
            marketSlug: text(raw.slug),
            eventTitle: text(raw.eventTitle),
            eventSlug: text(raw.eventSlug),
            outcome: text(raw.outcome),
            oppositeTokenId: text(raw.oppositeAsset),
          };
          // SQL keeps two distinct witnesses only when the newest meaningful
          // source timestamp disagrees. Feed both to the shared selector so
          // an arbitrary physical row can never become a confident label.
          const witnesses = [candidate];
          const conflictingOutcome = text(raw.conflictingOutcome);
          if (conflictingOutcome !== null)
            witnesses.push({ ...candidate, outcome: conflictingOutcome });
          const conflictingOpposite = text(raw.conflictingOppositeAsset);
          if (conflictingOpposite !== null)
            witnesses.push({
              ...candidate,
              oppositeTokenId: conflictingOpposite,
            });
          for (const [rawField, field] of [
            ["title", "marketTitle"],
            ["slug", "marketSlug"],
            ["eventTitle", "eventTitle"],
            ["eventSlug", "eventSlug"],
            ["outcome", "outcome"],
          ] as const) {
            const conflicting = text(raw[`conflicting_${rawField}`]);
            if (conflicting !== null)
              witnesses.push({ ...candidate, [field]: conflicting });
          }
          return witnesses;
        });
      const requestKey =
        positionMetadataRequestKey(
          { ...key, walletAddress: key.wallet },
          input.accountScope,
        ) ?? "";
      out.set(requestKey, {
        ...selectPositionMetadata(key, candidates),
        originAvailability:
          overflowed.has(requestKey)
            ? "overflow"
            : candidates.some((c) => c.source.startsWith("origin_"))
              ? "available"
              : "unavailable",
      });
    }
  }
  return out;
}

/** Physical candidates, including malformed/wrong-token rows, consume this budget. */
export const ORIGIN_CANDIDATE_LIMIT = 256;
export type OriginDescriptor = {
  condition_id: string;
  token_id: string;
  requested_wallet: string;
  billing_account_id: string;
  target_id: string;
  fill_id: string;
  market_id: string;
  mode: "paper";
  observed_at: string;
  order_id: string | null;
  ledger_condition_id: string | null;
  ledger_token_id: string | null;
  target_wallet: string | null;
  connection_proof: boolean;
  target_proof: boolean;
  backend_pid: number;
  transaction_started_at: string;
  snapshot: string;
};
function resultRows<T>(result: unknown): T[] {
  return (
    Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] })?.rows ?? [])
  ) as T[];
}
const repeatableReadOnly = sql`current_setting('transaction_read_only')='on'
  AND current_setting('transaction_isolation') IN ('repeatable read','serializable')`;
function connectionProof(account: SQL, wallet: SQL, observedAt: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM poly_wallet_connections c
    WHERE c.billing_account_id=${account} AND c.kind='paper' AND c.revoked_at IS NULL
      AND lower(c.address)=${wallet} AND lower(c.funder_address)=${wallet}
      AND c.created_at<=${observedAt})`;
}
function retainedTargetProof(
  account: SQL,
  targetWallet: SQL,
  observedAt: SQL,
): SQL {
  return sql`EXISTS (SELECT 1 FROM poly_copy_trade_targets t
    WHERE t.billing_account_id=${account} AND lower(t.target_wallet)=${targetWallet}
      AND t.created_at<=${observedAt} AND (t.disabled_at IS NULL OR ${observedAt}<t.disabled_at))`;
}
/** Phase one: indexed physical LIMIT is inside the lateral, before all JSON/proof predicates. */
export function positionMetadataOriginSelect(
  batch: readonly MetadataKey[],
  accountId: string,
  capturedAt?: string,
): SQL {
  return sql`SELECT k."conditionId" AS condition_id,k."tokenId" AS token_id,k.wallet AS requested_wallet,
    f.billing_account_id,f.target_id,f.fill_id,f.market_id,f.mode,f.observed_at::text,f.order_id,
    f.attributes->>'condition_id' AS ledger_condition_id,f.attributes->>'token_id' AS ledger_token_id,
    lower(f.attributes->>'target_wallet') AS target_wallet,
    ${connectionProof(sql`${accountId}`, sql`k.wallet`, sql`f.observed_at`)} AS connection_proof,
    ${retainedTargetProof(sql`${accountId}`, sql`lower(f.attributes->>'target_wallet')`, sql`f.observed_at`)} AS target_proof,
    pg_backend_pid() AS backend_pid,transaction_timestamp()::text AS transaction_started_at,pg_current_snapshot()::text AS snapshot
    FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
      AS k("conditionId" text,"tokenId" text,wallet text,mode text)
    CROSS JOIN LATERAL (
      SELECT billing_account_id,target_id,fill_id,market_id,mode,observed_at,order_id,attributes
      FROM poly_copy_trade_fills f
      WHERE f.billing_account_id=${accountId} AND f.market_id='prediction-market:polymarket:'||k."conditionId"
        AND f.mode=k.mode AND f.observed_at<=COALESCE(${capturedAt ?? null}::timestamptz,transaction_timestamp())
      ORDER BY f.observed_at DESC,f.target_id DESC,f.fill_id DESC LIMIT ${ORIGIN_CANDIDATE_LIMIT + 1}
    ) f WHERE k.mode='paper' AND ${repeatableReadOnly}`;
}

const displayFields = [
  "title",
  "slug",
  "eventTitle",
  "eventSlug",
  "outcome",
  "oppositeAsset",
] as const;
const canonicalFields = [
  "market_title",
  "market_slug",
  "event_title",
  "event_slug",
] as const;

/** Keep the predicate before LIMIT so newer sparse/placeholder rows cannot mask facts. */
function meaningful(value: SQL, identityProof = false): SQL {
  return identityProof
    ? sql`${value} ~ '^(0|[1-9][0-9]*)$' AND ${value} <> k."tokenId"`
    : sql`nullif(btrim(${value}), '') IS NOT NULL
        AND btrim(${value}) !~* '^(UNKNOWN|Polymarket|Market 0x[0-9a-f]+([.][.][.])?)$'`;
}

/** An explicit raw identity disagreement is not a label for the indexed token. */
function savedMetadataIdentity(): SQL {
  return sql`(p.raw->>'asset' IS NULL OR p.raw->>'asset'=k."tokenId")
    AND (p.raw->>'conditionId' IS NULL OR lower(p.raw->>'conditionId')=k."conditionId")`;
}

/** Untyped ledger numbers are indexes, including future v3 serialization without a saved kind.
 * Numeric provider names need exact lossless provider identity; hydration keeps outcome separately.
 */
function namedSavedOutcome(value: SQL, source: string): SQL {
  const providerPosition = sql`p.raw->>'asset'=k."tokenId" AND lower(p.raw->>'conditionId')=k."conditionId"
    AND lower(p.raw->>'proxyWallet') IN (SELECT lower(w.wallet_address) FROM poly_trader_wallets w WHERE w.id=p.trader_wallet_id AND w.kind<>'paper_wallet')
    AND p.raw->'attributes' IS NULL AND p.raw->'paper_ledger' IS NULL`;
  return sql`(btrim(${value}) !~ '^[0-9]+$' OR (${source === "fill" ? sql`FALSE` : providerPosition}))`;
}

/** Newest source timestamp, retaining bounded witnesses of every tied outcome. */
function outcomeProbe(source: string, observations: SQL): SQL {
  return sql`(SELECT ${source}::text AS source, latest.observed_at,
    jsonb_build_object('outcome', min(latest.value), 'conflictingOutcome',
      CASE WHEN count(DISTINCT latest.value)>1 THEN max(latest.value) END) AS raw
    FROM (${observations} ORDER BY observed_at DESC FETCH FIRST 1 ROW WITH TIES) latest
    GROUP BY latest.observed_at)`;
}

/** Newest meaningful mapping cohort, including both valid raw aliases. */
function oppositeProbe(source: string, observations: SQL): SQL {
  return sql`(SELECT ${source}::text AS source, latest.observed_at,
    jsonb_build_object('oppositeAsset', min(latest.value), 'conflictingOppositeAsset',
      CASE WHEN count(DISTINCT latest.value)>1 THEN max(latest.value) END) AS raw
    FROM (${observations} ORDER BY observed_at DESC FETCH FIRST 1 ROW WITH TIES) latest
    GROUP BY latest.observed_at)`;
}

/**
 * Exact production query for real-Postgres plan proof. At most 24 scalar rows/key.
 * History searches use existing wallet/lower(condition)/token indexes. An old
 * nonempty field may require scanning that token's history; unrelated wallet or
 * token history must not be scanned, and raw JSON history never reaches V8.
 */
export function positionMetadataSelect(
  batch: readonly MetadataKey[],
  capturedAt?: string,
  origins: readonly OriginDescriptor[] = [],
): SQL {
  const cutoff = capturedAt ?? null;
  // Resolve across physical siblings inside each probe: <=24 scalar rows per
  // logical wallet/key, never 24 multiplied by the number of physical rows.
  const walletIds = sql`SELECT w.id FROM poly_trader_wallets w
    WHERE lower(w.wallet_address)=k.wallet
      AND ((k.mode='paper' AND w.kind='paper_wallet')
        OR (k.mode='live' AND w.kind<>'paper_wallet'))`;
  const probes: SQL[] = canonicalFields.map((field, index) => {
    const value = sql.raw(`m.${field}`);
    return sql`(SELECT 'canonical'::text AS source, m.fetched_at AS observed_at,
      jsonb_build_object(${displayFields[index]}::text, ${value}) AS raw
      FROM poly_market_metadata m
      WHERE lower(m.condition_id)=k."conditionId" AND ${meaningful(value)}
        AND m.fetched_at<=COALESCE(${cutoff}::timestamptz,transaction_timestamp())
      ORDER BY m.fetched_at DESC,m.condition_id LIMIT 1)`;
  });
  for (const [source, table, time, tie] of [
    [
      "current",
      "poly_trader_current_positions",
      "last_observed_at",
      "condition_id",
    ],
    ["snapshot", "poly_trader_position_snapshots", "captured_at", "id"],
    ["fill", "poly_trader_fills", "observed_at", "id"],
  ] as const) {
    for (const field of displayFields) {
      if (field === "oppositeAsset") {
        probes.push(
          oppositeProbe(
            source,
            sql`SELECT p.${sql.raw(time)} AS observed_at,
          alias.value FROM ${sql.raw(table)} p
          CROSS JOIN LATERAL (VALUES (p.raw->>'oppositeAsset'), (p.raw->>'opposite_token_id')) alias(value)
          WHERE p.trader_wallet_id IN (${walletIds}) AND lower(p.condition_id)=k."conditionId" AND p.token_id=k."tokenId" AND ${savedMetadataIdentity()}
            AND ${meaningful(sql`alias.value`, true)}
            AND p.${sql.raw(time)}<=COALESCE(${cutoff}::timestamptz,transaction_timestamp())`,
          ),
        );
        continue;
      }
      const value = sql`p.raw->>${field}`;
      if (field === "outcome") {
        probes.push(
          outcomeProbe(
            source,
            sql`SELECT p.${sql.raw(time)} AS observed_at,
          btrim(${value}) AS value FROM ${sql.raw(table)} p
          WHERE p.trader_wallet_id IN (${walletIds}) AND lower(p.condition_id)=k."conditionId" AND p.token_id=k."tokenId" AND ${savedMetadataIdentity()}
            AND ${meaningful(value)} AND ${namedSavedOutcome(value, source)}
            AND p.${sql.raw(time)}<=COALESCE(${cutoff}::timestamptz,transaction_timestamp())`,
          ),
        );
        continue;
      }
      probes.push(sql`(SELECT ${source}::text, p.${sql.raw(time)},
        jsonb_build_object(${field}::text,${value})
        FROM ${sql.raw(table)} p
        WHERE p.trader_wallet_id IN (${walletIds}) AND lower(p.condition_id)=k."conditionId" AND p.token_id=k."tokenId" AND ${savedMetadataIdentity()}
          AND ${meaningful(value)}
          AND p.${sql.raw(time)}<=COALESCE(${cutoff}::timestamptz,transaction_timestamp())
        ORDER BY p.${sql.raw(time)} DESC,p.${sql.raw(tie)} LIMIT 1)`);
    }
  }
  for (const field of ["outcome", "oppositeAsset"] as const) {
    if (field === "oppositeAsset") {
      probes.push(
        oppositeProbe(
          "outcome",
          sql`SELECT o.updated_at AS observed_at,
        alias.value FROM poly_market_outcomes o
        CROSS JOIN LATERAL (VALUES (o.raw->>'oppositeAsset'), (o.raw->>'opposite_token_id')) alias(value)
        WHERE lower(o.condition_id)=k."conditionId" AND o.token_id=k."tokenId"
          AND ${meaningful(sql`alias.value`, true)}
          AND o.updated_at<=COALESCE(${cutoff}::timestamptz,transaction_timestamp())`,
        ),
      );
      continue;
    }
    const value = sql`CASE WHEN ${meaningful(sql`o.raw->>'label'`)} THEN o.raw->>'label' ELSE o.raw->>'outcome' END`;
    if (field === "outcome") {
      probes.push(
        outcomeProbe(
          "outcome",
          sql`SELECT o.updated_at AS observed_at,
        btrim(${value}) AS value FROM poly_market_outcomes o
        WHERE lower(o.condition_id)=k."conditionId" AND o.token_id=k."tokenId"
          AND ${meaningful(value)} AND btrim(${value}) !~ '^[0-9]+$'
          AND o.updated_at<=COALESCE(${cutoff}::timestamptz,transaction_timestamp())`,
        ),
      );
    }
  }
  const requested = sql`WITH requested AS (
    SELECT k."conditionId",k."tokenId",k.wallet,COALESCE(k.mode,'live') AS mode
    FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS k("conditionId" text,"tokenId" text,wallet text,mode text)
  )`;
  if (origins.length === 0)
    return sql`${requested}
    SELECT k."conditionId" AS condition_id,k."tokenId" AS token_id,k.wallet AS requested_wallet,k.mode AS requested_mode,
      evidence.source,evidence.observed_at,evidence.raw
    FROM requested k CROSS JOIN LATERAL (${sql.join(probes, sql` UNION ALL `)}) evidence`;
  const originWalletIds = sql`SELECT w.id FROM poly_trader_wallets w
    WHERE w.kind<>'paper_wallet' AND lower(w.wallet_address) IN (
      SELECT b.target_wallet FROM verified_origins b
      WHERE b.condition_id=k."conditionId" AND b.token_id=k."tokenId" AND b.requested_wallet=k.wallet AND k.mode='paper')`;
  const fallbackProbes: SQL[] = [];
  for (const [source, table, time] of [
    ["current", "poly_trader_current_positions", "last_observed_at"],
    ["snapshot", "poly_trader_position_snapshots", "captured_at"],
    ["fill", "poly_trader_fills", "observed_at"],
  ] as const) {
    for (const field of displayFields.filter((f) => f !== "oppositeAsset")) {
      const value = sql`p.raw->>${field}`;
      const observations = sql`SELECT p.${sql.raw(time)} AS observed_at,btrim(${value}) AS value
        FROM ${sql.raw(table)} p
        WHERE p.trader_wallet_id IN (${originWalletIds}) AND lower(p.condition_id)=k."conditionId" AND p.token_id=k."tokenId" AND ${savedMetadataIdentity()}
          AND ${meaningful(value)} AND ${field === "outcome" ? namedSavedOutcome(value, source) : sql`TRUE`}
          AND p.${sql.raw(time)}<=COALESCE(${cutoff}::timestamptz,transaction_timestamp())
          AND NOT EXISTS (SELECT 1 FROM primary_evidence e WHERE ${meaningful(sql`e.raw->>${field}`)})`;
      fallbackProbes.push(sql`(SELECT ${`origin_${source}`}::text AS source,latest.observed_at,
        jsonb_build_object(${field}::text,min(latest.value),${`conflicting_${field}`}::text,
          CASE WHEN count(DISTINCT latest.value)>1 THEN max(latest.value) END) AS raw
        FROM (${observations} ORDER BY observed_at DESC FETCH FIRST 1 ROW WITH TIES) latest GROUP BY latest.observed_at)`);
    }
  }
  // A structural execute-only caller is not a transaction guarantee. In addition
  // to read-only snapshot isolation, bind phase two to the same backend and
  // transaction/snapshot; independent pool calls can only retain primary facts.
  return sql`${requested}, verified_origins AS MATERIALIZED (
      SELECT b.* FROM jsonb_to_recordset(${JSON.stringify(origins)}::jsonb) AS b(
        condition_id text,token_id text,requested_wallet text,billing_account_id text,target_id uuid,fill_id text,
        market_id text,mode text,observed_at text,order_id text,ledger_condition_id text,ledger_token_id text,target_wallet text,
        backend_pid integer,transaction_started_at text,snapshot text)
      CROSS JOIN LATERAL (SELECT f.* FROM poly_copy_trade_fills f
        WHERE f.billing_account_id=b.billing_account_id AND f.target_id=b.target_id AND f.fill_id=b.fill_id LIMIT 1) f
      WHERE ${repeatableReadOnly} AND b.backend_pid=pg_backend_pid()
        AND b.transaction_started_at=transaction_timestamp()::text AND b.snapshot=pg_current_snapshot()::text
        AND f.market_id=b.market_id AND f.mode=b.mode AND b.mode='paper'
        AND f.observed_at=b.observed_at::timestamptz AND f.order_id=b.order_id
        AND f.market_id='prediction-market:polymarket:'||b.condition_id
        AND lower(f.attributes->>'condition_id')=b.condition_id AND f.attributes->>'token_id'=b.token_id
        AND lower(f.attributes->>'target_wallet')=b.target_wallet
        AND f.observed_at<=COALESCE(${cutoff}::timestamptz,transaction_timestamp())
        AND ${connectionProof(sql`b.billing_account_id`, sql`b.requested_wallet`, sql`f.observed_at`)}
        AND ${retainedTargetProof(sql`b.billing_account_id`, sql`b.target_wallet`, sql`f.observed_at`)}
    )
    SELECT k."conditionId" AS condition_id,k."tokenId" AS token_id,k.wallet AS requested_wallet,k.mode AS requested_mode,
      evidence.source,evidence.observed_at,evidence.raw
    FROM requested k
    CROSS JOIN LATERAL (
      WITH primary_evidence AS MATERIALIZED (${sql.join(probes, sql` UNION ALL `)})
      SELECT * FROM primary_evidence
      UNION ALL SELECT * FROM (${sql.join(fallbackProbes, sql` UNION ALL `)}) fallback_evidence
    ) evidence`;
}

/** Project only selected saved metadata; rejected evidence never revives via raw. */
export function positionMetadataDisplay(metadata: ResolvedPositionMetadata | undefined) {
  const eventSlug = metadata?.eventSlug ?? null;
  const marketSlug = metadata?.marketSlug ?? null;
  return {
    marketTitle: metadata?.marketTitle ?? "Polymarket",
    eventTitle: metadata?.eventTitle ?? null,
    eventSlug,
    marketSlug,
    marketUrl: eventSlug
      ? `https://polymarket.com/event/${encodeURIComponent(eventSlug)}`
      : marketSlug ? `https://polymarket.com/market/${encodeURIComponent(marketSlug)}` : null,
    outcome: metadata?.outcome ?? "UNKNOWN",
  };
}
