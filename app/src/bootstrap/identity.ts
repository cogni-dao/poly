// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Composition-only identity binding dependencies; contains no use-case policy. */

import { randomUUID } from "node:crypto";

import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import { DrizzleIdentityBindingRepository } from "@/adapters/server/identity/identity-binding.adapter";
import { getContainer } from "@/bootstrap/container";

export function resolveIdentityBindingDependencies() {
	return {
		repository: new DrizzleIdentityBindingRepository(getServiceDb()),
		clock: getContainer().clock,
		createNonceId: randomUUID,
	};
}
