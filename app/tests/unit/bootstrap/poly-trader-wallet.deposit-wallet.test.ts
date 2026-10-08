// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, erc20Abi, parseAbi } from "viem";

const {
	createSecureClientMock,
	createBuilderApiKeyMock,
	prepareGaslessTransactionMock,
	transferErc20Mock,
	setupTradingApprovalsMock,
	approveErc20Mock,
	readContractMock,
	getAddressMock,
	signTypedDataMock,
	signMessageMock,
	waitMock,
} = vi.hoisted(() => ({
	createSecureClientMock: vi.fn(),
	createBuilderApiKeyMock: vi.fn(),
	prepareGaslessTransactionMock: vi.fn(),
	transferErc20Mock: vi.fn(),
	setupTradingApprovalsMock: vi.fn(),
	approveErc20Mock: vi.fn(),
	readContractMock: vi.fn(),
	getAddressMock: vi.fn(),
	signTypedDataMock: vi.fn(),
	signMessageMock: vi.fn(),
	waitMock: vi.fn(),
}));

vi.mock("@polymarket/client", () => ({
	createSecureClient: createSecureClientMock,
}));
vi.mock("@polymarket/client/actions", () => ({
	createBuilderApiKey: createBuilderApiKeyMock,
	prepareGaslessTransaction: prepareGaslessTransactionMock,
}));
vi.mock("@polymarket/client/node", () => ({
	builderApiKey: vi.fn((credentials) => credentials),
}));
vi.mock("@polymarket/client/viem", () => ({
	signerFrom: vi.fn(() => ({
		getAddress: getAddressMock,
		signTypedData: signTypedDataMock,
		signMessage: signMessageMock,
	})),
}));
vi.mock("viem", async (importOriginal) => {
	const actual = await importOriginal<typeof import("viem")>();
	return {
		...actual,
		createPublicClient: vi.fn(() => ({
			readContract: readContractMock,
		})),
		createWalletClient: vi.fn(() => ({ __walletClient: true })),
	};
});

