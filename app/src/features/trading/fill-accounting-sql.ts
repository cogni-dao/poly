// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Guarded SQL counterpart of the pure paper receipt decoder. No raw-row hydration. */
import { type SQL, sql } from "drizzle-orm";
import {
	FILL_NOTIONAL_TOLERANCE,
	FILL_SHARE_TOLERANCE,
	PAPER_RECEIPT_SOURCE,
	PAPER_RECEIPT_VERSION,
} from "./fill-accounting";

/** A JSON/text number is never cast before the finite decimal grammar is checked. */
export function fillNumericSql(value: SQL): SQL {
	return sql`(CASE WHEN length(${value}) <= 320
    AND ${value} ~ '^-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?$'
    AND length(split_part(lower(${value}), 'e', 2)) <= 4
    THEN CASE WHEN abs((${value})::numeric) <= 1.7976931348623157e308::numeric
      THEN (${value})::numeric END END)`;
}

/** PostgreSQL15 has no pg_input_is_valid. Validate calendar bounds before casts. */
function observationClockSql(value: SQL): SQL {
	return sql`(CASE WHEN ${value} ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z$'
    AND substring(${value}, 1, 4) <> '0000'
    THEN CASE WHEN substring(${value}, 9, 2)::int <= extract(day FROM
      make_date(substring(${value}, 1, 4)::int, substring(${value}, 6, 2)::int, 1)
        + interval '1 month' - interval '1 day')
      THEN (${value})::timestamptz END END)`;
}

/**
 * alias names a ledger row already scoped by its caller. The canonical connection
 * check binds the saved server context; a source tag or mode alone never passes.
 * Returned predicates are shared by positive totals AND their pending complement.
 */
