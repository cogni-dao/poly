// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/repo-spec/service-links`
 * Purpose: Read the environment's section of `.cogni/service-links.yaml` (story.0038): the homes whose signed assertions a node trusts and the nodes its AI may call.
 *   Public URLs belong in Git config, so this file is committed and keyed by `DEPLOY_ENVIRONMENT`.
 * Scope: Pure. Takes the file's text and the environment name; returns the raw `trusted_homes` and `targets` values for the strict parsers in `@cogni-dao/agent-grants`
 *   (`parseTrustedHomes`, `parseLinkTargets`). Does no file I/O and validates no entry.
 * Invariants: FAIL_CLOSED: a missing environment key, an unreadable file, or a value that is not a mapping is no homes and no targets, never a thrown error and never another environment's section. `status` tells a routine empty (`no_environment`) from a mistake (`malformed`).
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import { parse } from "yaml";

/**
 * The raw sections of one environment. Each is `unknown` until a strict parser has seen it. `status` says why a section is empty: `ok` (the key exists), `no_environment` (no such key: routine,
 * a deployment with no links) or `malformed` (the file or the section is not YAML mappings: an operator mistake worth a warning).
 */
export interface ServiceLinksSection {
  readonly trustedHomes: unknown;
  readonly targets: unknown;
  readonly status: "ok" | "no_environment" | "malformed";
}

const NONE: ServiceLinksSection = { trustedHomes: [], targets: [], status: "no_environment" };
const MALFORMED: ServiceLinksSection = { trustedHomes: [], targets: [], status: "malformed" };

/** The `trusted_homes` and `targets` of `environment` in the file's text, or none when the file, the key or the shape is not usable. */
export function parseServiceLinksFile(content: string, environment: string | undefined): ServiceLinksSection {
  if (!environment) return NONE;
  try {
    const file: unknown = parse(content);
    if (file === null || typeof file !== "object" || Array.isArray(file)) return MALFORMED;
    if (!Object.prototype.hasOwnProperty.call(file, environment)) return NONE;
    const section = (file as Record<string, unknown>)[environment];
    if (section === null || typeof section !== "object" || Array.isArray(section)) return MALFORMED;
    const s = section as { trusted_homes?: unknown; targets?: unknown };
    return { trustedHomes: s.trusted_homes ?? [], targets: s.targets ?? [], status: "ok" };
  } catch {
    return MALFORMED;
  }
}