import {
	createOfficialDepositWalletFactory,
	createOfficialDepositWalletNativeTransferFactory,
	createOfficialDepositWalletTransferFactory,
	createOfficialDepositWalletUnwrapFactory,
	createOfficialDepositWalletWrapFactory,
} from "@/bootstrap/poly-trader-wallet";

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
		setupTradingApprovalsMock.mockResolvedValue(undefined);
		approveErc20Mock.mockResolvedValue({ wait: waitMock });
		readContractMock.mockResolvedValue(
			115792089237316195423570985008687907853269984665640564039457584007913129639935n,
		);
		getAddressMock.mockResolvedValue(SIGNER);
		signTypedDataMock.mockResolvedValue(`0x${"ab".repeat(65)}`);
		signMessageMock.mockResolvedValue(`0x${"ef".repeat(65)}`);
		createBuilderApiKeyMock.mockResolvedValue({
			key: "builder-key",
			secret: "builder-secret",
			passphrase: "builder-passphrase",
		});
		createSecureClientMock
			.mockResolvedValueOnce({ account: { wallet: SIGNER } })
			.mockResolvedValueOnce({
				account: { wallet: FUNDER },
				signer: {
					getAddress: getAddressMock,
					signTypedData: signTypedDataMock,
					signMessage: signMessageMock,
				},
				setupTradingApprovals: setupTradingApprovalsMock,
				approveErc20: approveErc20Mock,
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

	it("submits USDC.e wrapping through the Deposit Wallet gasless workflow", async () => {
		async function* gaslessWorkflow() {
			yield {
				kind: "signGaslessTypedData" as const,
				payload: { domain: {}, types: {}, primaryType: "Call", message: {} },
			};
			return { wait: waitMock };
		}
		prepareGaslessTransactionMock.mockResolvedValue(gaslessWorkflow());
		const wrap = createOfficialDepositWalletWrapFactory({
			polygonRpcUrl: "https://polygon.example.test",
		});

		const result = await wrap(
			{ address: SIGNER } as never,
			{ key: "k", secret: "s", passphrase: "p" },
			{ expectedFunderAddress: FUNDER, amount: 100_000_000n },
		);

		expect(prepareGaslessTransactionMock).toHaveBeenCalledWith(
			expect.objectContaining({ account: { wallet: FUNDER } }),
				expect.objectContaining({
				calls: [
					expect.objectContaining({
						to: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
					}),
					expect.objectContaining({
						to: "0x93070a847efEf7F70739046A929D47a521F5B8ee",
					}),
				],
			}),
		);
		expect(signTypedDataMock).toHaveBeenCalledOnce();
		expect(waitMock).toHaveBeenCalledOnce();
		expect(result).toBe(TX_HASH);
	});

	it("unwraps Deposit Wallet pUSD directly to recipient USDC.e", async () => {
		async function* gaslessWorkflow() {
			yield {
				kind: "signGaslessTypedData" as const,
				payload: { domain: {}, types: {}, primaryType: "Call", message: {} },
			};
			return { wait: waitMock };
		}
		prepareGaslessTransactionMock.mockResolvedValue(gaslessWorkflow());
		const unwrap = createOfficialDepositWalletUnwrapFactory({
			polygonRpcUrl: "https://polygon.example.test",
		});

		const result = await unwrap(
			{ address: SIGNER } as never,
			{ key: "k", secret: "s", passphrase: "p" },
			{
				expectedFunderAddress: FUNDER,
				recipientAddress: RECIPIENT,
				amount: 100_000_000n,
			},
		);

		expect(prepareGaslessTransactionMock).toHaveBeenCalledWith(
			expect.objectContaining({ account: { wallet: FUNDER } }),
			{
				calls: [
					{
						to: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
						data: encodeFunctionData({
							abi: erc20Abi,
							functionName: "approve",
							args: [
								"0x2957922Eb93258b93368531d39fAcCA3B4dC5854",
								100_000_000n,
							],
						}),
					},
					{
						to: "0x2957922Eb93258b93368531d39fAcCA3B4dC5854",
						data: encodeFunctionData({
							abi: parseAbi([
								"function unwrap(address asset, address to, uint256 amount)",
							]),
							functionName: "unwrap",
							args: [
								"0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
								RECIPIENT,
								100_000_000n,
							],
						}),
					},
				],
				metadata: "Recover Deposit Wallet pUSD as USDC.e",
			},
		);
		expect(signTypedDataMock).toHaveBeenCalledOnce();
		expect(waitMock).toHaveBeenCalledOnce();
		expect(result).toBe(TX_HASH);
	});

	it("sweeps native POL through a value-bearing Deposit Wallet call", async () => {
		async function* gaslessWorkflow() {
			yield {
				kind: "signGaslessMessage" as const,
				payload: `0x${"12".repeat(32)}`,
			};
			return { wait: waitMock };
		}
		prepareGaslessTransactionMock.mockResolvedValue(gaslessWorkflow());
		const transfer = createOfficialDepositWalletNativeTransferFactory({
			polygonRpcUrl: "https://polygon.example.test",
		});

		const result = await transfer(
			{ address: SIGNER } as never,
			{ key: "k", secret: "s", passphrase: "p" },
			{
				expectedFunderAddress: FUNDER,
				recipientAddress: RECIPIENT,
				amount: 5_000_000_000_000_000_000n,
			},
		);

		expect(prepareGaslessTransactionMock).toHaveBeenCalledWith(
			expect.objectContaining({ account: { wallet: FUNDER } }),
			{
				calls: [
					{
						to: RECIPIENT,
						data: "0x",
						value: 5_000_000_000_000_000_000n,
					},
				],
				metadata: "Recover native POL from Deposit Wallet",
			},
		);
		expect(signMessageMock).toHaveBeenCalledOnce();
		expect(waitMock).toHaveBeenCalledOnce();
		expect(result).toBe(TX_HASH);
	});
});

