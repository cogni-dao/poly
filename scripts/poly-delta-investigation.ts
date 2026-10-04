// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * API-only adaptation of the historical delta-minimizer report flow.
 * Lineage: poly commit d225b866, scripts/poly-mirror-report.ts.
 *
 * This port intentionally retains only the one-market bundle/report shape.
 * It removes operator Grafana SQL, direct database access, CLOB/Gamma calls,
 * and unbounded tapes. Every fact comes from the delegated performance API.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  PolyResearchCopyTradeInvestigationEvidenceResponse,
  PolyResearchCopyTradeInvestigationResponse,
} from "@cogni/poly-node-contracts";

const MAX_EVIDENCE_PAGES = 10;
const EVIDENCE_PAGE_LIMIT = 200;

type Args = {
  baseUrl: string;
  billingAccountId: string;
  conditionId: string;
  mode: "live" | "paper" | "all";
  out: string;
  findingJson?: string;
};

type Finding = {
  title: string;
  confidencePct: number;
  charterClass: "evidence_quality" | "decision_policy" | "position_sizing" | "execution_quality";
  explanation: string;
  codeCitation: string;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const bearer = process.env.COGNI_NODE_API_KEY?.trim();
  if (!bearer) throw new Error("COGNI_NODE_API_KEY is required");

  const summary = await getJson<PolyResearchCopyTradeInvestigationResponse>(
    args.baseUrl,
    "/api/v1/poly/research/copy-trade-investigation",
    bearer,
    {
      billing_account_id: args.billingAccountId,
      condition_id: args.conditionId,
      mode: args.mode,
    }
  );
  const fills = await readEvidence(args, bearer, summary.captured_at, "fills");
  const decisions = await readEvidence(args, bearer, summary.captured_at, "decisions");
  const finding = args.findingJson
    ? await readAgentFinding(args.findingJson)
    : deriveFinding(summary, fills, decisions);
  const bundle = {
    generated_at: new Date().toISOString(),
    source: "scoped-performance-api",
    lineage_commit: "d225b866",
    request: {
      base_url: args.baseUrl,
      billing_account_id: args.billingAccountId,
      condition_id: args.conditionId,
      mode: args.mode,
    },
    summary,
    evidence: { fills, decisions },
    finding,
  };

  const htmlPath = resolve(args.out);
  const jsonPath = htmlPath.replace(/\.html$/i, "") + ".json";
  await mkdir(dirname(htmlPath), { recursive: true });
  await Promise.all([
    writeFile(htmlPath, renderHtml(bundle), "utf8"),
    writeFile(jsonPath, JSON.stringify(bundle, null, 2) + "\n", "utf8"),
  ]);
  process.stdout.write(`${htmlPath}\n${jsonPath}\n`);
}

async function readEvidence(
  args: Args,
  bearer: string,
  capturedAt: string,
  kind: "fills" | "decisions"
): Promise<PolyResearchCopyTradeInvestigationEvidenceResponse> {
  const items: PolyResearchCopyTradeInvestigationEvidenceResponse["items"] = [];
  let cursor: string | null = null;
  let lastPage: PolyResearchCopyTradeInvestigationEvidenceResponse | null = null;
  for (let page = 0; page < MAX_EVIDENCE_PAGES; page += 1) {
    lastPage = await getJson<PolyResearchCopyTradeInvestigationEvidenceResponse>(
      args.baseUrl,
      "/api/v1/poly/research/copy-trade-investigation/evidence",
      bearer,
      {
        billing_account_id: args.billingAccountId,
        condition_id: args.conditionId,
        mode: args.mode,
        kind,
        captured_at: capturedAt,
        limit: String(EVIDENCE_PAGE_LIMIT),
        ...(cursor ? { cursor } : {}),
      }
    );
    items.push(...lastPage.items);
    cursor = lastPage.next_cursor;
    if (!cursor) break;
  }
  if (!lastPage) throw new Error(`No ${kind} evidence response`);
  return {
    ...lastPage,
    items,
    next_cursor: cursor,
    truncated: cursor !== null,
  };
}

