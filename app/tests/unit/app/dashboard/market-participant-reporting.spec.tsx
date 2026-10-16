// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import type { WalletExecutionMarketParticipantRow, WalletExecutionMarketLeg } from "@cogni/poly-node-contracts";
import { ParticipantRow } from "@/app/(app)/_components/markets-table/columns";
const leg=(tokenId:string,outcome:string,value:number):WalletExecutionMarketLeg=>({tokenId,outcome,shares:10,currentValueUsdc:value,costBasisUsdc:5,vwap:.5,pnlUsdc:null,unrealizedPnlUsdc:value-5,lifecycle:"active"});
describe("participant outcomes are independent of wallet-relative ranking",()=>{
  it("renders exact target hedge, opposite primary, additional exposure and same-token relationship",()=>{
    const primary=leg("222","Ane Mintegi Del Olmo",12);
    const hedge=leg("111","Rebeka Masarova",7);
    const extra=leg("333","Third outcome",3);
    const participant:WalletExecutionMarketParticipantRow={side:"copy_target",source:"trader_current_positions",label:"RN1",walletAddress:`0x${"2".repeat(40)}`,conditionId:`0x${"a".repeat(64)}`,primary,hedge,legs:[primary,hedge,extra],net:{currentValueUsdc:22,costBasisUsdc:15,pnlUsdc:null},lastObservedAt:null};
    render(<table><tbody><ParticipantRow participant={participant} comparisons={[{ourTokenId:"111",targetWallet:participant.walletAddress,targetTokenId:"111",relation:"same",reason:"exact_condition_token",metadataAvailability:"available",economicsAvailability:"unavailable",observedAt:null}]} /></tbody></table>);
    expect(screen.getAllByText(/Rebeka Masarova/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Ane Mintegi Del Olmo/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Third outcome/)).toBeTruthy();
    expect(screen.getByText(/Same token/)).toBeTruthy();
    expect(screen.getAllByText("Unrealized")).toHaveLength(2);
  });
});
