// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Re-prove dedicated machine ownership and normal paper grant under the owner's RLS. */
import type { Database } from "@cogni/db-client";
import { billingAccounts, users } from "@cogni/db-schema";
import { polyWalletConnections, polyWalletGrants } from "@cogni/poly-db-schema";
import { and, eq, isNull } from "drizzle-orm";
import { QualificationError } from "./challenge";
import type { QualificationFixture } from "./fixtures";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export async function assertQualificationFixture(
	tx: Tx,
	fixture: QualificationFixture,
	now: Date,
) {
	const [owner] = await tx
		.select({ owner: billingAccounts.ownerUserId, wallet: users.walletAddress })
		.from(billingAccounts)
		.innerJoin(users, eq(users.id, billingAccounts.ownerUserId))
		.where(
			and(
				eq(billingAccounts.id, fixture.accountId),
				eq(billingAccounts.ownerUserId, fixture.ownerId),
			),
		)
		.limit(1);
	if (!owner || owner.wallet !== null)
		throw new QualificationError("qualification_agent_owner_missing");
	const connections = await tx
		.select()
		.from(polyWalletConnections)
		.where(
			and(
				eq(polyWalletConnections.billingAccountId, fixture.accountId),
				isNull(polyWalletConnections.revokedAt),
			),
		)
		.limit(3);
	// These fixed owner IDs are normal /agent/register receipts. Legacy blue stamped
	// their genuine agent consent as user; that audit label is not principal authority.
	const paper = connections[0];
	if (
		connections.length !== 1 ||
		!paper ||
		paper.kind !== "paper" ||
		paper.createdByUserId !== fixture.ownerId ||
		paper.custodialConsentActorId !== fixture.ownerId ||
		!paper.tradingApprovalsReadyAt
	)
		throw new QualificationError("qualification_paper_fixture_missing");
	const [grant] = await tx
		.select()
		.from(polyWalletGrants)
		.where(
			and(
				eq(polyWalletGrants.billingAccountId, fixture.accountId),
				eq(polyWalletGrants.walletConnectionId, paper.id),
				isNull(polyWalletGrants.revokedAt),
			),
		)
		.limit(1);
	if (
		!grant ||
		!grant.scopes.includes("poly:trade:buy") ||
		Number(grant.perOrderUsdcCap) < 1 ||
		Number(grant.dailyUsdcCap) < 1 ||
		(grant.expiresAt && new Date(grant.expiresAt).getTime() <= now.getTime())
	)
		throw new QualificationError("qualification_paper_grant_missing");
}
