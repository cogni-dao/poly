// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { serverEnv } from "@/shared/env";
import { assertEvmRpcConfig, assertRuntimeSecrets } from "@/shared/env/invariants";
/** Local checks only; never construct the container. */
export function localReadinessPreflight(): ReturnType<typeof serverEnv> {
  const env = serverEnv();
  assertRuntimeSecrets(env);
  assertEvmRpcConfig(env);
  return env;
}