describe("official Deposit Wallet onboarding factory", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		const maxAllowance =
			115792089237316195423570985008687907853269984665640564039457584007913129639935n;
		waitMock.mockResolvedValue({ transactionHash: TX_HASH });
		setupTradingApprovalsMock.mockResolvedValue(undefined);
		approveErc20Mock.mockResolvedValue({ wait: waitMock });
		readContractMock.mockResolvedValue(maxAllowance);
		createBuilderApiKeyMock.mockResolvedValue({
			key: "builder-key",
			secret: "builder-secret",
			passphrase: "builder-passphrase",
		});
		createSecureClientMock
			.mockResolvedValueOnce({ account: { wallet: SIGNER } })
			.mockResolvedValueOnce({
				account: { wallet: FUNDER },
				setupTradingApprovals: setupTradingApprovalsMock,
				approveErc20: approveErc20Mock,
			});
	});

	it("derives the funder during create without consuming the approval ceremony", async () => {
		const prepare = createOfficialDepositWalletFactory({
			logger: { info: vi.fn() } as never,
			polygonRpcUrl: "https://polygon.example.test",
		});

		const result = await prepare(
			{ address: SIGNER } as never,
			{ key: "k", secret: "s", passphrase: "p" },
			{ transferExistingPusd: false, setupTradingApprovals: false },
		);

		expect(result).toEqual({ funderAddress: FUNDER, allowanceState: null });
		expect(setupTradingApprovalsMock).not.toHaveBeenCalled();
	});

	it("runs approvals only from the explicit enable-trading ceremony", async () => {
		const prepare = createOfficialDepositWalletFactory({
			logger: { info: vi.fn() } as never,
			polygonRpcUrl: "https://polygon.example.test",
		});

		await prepare(
			{ address: SIGNER } as never,
			{ key: "k", secret: "s", passphrase: "p" },
			{ transferExistingPusd: false, setupTradingApprovals: true },
		);

		expect(setupTradingApprovalsMock).toHaveBeenCalledOnce();
		expect(approveErc20Mock).not.toHaveBeenCalled();
		expect(readContractMock).toHaveBeenCalledTimes(4);
	});

	it("repairs and post-verifies the production legacy NegRiskAdapter allowance", async () => {
		const maxAllowance =
			115792089237316195423570985008687907853269984665640564039457584007913129639935n;
		readContractMock
			.mockResolvedValueOnce(0n)
			.mockResolvedValueOnce(maxAllowance)
			.mockResolvedValueOnce(maxAllowance)
			.mockResolvedValueOnce(maxAllowance);
		const prepare = createOfficialDepositWalletFactory({
			logger: { info: vi.fn() } as never,
			polygonRpcUrl: "https://polygon.example.test",
		});

		const result = await prepare(
			{ address: SIGNER } as never,
			{ key: "k", secret: "s", passphrase: "p" },
			{ transferExistingPusd: false, setupTradingApprovals: true },
		);

		expect(approveErc20Mock).toHaveBeenCalledWith({
			amount: "max",
			spenderAddress: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
			tokenAddress: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
		});
		expect(waitMock).toHaveBeenCalledOnce();
		expect(result.allowanceState?.spenders.map((entry) => entry.address)).toEqual([
			"0xE111180000d2663C0091e4f400237545B87B996B",
			"0xe2222d279d744050d28e00520010520000310F59",
			"0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
		]);
	});

	it("refuses readiness when any required pUSD spender fails post-verification", async () => {
		const maxAllowance =
			115792089237316195423570985008687907853269984665640564039457584007913129639935n;
		readContractMock
			.mockResolvedValueOnce(maxAllowance)
			.mockResolvedValueOnce(maxAllowance)
			.mockResolvedValueOnce(0n)
			.mockResolvedValueOnce(maxAllowance);
		const prepare = createOfficialDepositWalletFactory({
			logger: { info: vi.fn() } as never,
			polygonRpcUrl: "https://polygon.example.test",
		});

		await expect(
			prepare(
				{ address: SIGNER } as never,
				{ key: "k", secret: "s", passphrase: "p" },
				{ transferExistingPusd: false, setupTradingApprovals: true },
			),
		).rejects.toThrow(
			"Deposit Wallet trading approvals did not post-verify for every pUSD spender",
		);
	});
});
