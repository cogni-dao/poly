// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/_fakes/drizzle-query-chain`
 * Purpose: A Drizzle query-builder stand-in that is chainable for ANY clause,
 *   so a unit test stubbing a read does not break when the query it stubs
 *   grows a `.orderBy()` / `.groupBy()` / `.offset()`.
 * Scope: Unit tests only, for reads whose ROWS are the thing under test. Does
 *   not execute SQL and does not emulate Drizzle semantics.
 * Invariants:
 *   - CHAINABLE_BY_DEFAULT: every method returns the builder, so clause order
 *     and clause count are irrelevant. Hand-rolled stubs that implement an
 *     exact method set (`from -> where -> limit`) silently encode the query's
 *     current shape and fail with
 *     `TypeError: ....orderBy is not a function` the moment a clause is added
 *     — a test breaking on a change it was never meant to cover.
 *   - TERMINAL_IS_THE_AWAIT: the builder is a thenable, so the chain resolves
 *     wherever the caller awaits it, rather than at one designated method.
 *   - SHAPE_IS_NOT_ASSERTED: this stub deliberately proves nothing about the
 *     emitted SQL — it cannot catch a dropped WHERE or a wrong join. Query
 *     shape belongs in the component lane against real Postgres (see
 *     `app/tests/component/db/`). Use this only when the assertion is about
 *     how the feature interprets rows.
 * Side-effects: none
 * Notes: Imported by direct path rather than through `@tests/_fakes` on
 *   purpose — the barrel pulls in adapter, AI and payment fakes that a pure
 *   row-mapping unit test has no reason to load.
 * Links: app/tests/unit/features/wallet-analysis/funder-only-identity.test.ts
 * @internal
 */

/**
 * A chainable, awaitable Drizzle query-builder stub.
 *
 * Any method call returns the same builder; awaiting it anywhere in the chain
 * resolves to `rows`.
 *
 * @param rows - The rows the query should resolve to.
 * @internal
 */
// biome-ignore lint/suspicious/noExplicitAny: a structural stand-in for Drizzle's deeply-generic builder
export function drizzleQueryChain(rows: readonly unknown[]): any {
  const resolved = Promise.resolve(rows);
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const builder: any = new Proxy(
    {},
    {
      get(_target, property) {
        // Symbols must fall through as undefined. Returning a callable for
        // `Symbol.for("nodejs.util.inspect.custom")` would make any attempt to
        // print this object (a vitest failure message, a console.log) recurse
        // until the stack blows.
        if (typeof property === "symbol") return undefined;
        if (
          property === "then" ||
          property === "catch" ||
          property === "finally"
        ) {
          return resolved[property].bind(resolved);
        }
        return () => builder;
      },
    }
  );
  return builder;
}

/**
 * A `db`-shaped stub whose `.select()` opens a {@link drizzleQueryChain}.
 *
 * Returns `never` so it satisfies whichever concrete Drizzle database type the
 * function under test declares, matching the `as never` idiom already used
 * across these unit tests.
 *
 * @param rows - The rows the select should resolve to.
 * @internal
 */
export function fakeSelectDb(rows: readonly unknown[]): never {
  return { select: () => drizzleQueryChain(rows) } as never;
}
