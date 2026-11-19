// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/db-client/pool-options`
 * Purpose: Verifies pool-size options and application_name wiring of the db-client factories (task.5014).
 * Scope: Constructs clients against a dummy DSN and inspects postgres-js `$client.options`. Does NOT open connections (postgres-js pools are lazy until first query).
 * Invariants: No live DB required; every client is `end()`ed; package defaults 1/4/2 for app/service/service-read (bug.5045 — fit the dedicated role ceilings app 4 / service 8).
 * Side-effects: none (no sockets opened)
 * Links: packages/db-client/src/build-client.ts, packages/db-client/src/service.ts
 * @public
 */

import { createAppDbClient, type Database } from "@cogni/db-client";
import {
  createServiceDbClient,
  createServiceReadDbClient,
} from "@cogni/db-client/service";
import { afterEach, describe, expect, it } from "vitest";

const DSN = "postgresql://someone:pw@localhost:5432/pool_options_test";

const created: Database[] = [];
function track<T extends Database>(db: T): T {
  created.push(db);
  return db;
}

afterEach(async () => {
  await Promise.all(created.map((db) => db.$client.end({ timeout: 0 })));
  created.length = 0;
});

describe("db-client pool options (task.5014)", () => {
  it("app pool defaults to max 1 (DEFAULT_POOL_MAX) with application_name cogni_template_app", () => {
    const db = track(createAppDbClient(DSN));
    expect(db.$client.options.max).toBe(1);
    expect(db.$client.options.connection.application_name).toBe(
      "cogni_template_app"
    );
  });

  it("service pool defaults to max 4 (DEFAULT_SERVICE_POOL_MAX) with application_name cogni_service", () => {
    const db = track(createServiceDbClient(DSN));
    expect(db.$client.options.max).toBe(4);
    expect(db.$client.options.connection.application_name).toBe(
      "cogni_service"
    );
  });

  it("service READ pool defaults to max 2 (DEFAULT_READ_POOL_MAX) with application_name cogni_service_read", () => {
    const db = track(createServiceReadDbClient(DSN));
    expect(db.$client.options.max).toBe(2);
    expect(db.$client.options.connection.application_name).toBe(
      "cogni_service_read"
    );
  });

  it("honors an injected max on every factory", () => {
    expect(track(createAppDbClient(DSN, { max: 3 })).$client.options.max).toBe(
      3
    );
    expect(
      track(createServiceDbClient(DSN, { max: 7 })).$client.options.max
    ).toBe(7);
    expect(
      track(createServiceReadDbClient(DSN, { max: 2 })).$client.options.max
    ).toBe(2);
  });
});