export function paperFillAccountingSql(
	alias: string,
	capturedAt: SQL = sql`now()`,
): {
	positive: SQL;
	zero: SQL;
	verified: SQL;
	feeKnown: SQL;
	observedAt: SQL;
	proofKey: SQL;
} {
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias))
		throw new Error("invalid ledger SQL alias");
	const f = sql.raw(alias);
	const p = sql`${f}.attributes->'paper_receipt_v1'`;
	const shares = fillNumericSql(sql`${p}->>'shares'`);
	const cost = fillNumericSql(sql`${p}->>'notional_usdc'`);
	const price = fillNumericSql(sql`${p}->>'price'`);
	const fee = fillNumericSql(sql`${p}->>'fees_usdc'`);
	const durableCost = fillNumericSql(sql`${f}.attributes->>'filled_size_usdc'`);
	const observedAt = observationClockSql(sql`${p}->>'observed_at'`);
	const textKey = (value: SQL) =>
		sql`encode(convert_to(${value}, 'UTF8'), 'hex')`;
	const numberKey = (value: SQL) => sql`(CASE WHEN ${value} IS NULL THEN 'null'
    WHEN ${value} = 0 THEN encode(float8send(0::float8), 'hex')
    WHEN abs(${value}) >= 4.9406564584124654e-324::numeric
      THEN encode(float8send((${value})::float8), 'hex') END)`;
	const semanticKey = sql`concat_ws(':', ${textKey(sql`${p}->>'version'`)}, ${textKey(sql`${p}->>'mode'`)},
    ${textKey(sql`${p}->>'billing_account_id'`)}, ${textKey(sql`${p}->>'connection_id'`)},
    ${textKey(sql`${p}->>'client_order_id'`)}, ${textKey(sql`${p}->>'order_id'`)},
    ${textKey(sql`${p}->>'condition_id'`)}, ${textKey(sql`${p}->>'token_id'`)}, ${textKey(sql`${p}->>'side'`)},
    ${textKey(sql`${p}->>'venue_status'`)}, ${textKey(sql`CASE WHEN ${p}->'fee_known' = 'true'::jsonb THEN '1' ELSE '0' END`)},
    ${textKey(sql`CASE WHEN ${p}->'terminal' = 'true'::jsonb THEN '1' ELSE '0' END`)})
    || '|' || concat_ws(':', ${numberKey(shares)}, ${numberKey(cost)}, ${numberKey(price)}, ${numberKey(fee)})`;
	const tolerance = sql`greatest(${FILL_NOTIONAL_TOLERANCE}::numeric, abs(${cost}) * ${FILL_NOTIONAL_TOLERANCE}::numeric)`;
	const feeKnown = sql`(${p}->'fee_known' = 'true'::jsonb AND jsonb_typeof(${p}->'fees_usdc') = 'number' AND ${fee} >= 0
    AND round(${fee}, 8) = ${f}.fees_usdc)`;
	const bound = sql`COALESCE((
    ${f}.mode = 'paper'
    AND ${f}.attributes->>'realized_fill_source' = ${PAPER_RECEIPT_SOURCE}
    AND ${p}->'version' = ${JSON.stringify(PAPER_RECEIPT_VERSION)}::jsonb
    AND ${p}->>'source' = ${PAPER_RECEIPT_SOURCE}
    AND ${p}->>'mode' = 'paper'
    AND ${p}->>'billing_account_id' = ${f}.billing_account_id
    AND ${p}->>'client_order_id' = ${f}.client_order_id
    AND ${p}->>'order_id' = ${f}.order_id AND ${f}.order_id <> ''
    AND ${p}->>'condition_id' ~ '^0x[0-9a-f]{64}$'
    AND ${p}->>'condition_id' = lower(regexp_replace(
      COALESCE(NULLIF(${f}.attributes->>'condition_id', ''), ${f}.market_id),
      '^prediction-market:polymarket:', '', 'i'))
    AND ${p}->>'condition_id' = lower(regexp_replace(${f}.market_id, '^prediction-market:polymarket:', '', 'i'))
    AND ${p}->>'token_id' ~ '^[0-9]+$'
    AND ${p}->>'token_id' = ${f}.attributes->>'token_id'
    AND ${p}->>'side' IN ('BUY', 'SELL')
    AND ${p}->>'side' = ${f}.attributes->>'side'
    AND ${p}->>'venue_status' = ${f}.status
    AND ${p}->'terminal' = to_jsonb(${f}.status IN ('filled', 'canceled'))
    AND ${p}->>'proof_key' = ${semanticKey}
    AND ${observedAt} <= ${capturedAt}
    AND jsonb_typeof(${p}->'shares') = 'number' AND jsonb_typeof(${p}->'notional_usdc') = 'number'
    AND ${shares} >= 0 AND ${cost} >= 0
    AND abs(COALESCE(${f}.shares, 0) - round(${shares}, 8)) <= ${FILL_SHARE_TOLERANCE}::numeric
    AND abs(${durableCost} - ${cost}) <= ${tolerance}
    AND ((${feeKnown}) OR (${p}->'fee_known' = 'false'::jsonb AND ${p}->'fees_usdc' = 'null'::jsonb))
    AND EXISTS (
      SELECT 1 FROM poly_wallet_connections paper_proof_connection
      WHERE paper_proof_connection.id::text = ${p}->>'connection_id'
        AND paper_proof_connection.billing_account_id = ${f}.billing_account_id
        AND paper_proof_connection.kind = 'paper'
        AND lower(paper_proof_connection.address) = '0x' || substr(encode(sha256(convert_to(
          'cogni:poly:paper-account:v1:' || ${f}.billing_account_id, 'UTF8')), 'hex'), 1, 40)
        AND lower(paper_proof_connection.funder_address) = lower(paper_proof_connection.address)
        AND paper_proof_connection.created_at <= ${observedAt}
        AND (paper_proof_connection.revoked_at IS NULL OR paper_proof_connection.revoked_at >= ${observedAt})
    )
  ), false)`;
	const positive = sql`COALESCE((${bound} AND ${shares} > 0 AND ${cost} > 0 AND ${price} > 0
    AND jsonb_typeof(${p}->'price') = 'number'
    AND round(${price}, 8) = ${f}.price
    AND abs(${shares} * ${price} - ${cost}) <= ${tolerance}), false)`;
	const zero = sql`COALESCE((${bound} AND ${f}.status = 'canceled' AND ${shares} = 0 AND ${cost} = 0
    AND ${p}->'price' = 'null'::jsonb AND COALESCE(${f}.shares, 0) = 0), false)`;
	return {
		positive,
		zero,
		verified: sql`(${positive} OR ${zero})`,
		feeKnown: sql`(${bound} AND ${feeKnown})`,
		observedAt,
		proofKey: sql`${p}->>'proof_key'`,
	};
}