function deriveFinding(
  summary: PolyResearchCopyTradeInvestigationResponse,
  fills: PolyResearchCopyTradeInvestigationEvidenceResponse,
  decisions: PolyResearchCopyTradeInvestigationEvidenceResponse
): Finding {
  if (!summary.completeness.complete || fills.truncated || decisions.truncated) {
    const missing = summary.completeness.facts
      .filter((fact) => !fact.complete)
      .map((fact) => `${fact.source}:${fact.status}`)
      .join(", ");
    return {
      title: "Evidence is incomplete; do not rank the algorithm from this market yet",
      confidencePct: 95,
      charterClass: "evidence_quality",
      explanation: `Incomplete facts: ${missing || "paginated tape exceeded the 2,000-row client ceiling"}.`,
      codeCitation: "app/src/features/wallet-analysis/server/copy-trade-investigation-service.ts:1",
    };
  }

  const decisionSummary = summary.aggregates.decisions;
  if (decisionSummary.skipped_count + decisionSummary.error_count > decisionSummary.placed_count) {
    const reason = decisionSummary.top_reasons[0]?.reason ?? "unknown";
    return {
      title: `Decision policy is the primary divergence (${reason})`,
      confidencePct: 88,
      charterClass: "decision_policy",
      explanation: `${decisionSummary.skipped_count + decisionSummary.error_count} rejected decisions exceed ${decisionSummary.placed_count} placed decisions.`,
      codeCitation: "app/src/features/copy-trade/plan-mirror.ts:394",
    };
  }

  const targetLeg = summary.targets
    .flatMap((target) => target.legs.map((leg) => ({ ...leg, wallet: target.wallet_address })))
    .sort((left, right) => right.cost_basis_usdc - left.cost_basis_usdc)[0];
  const mirrorLeg = targetLeg
    ? summary.account_position.legs.find((leg) => leg.token_id === targetLeg.token_id)
    : summary.account_position.legs[0];
  if (targetLeg && mirrorLeg) {
    const shareGap = targetLeg.shares - mirrorLeg.net_shares;
    const shareGapPct = targetLeg.shares > 0 ? (shareGap / targetLeg.shares) * 100 : 0;
    const vwapGap =
      mirrorLeg.buy_vwap === null || targetLeg.avg_price === null
        ? null
        : mirrorLeg.buy_vwap - targetLeg.avg_price;
    if (Math.abs(shareGapPct) >= 10) {
      return {
        title: `Mirror exposure trails the target by ${shareGapPct.toFixed(1)}% on the primary leg`,
        confidencePct: 90,
        charterClass: "position_sizing",
        explanation: `Target ${targetLeg.shares.toFixed(4)} shares vs mirror ${mirrorLeg.net_shares.toFixed(4)}; VWAP delta ${vwapGap === null ? "unavailable" : vwapGap.toFixed(4)}.`,
        codeCitation: "app/src/features/copy-trade/plan-mirror.ts:255",
      };
    }
    return {
      title: "Position sizing is close; execution price is the next constraint to inspect",
      confidencePct: 82,
      charterClass: "execution_quality",
      explanation: `Primary-leg share gap is ${shareGapPct.toFixed(1)}%; VWAP delta is ${vwapGap === null ? "unavailable" : vwapGap.toFixed(4)}.`,
      codeCitation: "app/src/features/copy-trade/plan-mirror.ts:394",
    };
  }

  return {
    title: "No comparable target/mirror leg pair exists in the frozen snapshot",
    confidencePct: 98,
    charterClass: "evidence_quality",
    explanation: "The account is associated with the market, but saved position facts do not share a token leg.",
    codeCitation: "app/src/features/wallet-analysis/server/copy-trade-investigation-service.ts:1",
  };
}

