// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Internal, operator-authenticated wallet recovery contract.
 *
 * The operation is deliberately narrower than arbitrary signing: one persisted
 * tenant wallet, one pinned asset, one checksummed source assertion, and one
 * repeated irreversible confirmation. It never revokes or deletes a wallet.
 */

import { z } from "zod";

const walletAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const amountSchema = z.union([
  z.string().regex(/^[1-9][0-9]{0,38}$/),
  z.literal("max"),
]);
const assetSchema = z.enum(["usdc_e", "pusd", "pol"]);

export const polyWalletRecoverOperation = {
  id: "poly.wallet.recover.v1",
  input: z
    .object({
      billing_account_id: z.string().uuid(),
      expected_source_address: walletAddressSchema,
      asset: assetSchema,
      destination: walletAddressSchema,
      amount_atomic: amountSchema,
      allow_clob_credential_repair: z.boolean().default(false),
      confirmation: z.object({
        expected_source_address: walletAddressSchema,
        asset: assetSchema,
        destination: walletAddressSchema,
        amount_atomic: amountSchema,
        irreversible: z.literal(true),
      }),
    })
    .superRefine((value, ctx) => {
      if (value.amount_atomic === "max" && value.asset !== "pol") {
        ctx.addIssue({
          code: "custom",
          path: ["amount_atomic"],
          message: '"max" is supported only for native POL recovery',
        });
      }
    }),
  output: z.object({
    asset: assetSchema,
    delivered_asset: z.enum(["usdc_e", "pol"]),
    source_address: walletAddressSchema,
    destination: walletAddressSchema,
    amount_atomic: z.string().regex(/^[1-9][0-9]{0,38}$/),
    primary_tx_hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
    tx_hashes: z.array(z.string().regex(/^0x[a-fA-F0-9]{64}$/)).min(1),
    disabled_target_count: z.number().int().nonnegative(),
    clob_credentials_repaired: z.boolean(),
  }),
} as const;

export type PolyWalletRecoverInput = z.infer<
  typeof polyWalletRecoverOperation.input
>;
export type PolyWalletRecoverOutput = z.infer<
  typeof polyWalletRecoverOperation.output
>;
