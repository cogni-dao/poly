// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/temporal`
 * Purpose: Temporal adapter exports.
 * Scope: Re-exports Temporal schedule control adapters. Does not contain implementations.
 * Invariants: Named exports only
 * Side-effects: none
 * Links: ScheduleControlPort, https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/scheduler.md
 * @public
 */

export {
  TemporalScheduleControlAdapter,
  type TemporalScheduleControlConfig,
} from "./schedule-control.adapter";
