// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	createSecureClientMock,
	createBuilderApiKeyMock,
	transferErc20Mock,
	waitMock,
} = vi.hoisted(() => ({
	createSecureClientMock: vi.fn(),
	createBuilderApiKeyMock: vi.fn(),
	transferErc20Mock: vi.fn(),
	waitMock: vi.fn(),
}));

vi.mock("@polymarket/client", () => ({
	createSecureClient: createSecureClientMock,
}));
vi.mock("@polymarket/client/actions", () => ({
	createBuilderApiKey: createBuilderApiKeyMock,
}));
vi.mock("@polymarket/client/node", () => ({
	builderApiKey: vi.fn((credentials) => credentials),
}));
vi.mock("@polymarket/client/viem", () => ({
	signerFrom: vi.fn(() => ({ __signer: true })),
}));
vi.mock("viem", async (importOriginal) => {
	const actual = await importOriginal<typeof import("viem")>();
	return {
		...actual,
		createWalletClient: vi.fn(() => ({ __walletClient: true })),
	};
});

import { createOfficialDepositWalletTransferFactory } from "@/bootstrap/poly-trader-wallet";

const SIGNER = "0x1111111111111111111111111111111111111111" as const;
const FUNDER = "0x2222222222222222222222222222222222222222" as const;
const RECIPIENT = "0x3333333333333333333333333333333333333333" as const;
const TOKEN = "0x4444444444444444444444444444444444444444" as const;
const TX_HASH = `0x${"cd".repeat(32)}` as `0x${string}`;

describe("official Deposit Wallet transfer factory", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		waitMock.mockResolvedValue({ transactionHash: TX_HASH });
		transferErc20Mock.mockResolvedValue({ wait: waitMock });
		createBuilderApiKeyMock.mockResolvedValue({
			key: "builder-key",
			secret: "builder-secret",
			passphrase: "builder-passphrase",
		});
		createSecureClientMock
			.mockResolvedValueOnce({ account: { wallet: SIGNER } })
			.mockResolvedValueOnce({
				account: { wallet: FUNDER },
				transferErc20: transferErc20Mock,
			});
	});

	it("transfers from the derived funder and returns the settled hash", async () => {
		const transfer = createOfficialDepositWalletTransferFactory({
			polygonRpcUrl: "https://polygon.example.test",
		});

		const result = await transfer(
			{ address: SIGNER } as never,
			{ key: "k", secret: "s", passphrase: "p" },
			{
				expectedFunderAddress: FUNDER,
				tokenAddress: TOKEN,
				recipientAddress: RECIPIENT,
				amount: 123n,
			},
		);

		expect(transferErc20Mock).toHaveBeenCalledWith({
			amount: 123n,
			recipientAddress: RECIPIENT,
			tokenAddress: TOKEN,
		});
		expect(waitMock).toHaveBeenCalledOnce();
		expect(result).toBe(TX_HASH);
	});

	it("fails closed when the derived wallet differs from persisted state", async () => {
		const transfer = createOfficialDepositWalletTransferFactory({
			polygonRpcUrl: "https://polygon.example.test",
		});

		await expect(
			transfer(
				{ address: SIGNER } as never,
				{ key: "k", secret: "s", passphrase: "p" },
				{
					expectedFunderAddress: "0x5555555555555555555555555555555555555555",
					tokenAddress: TOKEN,
					recipientAddress: RECIPIENT,
					amount: 123n,
				},
			),
		).rejects.toThrow("does not match persisted funder");
		expect(transferErc20Mock).not.toHaveBeenCalled();
	});
});
