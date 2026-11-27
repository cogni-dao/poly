// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Thin unauthenticated GitHub binding; the published gate owns cache/deadline/refusals. */
import { parsePullRequestUrl, type PrFactsPort } from "@cogni/work-items";

export const githubPrFacts: PrFactsPort = {
	async read(url, signal) {
		const pr = parsePullRequestUrl(url);
		if (!pr) throw new Error("invalid_pull_request");
		const response = await fetch(
			`https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
			{
				signal,
				redirect: "error",
				headers: { accept: "application/vnd.github+json" },
			},
		);
		if (!response.ok) throw new Error(`github_pr_read_${response.status}`);
		const body: unknown = await response.json();
		if (
			typeof body !== "object" ||
			body === null ||
			!("head" in body) ||
			typeof body.head !== "object" ||
			body.head === null ||
			!("sha" in body.head) ||
			typeof body.head.sha !== "string" ||
			!/^[a-f0-9]{40}$/i.test(body.head.sha) ||
			!("merged" in body) ||
			typeof body.merged !== "boolean"
		)
			throw new Error("invalid_pr_facts");
		return { head: body.head.sha, merged: body.merged };
	},
};
