// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Policy-independent identity and saved metadata selection. No I/O or clock. */
export type PositionIdentityInput = Readonly<{ conditionId: unknown; tokenId: unknown }>;
export type PositionIdentity = Readonly<{ availability: "available"; conditionId: string; tokenId: string; key: string }>;
export type UnavailablePositionIdentity = Readonly<{ availability: "unavailable"; reason: "missing_condition" | "invalid_condition" | "missing_token" | "invalid_token" }>;
export function normalizePositionIdentity(input: PositionIdentityInput): PositionIdentity | UnavailablePositionIdentity {
  if (input.conditionId == null || input.conditionId === "") return { availability: "unavailable", reason: "missing_condition" };
  if (typeof input.conditionId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(input.conditionId)) return { availability: "unavailable", reason: "invalid_condition" };
  if (input.tokenId == null || input.tokenId === "") return { availability: "unavailable", reason: "missing_token" };
  if (typeof input.tokenId !== "string" || !/^(0|[1-9][0-9]*)$/.test(input.tokenId)) return { availability: "unavailable", reason: "invalid_token" };
  const conditionId = input.conditionId.toLowerCase();
  return { availability: "available", conditionId, tokenId: input.tokenId, key: `${conditionId}:${input.tokenId}` };
}
export function positionIdentityKey(input: PositionIdentityInput): string | null {
  const identity = normalizePositionIdentity(input);
  return identity.availability === "available" ? identity.key : null;
}
export type PositionRelation = Readonly<{ relation: "same" | "opposite" | "unrelated" | "unavailable"; exactMatch: boolean | null; reason: string }>;
export function comparePositionIdentity(left: PositionIdentityInput & { oppositeTokenId?: unknown }, right: PositionIdentityInput & { oppositeTokenId?: unknown }): PositionRelation {
  const a = normalizePositionIdentity(left), b = normalizePositionIdentity(right);
  if (a.availability !== "available" || b.availability !== "available") return { relation: "unavailable", exactMatch: null, reason: a.availability !== "available" ? a.reason : (b as UnavailablePositionIdentity).reason };
  if (a.conditionId !== b.conditionId) return { relation: "unrelated", exactMatch: false, reason: "different_condition" };
  if (a.tokenId === b.tokenId) return { relation: "same", exactMatch: true, reason: "exact_condition_token" };
  if (left.oppositeTokenId === b.tokenId && right.oppositeTokenId === a.tokenId) return { relation: "opposite", exactMatch: false, reason: "verified_opposite_tokens" };
  return { relation: "unrelated", exactMatch: false, reason: "different_token" };
}
export type PositionMetadataCandidate = Readonly<{
  conditionId: string; tokenId?: string | null; source: string; observedAt: string | null;
  oppositeTokenId?: string | null; marketTitle?: string | null; marketSlug?: string | null; eventTitle?: string | null; eventSlug?: string | null; outcome?: string | null;
}>;
const FIELDS = ["marketTitle", "marketSlug", "eventTitle", "eventSlug", "outcome"] as const;
type MetadataField = typeof FIELDS[number];
export type ResolvedPositionMetadata = Record<MetadataField, string | null> & {
  oppositeTokenId: string | null;
  oppositeProofAvailability: "available" | "unavailable" | "conflict";
  provenance: Partial<Record<MetadataField, { source: string; observedAt: string | null }>>;
  availability: "complete" | "partial" | "unavailable" | "conflict";
};
const useful = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && !/^(UNKNOWN|Polymarket|Market 0x[0-9a-f]+(?:\.\.\.)?)$/i.test(value.trim());
export function selectPositionMetadata(input: PositionIdentityInput, candidates: readonly PositionMetadataCandidate[]): ResolvedPositionMetadata {
  const identity = normalizePositionIdentity(input);
  const result: ResolvedPositionMetadata = { marketTitle: null, marketSlug: null, eventTitle: null, eventSlug: null, outcome: null, oppositeTokenId: null, oppositeProofAvailability: "unavailable", provenance: {}, availability: "unavailable" };
  if (identity.availability !== "available") return result;
  const ordered = candidates.filter(c => c.conditionId.toLowerCase() === identity.conditionId).slice().sort((a,b) => (b.observedAt ?? "").localeCompare(a.observedAt ?? "") || a.source.localeCompare(b.source));
  const oppositeCandidates = ordered.filter(c => c.tokenId === identity.tokenId && typeof c.oppositeTokenId === "string" && /^(0|[1-9][0-9]*)$/.test(c.oppositeTokenId) && c.oppositeTokenId !== identity.tokenId);
  const bestOpposite = oppositeCandidates[0];
  if (bestOpposite) {
    const conflicted = oppositeCandidates.some(c => c.source === bestOpposite.source && c.observedAt === bestOpposite.observedAt && c.oppositeTokenId !== bestOpposite.oppositeTokenId);
    // Identity proof availability is independent of display-label availability.
    // Equal-authority disagreement cannot select an arbitrary opposite mapping.
    result.oppositeProofAvailability = conflicted ? "conflict" : "available";
    if (!conflicted) result.oppositeTokenId = bestOpposite.oppositeTokenId ?? null;
  }
  let conflict = false;
  for (const field of FIELDS) {
    const eligible = ordered.filter(c => useful(c[field]) && (field !== "outcome" || c.tokenId === identity.tokenId));
    const best = eligible[0];
    if (!best) continue;
    const value = best[field] as string;
    if ((field === "outcome" || best.source.startsWith("origin_")) && eligible.some(c => c.observedAt === best.observedAt && c.source === best.source && c[field] !== value)) { conflict = true; continue; }
    result[field] = value.trim(); result.provenance[field] = { source: best.source, observedAt: best.observedAt };
  }
  result.availability = conflict ? "conflict" : result.marketTitle && result.outcome ? "complete" : FIELDS.some(f => result[f] !== null) ? "partial" : "unavailable";
  return result;
}
