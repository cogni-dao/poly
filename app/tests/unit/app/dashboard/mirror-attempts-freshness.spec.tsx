// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Dashboard decision freshness, historical rows and unavailable states. @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: query }));
vi.mock("@/components", () => {
	const Div = ({ children }: { children: ReactNode }) => <div>{children}</div>;
	return {
		Card: Div,
		CardContent: Div,
		CardHeader: Div,
		CardTitle: Div,
		Table: ({ children }: { children: ReactNode }) => <table>{children}</table>,
		TableBody: ({ children }: { children: ReactNode }) => (
			<tbody>{children}</tbody>
		),
		TableCell: ({ children }: { children: ReactNode }) => <td>{children}</td>,
		TableHead: ({ children }: { children: ReactNode }) => <th>{children}</th>,
		TableHeader: ({ children }: { children: ReactNode }) => (
			<thead>{children}</thead>
		),
		TableRow: ({ children }: { children: ReactNode }) => <tr>{children}</tr>,
	};
});

import { MirrorAttemptsCard } from "@/app/(app)/dashboard/_components/MirrorAttemptsCard";

const decidedAt = "2026-10-13T06:08:30.669Z";
const attempt = {
	attempt_id: "historical-rejection",
	decided_at: decidedAt,
	market_title: "Historical rejected market",
	algorithm: { availability: "unavailable" },
	intended: { side: "BUY", size_usdc: 5 },
	decision: { outcome: "error", reason: "lineage_identity_ambiguous" },
	executed: { availability: "no_order_placed" },
};

function result(status = "stale", attempts = [attempt]) {
	return {
		data: {
			attempts,
			captured_at: "2026-10-16T00:17:11.000Z",
			freshness: {
				status,
				most_recent_attempt_at: status === "never_attempted" ? null : decidedAt,
				staleness_seconds: status === "never_attempted" ? null : 238_121,
			},
		},
		isLoading: false,
		isError: false,
	};
}

beforeEach(() => {
	query.mockReturnValue(result());
	// Pin the viewer's local timezone across the UTC date boundary in this incident.
	vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (
		this: Date,
		_locales,
		options,
	) {
		return new Intl.DateTimeFormat("en-US", {
			...options,
			timeZone: "America/Los_Angeles",
		}).format(this);
	});
});
afterEach(() => vi.restoreAllMocks());

describe("MirrorAttemptsCard freshness", () => {
	it("shows the historical date, local timezone and canonical stale age", () => {
		render(<MirrorAttemptsCard />);

		expect(
			screen.getByText(/Stale activity.*Latest decision:/),
		).toHaveTextContent(/Oct 12, 2026.*11:08:30 PM PDT.*2d 18h ago/);
		expect(screen.getByText("Oct 12, 2026, 11:08:30 PM PDT")).toHaveAttribute(
			"dateTime",
			decidedAt,
		);
		expect(screen.getByText("Historical rejected market")).toBeInTheDocument();
		expect(
			screen.getByText("error · lineage_identity_ambiguous"),
		).toBeInTheDocument();
		expect(screen.getByText("1 of 1 rejected")).toBeInTheDocument();
	});

	it("uses the API's fresh status and age without deriving them from fetch time", () => {
		const fresh = result("fresh");
		fresh.data.freshness.staleness_seconds = 90;
		query.mockReturnValue(fresh);
		render(<MirrorAttemptsCard />);

		expect(screen.getByText(/Latest decision:/)).toHaveTextContent(/1m ago/);
		expect(screen.queryByText(/Stale activity/)).not.toBeInTheDocument();
		expect(screen.getByText("Historical rejected market")).toBeInTheDocument();
	});

	it("distinguishes never attempted from stale or unavailable decisions", () => {
		query.mockReturnValue(result("never_attempted", []));
		render(<MirrorAttemptsCard />);

		expect(screen.getByText(/No algorithm decisions yet/)).toBeInTheDocument();
		expect(
			screen.queryByText(/Stale activity|Latest decision:/),
		).not.toBeInTheDocument();
	});

	it("keeps historical errors visible when a refresh fails", () => {
		query.mockReturnValue({ ...result(), isError: true });
		render(<MirrorAttemptsCard />);

		expect(
			screen.getByText(/Could not refresh mirror attempts/),
		).toBeInTheDocument();
		expect(screen.getByText("Historical rejected market")).toBeInTheDocument();
		expect(
			screen.getByText(/Stale activity.*Latest decision:/),
		).toBeInTheDocument();
	});

	it("shows fetch failure separately from no decisions", () => {
		query.mockReturnValue({ data: undefined, isLoading: false, isError: true });
		render(<MirrorAttemptsCard />);

		expect(
			screen.getByText("Could not load mirror attempts."),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/No algorithm decisions yet/),
		).not.toBeInTheDocument();
	});
});
