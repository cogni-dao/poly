// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type Redis from "ioredis";
import type { NodeActionReplayPort } from "@/ports/node-action-replay.port";

export class RedisNodeActionReplayAdapter implements NodeActionReplayPort {
	constructor(private readonly redis: Redis) {}
	async consume(jti: string, ttlSeconds: number): Promise<boolean> {
		const ttl = Math.max(1, Math.min(120, Math.floor(ttlSeconds)));
		return (
			(await this.redis.set(`node-action:jti:${jti}`, "1", "EX", ttl, "NX")) ===
			"OK"
		);
	}
}
