// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/service-links`
 * Purpose: This node's thin wiring for calling OTHER nodes as its own AI (story.0038 phase 2): the remote-knowledge transport the stock knowledge tools use, and the
 *   outbound ask that enrolls this node's AI on a target.
 * Scope: Composition only. Takes the targets from `.cogni/service-links.yaml` (parsed in `service-links-config.ts`); signs with this node's service assertion signer (`createServiceAuth`) as service `node-ai`, `aud` = the target's node id.
 *   The transport rules (https, configured origin, GET, no redirects, timeout, size cap, redaction) live in `@cogni/ai-tools`; this file adds the logs and the ask.
 * Invariants:
 *   - ALIAS_FROM_SERVER_CONFIG: an alias that is not in the deployment's `targets` is refused before any signing or network call.
 *   - NO_SIGNER_NO_CALL: without a signing key every outbound call is refused (`unavailable`), never sent unsigned.
 *   - ASK_IS_ONE_FIXED_POST: the ask is a POST of `{ scope }` to `{origin}/api/v1/public/agent/service-enrollments` on the configured origin only, https, no redirects, 10 s, 64 KiB cap.
 *   - NO_TOKEN_IN_LOGS: `remote_knowledge.read` and `service_link.asked` carry alias, operation, outcome and status, never an assertion, a header or a body.
 * Side-effects: IO (HTTPS to a configured node)
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment, packages/ai-tools/src/remote-knowledge.ts
 * @internal
 */

import {
  createRemoteKnowledgeTransport,
  readBodyCapped,
  REMOTE_KNOWLEDGE_SERVICE,
  RemoteKnowledgeError,
  type RemoteKnowledgeCapability,
  type RemoteKnowledgeTarget,
} from "@cogni/shared-ai-tools";
import type { ServiceAssertionSigner } from "@cogni/agent-grants/service-auth";
import type { Logger } from "pino";
import { EVENT_NAMES } from "@/shared/observability";

const ASK_TIMEOUT_MS = 10_000;
const MAX_ASK_BODY_BYTES = 64 * 1024;
const ENROLLMENT_PATH = "/api/v1/public/agent/service-enrollments";

export type ServiceLinkAskResult =
  | { readonly ok: true; readonly alias: string; readonly status: "pending" | "granted" | null; readonly httpStatus: number }
  | { readonly ok: false; readonly reason: "unknown_alias" | "no_signer" | "unreachable" };

export interface ServiceLinks {
  readonly targets: readonly RemoteKnowledgeTarget[];
  /** The remote-knowledge capability the stock `core__knowledge_read` and `core__knowledge_search` tools take. */
  readonly remoteKnowledge: RemoteKnowledgeCapability;
  /** This node's AI asks the target for one permission. The target's admin decides; nothing is granted here. */
  ask(alias: string, scope: string): Promise<ServiceLinkAskResult>;
}

export function createServiceLinks(deps: {
  /** The nodes this deployment may call, from `.cogni/service-links.yaml` (empty = every alias is unknown). */
  readonly targets: readonly RemoteKnowledgeTarget[];
  /** Read lazily: the signer is built after the tool bindings. */
  readonly signer: () => Promise<ServiceAssertionSigner | null>;
  readonly log: Logger;
  readonly fetchImpl?: typeof fetch;
}): ServiceLinks {
  const targets = [...deps.targets];
  const byAlias = new Map(targets.map((t) => [t.alias, t]));
  const doFetch = deps.fetchImpl ?? fetch;

  const authorize = async (target: RemoteKnowledgeTarget, scope: string): Promise<string> => {
    const signer = await deps.signer();
    if (!signer) throw new Error("no signer");
    return signer.authorizationHeader({ service: REMOTE_KNOWLEDGE_SERVICE, audienceNodeId: target.nodeId, scope });
  };
  const transport = createRemoteKnowledgeTransport({
    targets,
    authorize,
    fetchImpl: doFetch,
    // The AI's own ask (a 401 to a signed read): alias, scope and the target's status, never a token.
    onAsked: ({ alias, scope, httpStatus }) =>
      deps.log.info({ event: EVENT_NAMES.SERVICE_LINK_ASKED, alias, scope, httpStatus, via: "tool" }, EVENT_NAMES.SERVICE_LINK_ASKED),
  });

  const logged = async <T>(alias: string, op: string, call: () => Promise<T>): Promise<T> => {
    try {
      const result = await call();
      deps.log.info({ event: EVENT_NAMES.REMOTE_KNOWLEDGE_READ, alias, op, outcome: "ok" }, EVENT_NAMES.REMOTE_KNOWLEDGE_READ);
      return result;
    } catch (error) {
      const outcome = error instanceof RemoteKnowledgeError ? error.code : "error";
      deps.log.warn({ event: EVENT_NAMES.REMOTE_KNOWLEDGE_READ, alias, op, outcome }, EVENT_NAMES.REMOTE_KNOWLEDGE_READ);
      throw error;
    }
  };

  const remoteKnowledge: RemoteKnowledgeCapability = {
    originOf: (alias) => transport.originOf(alias),
    get: (alias, id) => logged(alias, "get", () => transport.get(alias, id)),
    list: (alias, params) => logged(alias, "list", () => transport.list(alias, params)),
    search: (alias, params) => logged(alias, "search", () => transport.search(alias, params)),
  };

  return {
    targets,
    remoteKnowledge,
    async ask(alias, scope) {
      const target = byAlias.get(alias);
      if (!target) return { ok: false, reason: "unknown_alias" };
      const signer = await deps.signer();
      if (!signer) return { ok: false, reason: "no_signer" };
      let response: Response;
      try {
        const authorization = await signer.authorizationHeader({
          service: REMOTE_KNOWLEDGE_SERVICE,
          audienceNodeId: target.nodeId,
          scope,
        });
        response = await doFetch(new URL(ENROLLMENT_PATH, target.origin).href, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json", authorization },
          body: JSON.stringify({ scope }),
          redirect: "manual",
          signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
        });
      } catch {
        deps.log.warn({ event: EVENT_NAMES.SERVICE_LINK_ASKED, alias, scope, outcome: "unreachable" }, EVENT_NAMES.SERVICE_LINK_ASKED);
        return { ok: false, reason: "unreachable" };
      }
      let status: "pending" | "granted" | null = null;
      if (response.ok) {
        try {
          const text = await readBodyCapped(response, MAX_ASK_BODY_BYTES);
          const parsed = JSON.parse(text ?? "{}") as { status?: unknown };
          if (parsed.status === "pending" || parsed.status === "granted") status = parsed.status;
        } catch {
          status = null;
        }
      } else {
        await response.body?.cancel().catch(() => undefined);
      }
      deps.log.info(
        { event: EVENT_NAMES.SERVICE_LINK_ASKED, alias, scope, httpStatus: response.status, status },
        EVENT_NAMES.SERVICE_LINK_ASKED
      );
      return { ok: true, alias, status, httpStatus: response.status };
    },
  };
}
