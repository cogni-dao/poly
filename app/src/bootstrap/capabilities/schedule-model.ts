// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { ModelRef } from "@cogni/ai-core";
import type { ScheduleCapability } from "@cogni/ai-tools";

/** Bind each initiating run's server-selected model to new shared schedules. */
export function bindScheduleModel(
  capability: ScheduleCapability,
  modelRef: ModelRef,
): ScheduleCapability {
  const trustedModel = { ...modelRef };
  return {
    ...capability,
    create: (input) =>
      capability.create({
        ...input,
        input: { ...input.input, modelRef: trustedModel },
      }),
  };
}
