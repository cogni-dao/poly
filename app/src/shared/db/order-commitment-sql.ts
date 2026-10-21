// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Conservative persisted order commitment, before position-lifecycle filtering.
 * Shared by position reservations and grant windows; closed holdings still
 * consume the grant window in which their intent was created. Invalid amounts
 * raise a SQL error so authorization fails closed, including invalid intended
 * amounts accompanied by positive accepted execution or a release proof.
 * Zero cost without execution-release authority is unresolved, not free capacity.
 * No queries, connection management, or lifecycle policy live here.
 */
import { polyCopyTradeFills } from "@cogni/poly-db-schema/copy-trade";
import { sql } from "drizzle-orm";

// One reservation amount for the planning read AND the advisory-locked insert.
// Legacy status/error labels and local cancellation acknowledgements are not
// evidence that a request never executed. Only authenticated proof releases it.
const intendedReservation = sql`CASE
  WHEN COALESCE(${polyCopyTradeFills.attributes}->>'size_usdc', 'missing_intent')::numeric >= 0
    AND COALESCE(${polyCopyTradeFills.attributes}->>'size_usdc', 'missing_intent')::numeric NOT IN ('NaN'::numeric, 'Infinity'::numeric)
    THEN COALESCE(${polyCopyTradeFills.attributes}->>'size_usdc', 'missing_intent')::numeric
  ELSE ('invalid_intent_' || ${polyCopyTradeFills.clientOrderId})::numeric END`;
const acceptedReservation = sql`CASE
  WHEN COALESCE(${polyCopyTradeFills.attributes}->>'filled_size_usdc', '0')::numeric >= 0
    AND COALESCE(${polyCopyTradeFills.attributes}->>'filled_size_usdc', '0')::numeric NOT IN ('NaN'::numeric, 'Infinity'::numeric)
    THEN COALESCE(${polyCopyTradeFills.attributes}->>'filled_size_usdc', '0')::numeric
  ELSE ('invalid_fill_' || ${polyCopyTradeFills.clientOrderId})::numeric END`;
const nonExecutionProven = sql`(
  ${polyCopyTradeFills.orderId} IS NULL AND ${acceptedReservation} = 0
  AND COALESCE(${polyCopyTradeFills.shares}, 0) <= 0
  AND ${polyCopyTradeFills.status} IN ('pending','error','canceled')
  AND ${polyCopyTradeFills.attributes}->'non_execution_proof'->>'source'
    IN ('executor_authorize_denied','pre_dispatch_retirement')
  AND NULLIF(${polyCopyTradeFills.attributes}->'non_execution_proof'->>'observed_at', '') IS NOT NULL
  AND NULLIF(${polyCopyTradeFills.attributes}->'non_execution_proof'->>'reason', '') IS NOT NULL
)`;
const finalObservedReservation = sql`CASE
  WHEN ${polyCopyTradeFills.attributes}->'final_order_observation'->>'filled_size_usdc' IS NULL THEN NULL
  WHEN (${polyCopyTradeFills.attributes}->'final_order_observation'->>'filled_size_usdc')::numeric >= 0
    AND (${polyCopyTradeFills.attributes}->'final_order_observation'->>'filled_size_usdc')::numeric NOT IN ('NaN'::numeric, 'Infinity'::numeric)
    THEN (${polyCopyTradeFills.attributes}->'final_order_observation'->>'filled_size_usdc')::numeric
  ELSE ('invalid_final_fill_' || ${polyCopyTradeFills.clientOrderId})::numeric END`;
const finalCancellationProven = sql`(
  ${polyCopyTradeFills.orderId} IS NOT NULL
  AND ${polyCopyTradeFills.attributes}->'final_order_observation'->>'source' = 'venue_get_order'
  AND ${polyCopyTradeFills.attributes}->'final_order_observation'->>'order_id' = ${polyCopyTradeFills.orderId}
  AND ${polyCopyTradeFills.attributes}->'final_order_observation'->>'status' = 'canceled'
  AND ${polyCopyTradeFills.attributes}->'final_order_observation'->>'fill_evidence'
    IN ('explicit_zero_size_matched','clob_associated_trades','paper_order_receipt')
  AND (
    (${polyCopyTradeFills.attributes}->'final_order_observation'->>'fill_evidence' = 'explicit_zero_size_matched'
      AND (${polyCopyTradeFills.attributes}->'final_order_observation'->>'filled_size_usdc')::numeric = 0)
    OR (${polyCopyTradeFills.attributes}->'final_order_observation'->>'fill_evidence' = 'clob_associated_trades'
      AND (${polyCopyTradeFills.attributes}->'final_order_observation'->>'filled_size_usdc')::numeric > 0)
    OR (${polyCopyTradeFills.attributes}->'final_order_observation'->>'fill_evidence' = 'paper_order_receipt'
      AND ${polyCopyTradeFills.mode} = 'paper')
  )
  AND NULLIF(${polyCopyTradeFills.attributes}->'final_order_observation'->>'observed_at', '') IS NOT NULL
  AND ${finalObservedReservation} >= 0
  AND (COALESCE(${polyCopyTradeFills.shares}, 0) <= 0 OR ${acceptedReservation} > 0)
)`;
export const reservedIntentUsdc = sql<string>`CASE
  WHEN ${intendedReservation} >= 0 THEN CASE
  WHEN ${nonExecutionProven} THEN 0
  WHEN ${polyCopyTradeFills.status} = 'canceled' AND ${finalCancellationProven}
    THEN GREATEST(${acceptedReservation}, ${finalObservedReservation})
  WHEN GREATEST(${intendedReservation}, ${acceptedReservation}) > 0
    THEN GREATEST(${intendedReservation}, ${acceptedReservation})
  ELSE ('unresolved_zero_commitment_' || ${polyCopyTradeFills.clientOrderId})::numeric
  END
END`;
