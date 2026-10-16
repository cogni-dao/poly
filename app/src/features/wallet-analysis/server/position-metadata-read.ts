// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Bounded saved-fact metadata probes. Never reads upstream or derives economics. */
import { normalizePositionIdentity, selectPositionMetadata, type PositionIdentityInput, type PositionMetadataCandidate, type ResolvedPositionMetadata } from "@cogni/poly-market-provider";
import { sql, type SQL } from "drizzle-orm";
type Db = { execute(query: SQL): Promise<unknown> };
export type PositionMetadataKey = PositionIdentityInput & { walletAddress?: string | null };
export async function readPositionMetadata(input: { db: Db; keys: readonly PositionMetadataKey[]; capturedAt?: string }): Promise<Map<string, ResolvedPositionMetadata>> {
  const keys = input.keys.flatMap(k => { const id = normalizePositionIdentity(k); return id.availability === "available" ? [{ ...id, wallet: k.walletAddress?.toLowerCase() ?? null }] : []; });
  const unique = [...new Map(keys.map(k => [`${k.key}:${k.wallet ?? ""}`, k])).values()];
  const out = new Map<string, ResolvedPositionMetadata>();
  // A bounded batch is a memory/SQL parameter bound, not a truncation of results.
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100);
    const result = await input.db.execute(positionMetadataSelect(batch, input.capturedAt));
    const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] })?.rows ?? []) as Array<{ condition_id: string; token_id: string; source: string; observed_at: string | Date; raw: Record<string, unknown> | null }>;
    for (const key of batch) {
      const candidates: PositionMetadataCandidate[] = rows.filter(r => r.condition_id === key.conditionId && r.token_id === key.tokenId).map(r => {
        const raw = r.raw ?? {};
        const text = (v: unknown): string | null => typeof v === "string" ? v : null;
        return { conditionId: r.condition_id, tokenId: r.source === "canonical" ? null : r.token_id, source: r.source, observedAt: r.observed_at instanceof Date ? r.observed_at.toISOString() : r.observed_at,
          marketTitle: text(raw.title), marketSlug: text(raw.slug), eventTitle: text(raw.eventTitle), eventSlug: text(raw.eventSlug), outcome: text(r.source === "outcome" ? raw.label ?? raw.outcome : raw.outcome), oppositeTokenId: text(raw.oppositeAsset ?? raw.opposite_token_id) };
      });
      out.set(key.key, selectPositionMetadata(key, candidates));
    }
  }
  return out;
}

/** Exact production query exported for real-Postgres plan proof. */
export function positionMetadataSelect(batch: readonly { conditionId: string; tokenId: string; wallet: string | null }[], capturedAt?: string): SQL {
  return sql`
      WITH requested AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
        AS k(condition_id text, token_id text, wallet text, "conditionId" text, "tokenId" text))
      SELECT k."conditionId" AS condition_id, k."tokenId" AS token_id, evidence.source,
        evidence.observed_at, evidence.raw
      FROM requested k
      LEFT JOIN poly_trader_wallets w ON w.wallet_address = k.wallet
      CROSS JOIN LATERAL (
        (SELECT 'canonical'::text AS source, m.fetched_at AS observed_at,
          jsonb_build_object('title',m.market_title,'slug',m.market_slug,'eventTitle',m.event_title,'eventSlug',m.event_slug) AS raw
         FROM poly_market_metadata m WHERE lower(m.condition_id)=k."conditionId"
         ORDER BY m.fetched_at DESC,m.condition_id LIMIT 1)
        UNION ALL
        (SELECT 'current'::text,p.last_observed_at,p.raw FROM poly_trader_current_positions p
         WHERE p.condition_id=k."conditionId" AND p.token_id=k."tokenId"
           AND (w.id IS NULL OR p.trader_wallet_id=w.id)
           AND nullif(p.raw->>'outcome','') IS NOT NULL
           AND (${capturedAt ?? null}::timestamptz IS NULL OR p.last_observed_at<=${capturedAt ?? null}::timestamptz)
         ORDER BY p.last_observed_at DESC,p.trader_wallet_id LIMIT 1)
        UNION ALL
        (SELECT 'snapshot'::text,p.captured_at,p.raw FROM poly_trader_position_snapshots p
         WHERE p.trader_wallet_id=w.id AND lower(p.condition_id)=k."conditionId" AND p.token_id=k."tokenId"
           AND nullif(p.raw->>'outcome','') IS NOT NULL
           AND (${capturedAt ?? null}::timestamptz IS NULL OR p.captured_at<=${capturedAt ?? null}::timestamptz)
         ORDER BY p.captured_at DESC,p.id LIMIT 1)
        UNION ALL
        (SELECT 'fill'::text,f.observed_at,f.raw FROM poly_trader_fills f
         WHERE f.trader_wallet_id=w.id AND lower(f.condition_id)=k."conditionId" AND f.token_id=k."tokenId"
           AND (nullif(f.raw->>'outcome','') IS NOT NULL OR nullif(f.raw->>'title','') IS NOT NULL)
           AND (${capturedAt ?? null}::timestamptz IS NULL OR f.observed_at<=${capturedAt ?? null}::timestamptz)
         ORDER BY f.observed_at DESC,f.id LIMIT 1)
        UNION ALL
        (SELECT 'outcome'::text,o.updated_at,o.raw FROM poly_market_outcomes o
         WHERE lower(o.condition_id)=k."conditionId" AND o.token_id=k."tokenId"
           AND coalesce(nullif(o.raw->>'label',''),nullif(o.raw->>'outcome','')) IS NOT NULL
         ORDER BY o.updated_at DESC,o.condition_id LIMIT 1)
      ) evidence
    `;
}
