// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Bounded exponential backoff for failed position-gap reconcile runs
 * (bug.5051). Without it a persistent failure (e.g. Postgres 57014) re-enqueued
 * from timer and wake events every ~14s, each retry burning another 8s of DB.
 *
 * Pure: the actor owns timers; this owns only the arithmetic and state.
 */

export const POSITION_GAP_FAILURE_BACKOFF_BASE_MS = 15_000;
export const POSITION_GAP_FAILURE_BACKOFF_CAP_MS = 5 * 60_000;

/** 15s, 30s, 60s, 120s, 240s, then 300s forever. */
export function positionGapFailureBackoffMs(
	consecutiveFailures: number,
): number {
	if (consecutiveFailures <= 0) return 0;
	const exponent = Math.min(consecutiveFailures - 1, 16);
	return Math.min(
		POSITION_GAP_FAILURE_BACKOFF_CAP_MS,
		POSITION_GAP_FAILURE_BACKOFF_BASE_MS * 2 ** exponent,
	);
}

export class PositionGapFailureBackoff {
	private failures = 0;
	private untilMs = 0;

	/** Record a failed run; returns the new streak length and backoff window. */
	recordFailure(nowMs: number): {
		consecutiveFailures: number;
		backoffMs: number;
	} {
		this.failures += 1;
		const backoffMs = positionGapFailureBackoffMs(this.failures);
		this.untilMs = nowMs + backoffMs;
		return { consecutiveFailures: this.failures, backoffMs };
	}

	/** Record a successful run; returns the streak that just ended. */
	recordSuccess(): number {
		const ended = this.failures;
		this.failures = 0;
		this.untilMs = 0;
		return ended;
	}

	/** Milliseconds until the next run may start (0 when not backing off). */
	remainingMs(nowMs: number): number {
		return Math.max(0, this.untilMs - nowMs);
	}
}