async function getJson<T>(
  baseUrl: string,
  path: string,
  bearer: string,
  query: Record<string, string>
): Promise<T> {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${path}: ${body.slice(0, 500)}`);
  }
  return (await response.json()) as T;
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Arguments must be --name value pairs");
    values.set(key.slice(2), value);
  }
  const baseUrl = values.get("base-url");
  const billingAccountId = values.get("billing-account-id");
  const conditionId = values.get("condition-id");
  const out = values.get("out");
  const findingJson = values.get("finding-json");
  const mode = values.get("mode") ?? "all";
  if (!baseUrl || !billingAccountId || !conditionId || !out) {
    throw new Error("Required: --base-url --billing-account-id --condition-id --out");
  }
  if (mode !== "live" && mode !== "paper" && mode !== "all") {
    throw new Error("--mode must be live, paper, or all");
  }
  return {
    baseUrl,
    billingAccountId,
    conditionId,
    mode,
    out,
    ...(findingJson ? { findingJson } : {}),
  };
}

async function readAgentFinding(path: string): Promise<Finding> {
  const parsed: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid finding JSON");
  const value = parsed as Record<string, unknown>;
  const allowedClasses: Finding["charterClass"][] = [
    "evidence_quality",
    "decision_policy",
    "position_sizing",
    "execution_quality",
  ];
  if (
    typeof value.title !== "string" ||
    typeof value.explanation !== "string" ||
    typeof value.codeCitation !== "string" ||
    typeof value.confidencePct !== "number" ||
    value.confidencePct < 0 ||
    value.confidencePct > 100 ||
    !allowedClasses.includes(value.charterClass as Finding["charterClass"])
  ) {
    throw new Error("Finding JSON must contain title, explanation, codeCitation, confidencePct 0..100, and a supported charterClass");
  }
  return {
    title: value.title,
    explanation: value.explanation,
    codeCitation: value.codeCitation,
    confidencePct: value.confidencePct,
    charterClass: value.charterClass as Finding["charterClass"],
  };
}

function renderHtml(bundle: {
  generated_at: string;
  summary: PolyResearchCopyTradeInvestigationResponse;
  evidence: {
    fills: PolyResearchCopyTradeInvestigationEvidenceResponse;
    decisions: PolyResearchCopyTradeInvestigationEvidenceResponse;
  };
  finding: Finding;
}): string {
  const { summary, evidence, finding } = bundle;
  const rows = summary.targets
    .flatMap((target) =>
      target.legs.map((leg) => {
        const mirror = summary.account_position.legs.find(
          (candidate) => candidate.token_id === leg.token_id
        );
        return `<tr><td>${escapeHtml(target.label ?? target.wallet_address)}</td><td>${escapeHtml(leg.outcome ?? leg.token_id)}</td><td>${leg.shares.toFixed(4)}</td><td>${mirror?.net_shares.toFixed(4) ?? "—"}</td><td>${leg.avg_price?.toFixed(4) ?? "—"}</td><td>${mirror?.buy_vwap?.toFixed(4) ?? "—"}</td></tr>`;
      })
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Poly delta investigation</title><style>body{font:15px system-ui;max-width:1100px;margin:40px auto;padding:0 20px;color:#172033}h1,h2{margin-bottom:.4rem}.card{border:1px solid #ccd3df;border-radius:12px;padding:18px;margin:16px 0}.finding{border-left:6px solid #6657d9;background:#f5f3ff}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px;border-bottom:1px solid #e5e8ee}.muted{color:#667085}</style></head><body><h1>${escapeHtml(summary.market.market_title ?? summary.condition_id)}</h1><p class="muted">Frozen at ${escapeHtml(summary.captured_at)} · ${escapeHtml(summary.mode)} · scoped API only</p><section class="card finding"><h2>Top finding · ${finding.confidencePct}% confidence</h2><strong>${escapeHtml(finding.title)}</strong><p>${escapeHtml(finding.explanation)}</p><p class="muted">${escapeHtml(finding.charterClass)} · ${escapeHtml(finding.codeCitation)}</p></section><section class="card"><h2>Position delta</h2><table><thead><tr><th>Target</th><th>Outcome</th><th>Target shares</th><th>Mirror shares</th><th>Target avg</th><th>Mirror VWAP</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No comparable legs</td></tr>'}</tbody></table></section><section class="card"><h2>Decision and execution tape</h2><p>${summary.aggregates.decisions.placed_count} placed · ${summary.aggregates.decisions.skipped_count} skipped · ${summary.aggregates.decisions.error_count} errors</p><p>${evidence.fills.items.length} fill rows · ${evidence.decisions.items.length} decision rows · ${summary.completeness.complete ? "complete" : "incomplete"} snapshot</p></section></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] ?? character);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
