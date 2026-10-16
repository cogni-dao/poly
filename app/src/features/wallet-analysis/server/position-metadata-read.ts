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

type Db = { execute(query: SQL): Promise<unknown> };
export type PositionMetadataKey = PositionIdentityInput & {
  walletAddress?: string | null;
};

/** Wallet provenance is part of the lookup; null requests only global venue facts. */
export function positionMetadataRequestKey(
  input: PositionMetadataKey,
): string | null {
  const identity = normalizePositionIdentity(input);
  return identity.availability === "available"
    ? `${identity.key}:${input.walletAddress?.toLowerCase() ?? "global"}`
    : null;
}

type EvidenceRow = {
  condition_id: string;
  token_id: string;
  requested_wallet: string | null;
  source: string;
  observed_at: string | Date;
  raw: Record<string, unknown> | null;
};

export async function readPositionMetadata(input: {
  db: Db;
  keys: readonly PositionMetadataKey[];
  capturedAt?: string;
}): Promise<Map<string, ResolvedPositionMetadata>> {
  const keys = input.keys.flatMap((k) => {
    const identity = normalizePositionIdentity(k);
    return identity.availability === "available"
      ? [{ ...identity, wallet: k.walletAddress?.toLowerCase() ?? null }]
      : [];
  });
  const unique = [
    ...new Map(
      keys.map((k) => [`${k.key}:${k.wallet ?? "global"}`, k]),
    ).values(),
  ];
  const out = new Map<string, ResolvedPositionMetadata>();
  // Batch size bounds SQL parameters and memory, never truncates requested keys.
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100);
    const result = await input.db.execute(
      positionMetadataSelect(batch, input.capturedAt),
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
            r.requested_wallet === key.wallet,
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
          const conflictingOutcome = text(raw.conflictingOutcome);
          return conflictingOutcome === null
            ? [candidate]
            : [candidate, { ...candidate, outcome: conflictingOutcome }];
        });
      out.set(
        `${key.key}:${key.wallet ?? "global"}`,
        selectPositionMetadata(key, candidates),
      );
    }
  }
  return out;
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

/** Newest source timestamp, retaining bounded witnesses of every tied outcome. */
function outcomeProbe(source: string, observations: SQL): SQL {
  return sql`(SELECT ${source}::text AS source, latest.observed_at,
    jsonb_build_object('outcome', min(latest.value), 'conflictingOutcome',
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
  batch: readonly {
    conditionId: string;
    tokenId: string;
    wallet: string | null;
  }[],
  capturedAt?: string,
): SQL {
  const cutoff = capturedAt ?? null;
  const probes: SQL[] = canonicalFields.map((field, index) => {
    const value = sql.raw(`m.${field}`);
    return sql`(SELECT 'canonical'::text AS source, m.fetched_at AS observed_at,
      jsonb_build_object(${displayFields[index]}::text, ${value}) AS raw
      FROM poly_market_metadata m
      WHERE lower(m.condition_id)=k."conditionId" AND ${meaningful(value)}
        AND (${cutoff}::timestamptz IS NULL OR m.fetched_at<=${cutoff}::timestamptz)
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
      const value =
        field === "oppositeAsset"
          ? sql`coalesce(nullif(p.raw->>'oppositeAsset',''),p.raw->>'opposite_token_id')`
          : sql`p.raw->>${field}`;
      if (field === "outcome") {
        probes.push(
          outcomeProbe(
            source,
            sql`SELECT p.${sql.raw(time)} AS observed_at,
          btrim(${value}) AS value FROM ${sql.raw(table)} p
          WHERE p.trader_wallet_id=w.id AND lower(p.condition_id)=k."conditionId" AND p.token_id=k."tokenId"
            AND ${meaningful(value)}
            AND (${cutoff}::timestamptz IS NULL OR p.${sql.raw(time)}<=${cutoff}::timestamptz)`,
          ),
        );
        continue;
      }
      probes.push(sql`(SELECT ${source}::text, p.${sql.raw(time)},
        jsonb_build_object(${field}::text,${value})
        FROM ${sql.raw(table)} p
        WHERE p.trader_wallet_id=w.id AND lower(p.condition_id)=k."conditionId" AND p.token_id=k."tokenId"
          AND ${meaningful(value, field === "oppositeAsset")}
          AND (${cutoff}::timestamptz IS NULL OR p.${sql.raw(time)}<=${cutoff}::timestamptz)
        ORDER BY p.${sql.raw(time)} DESC,p.${sql.raw(tie)} LIMIT 1)`);
    }
  }
  for (const field of ["outcome", "oppositeAsset"] as const) {
    const value =
      field === "outcome"
        ? sql`CASE WHEN ${meaningful(sql`o.raw->>'label'`)} THEN o.raw->>'label' ELSE o.raw->>'outcome' END`
        : sql`coalesce(nullif(o.raw->>'oppositeAsset',''),o.raw->>'opposite_token_id')`;
    if (field === "outcome") {
      probes.push(
        outcomeProbe(
          "outcome",
          sql`SELECT o.updated_at AS observed_at,
        btrim(${value}) AS value FROM poly_market_outcomes o
        WHERE lower(o.condition_id)=k."conditionId" AND o.token_id=k."tokenId"
          AND ${meaningful(value)}
          AND (${cutoff}::timestamptz IS NULL OR o.updated_at<=${cutoff}::timestamptz)`,
        ),
      );
      continue;
    }
    probes.push(sql`(SELECT 'outcome'::text,o.updated_at,jsonb_build_object(${field}::text,${value})
      FROM poly_market_outcomes o
      WHERE lower(o.condition_id)=k."conditionId" AND o.token_id=k."tokenId"
        AND ${meaningful(value, field === "oppositeAsset")}
        AND (${cutoff}::timestamptz IS NULL OR o.updated_at<=${cutoff}::timestamptz)
      ORDER BY o.updated_at DESC,o.condition_id LIMIT 1)`);
  }
  return sql`WITH requested AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
        AS k("conditionId" text,"tokenId" text,wallet text)
    )
    SELECT k."conditionId" AS condition_id,k."tokenId" AS token_id,k.wallet AS requested_wallet,
      evidence.source,evidence.observed_at,evidence.raw
    FROM requested k
    LEFT JOIN poly_trader_wallets w ON w.wallet_address=k.wallet
    CROSS JOIN LATERAL (${sql.join(probes, sql` UNION ALL `)}) evidence`;
}
