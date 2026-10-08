// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * The ingestion-cursor schema reserves `data-api` alongside the legacy
 * whole-wallet `data-api-positions` source. Copy-target V2 observation owns
 * this otherwise-unused source so scoped success can never relabel an
 * incomplete V1 publication as healthy.
 */
export const COPY_TARGET_POSITION_CURSOR_SOURCE = "data-api" as const;
