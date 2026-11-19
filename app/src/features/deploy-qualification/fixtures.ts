// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Public, dedicated agent fixtures. Provision through register + paper-account, never SQL. */
export const qualificationFixtures = {
	"candidate-a": {
		ownerId: "bac2351c-89ae-404c-b8e8-d6079497eb19",
		accountId: "c99f63d8-312d-4ff0-b46d-0498d1889159",
	},
	preview: {
		ownerId: "2cc7f250-62b6-45f7-b5c5-cf2022f2cc99",
		accountId: "e7f20f68-b689-473c-bc74-2d46ee770f13",
	},
} as const;
export type QualificationFixture = { ownerId: string; accountId: string };
