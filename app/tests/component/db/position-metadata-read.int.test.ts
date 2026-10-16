import { randomUUID } from "node:crypto";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { sql } from "drizzle-orm";
import { describe, it, expect, afterAll } from "vitest";
import { persistPositionGapTargetSnapshot } from "@/features/wallet-analysis/server/copy-target-position-hydration-service";
import { refreshMarketMetadata } from "@/features/wallet-analysis/server/poly-market-metadata-service";
import { readPositionMetadata, positionMetadataSelect } from "@/features/wallet-analysis/server/position-metadata-read";
import { positionIdentityKey, type TargetBookSnapshotV1 } from "@cogni/poly-market-provider";
const unique = randomUUID().replaceAll("-", "");
const conditionId = `0x${unique}${unique}`;
const wallet = `0x${unique}aabbccdd`;
const tokenId = "6789012345678901234567890";
const oppositeTokenId = "6789012345678901234567891";
const db = getSeedDb();
const rows = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
const logger={info:()=>{},warn:()=>{},error:()=>{}};
function snapshot(offset: number, rich: boolean): TargetBookSnapshotV1 {
  const time = Date.parse("2026-10-16T00:00:00Z") + offset*1000;
  return {version:1,snapshotId:`metadata-${unique}-${offset}`,targetWallet:wallet,fullRefreshAtMs:time,updatedAtMs:time,expiresAtMs:time+60_000,complete:true,
    refreshStats:{kind:"full",discoveryRows:1,conditionCount:1,dataApiCalls:1,sourceComputedAt:new Date(time).toISOString(),sourceMaxSyncedBlock:90000000+offset},
    conditions:[{conditionId,status:"OPEN",redeemable:false,endDate:null,negativeRisk:false,marketTitle:rich?"Known market":null,marketSlug:rich?"known-market":null,
      tokens:[{tokenId,oppositeTokenId,outcomeIndex:0,shares:10,markPrice:.6,averagePrice:.4,outcome:rich?"Our outcome":null},
        {tokenId:oppositeTokenId,oppositeTokenId:tokenId,outcomeIndex:1,shares:0,markPrice:.4,averagePrice:0,outcome:rich?"Other outcome":null}]}]};
}
describe("saved metadata publication and indexed exact identity reads",()=>{
  afterAll(async()=>{
    await db.execute(sql`DELETE FROM poly_market_metadata WHERE lower(condition_id)=${conditionId}`);
    await db.execute(sql`DELETE FROM poly_trader_wallets WHERE wallet_address=${wallet}`);
  });
  it("retains exact labels through rich->sparse->rich at identical economic content hash",async()=>{
    await persistPositionGapTargetSnapshot({db,snapshot:snapshot(1,true)});
    await refreshMarketMetadata({db,logger});
    await persistPositionGapTargetSnapshot({db,snapshot:snapshot(2,false)});
    await refreshMarketMetadata({db,logger});
    const key = positionIdentityKey({conditionId,tokenId})!;
    const metadata=await readPositionMetadata({db,keys:[{conditionId,tokenId,walletAddress:wallet}]});
    expect(metadata.get(key)).toMatchObject({marketTitle:"Known market",outcome:"Our outcome"});
    await persistPositionGapTargetSnapshot({db,snapshot:snapshot(3,true)});
    const current=rows<{raw:Record<string,unknown>}>(await db.execute(sql`SELECT raw FROM poly_trader_current_positions WHERE condition_id=${conditionId} AND token_id=${tokenId}`));
    expect(current[0].raw.outcome).toBe("Our outcome");
    const wrong=await readPositionMetadata({db,keys:[{conditionId,tokenId:oppositeTokenId,walletAddress:wallet}]});
    expect(wrong.get(positionIdentityKey({conditionId,tokenId:oppositeTokenId})!)?.outcome).toBeNull();
  });
  it("explains the exact bounded production query with existing metadata indexes",async()=>{
    await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL enable_seqscan=off`);
      const query=positionMetadataSelect([{conditionId,tokenId,wallet}]);
      const result=rows<Record<string,unknown>>(await tx.execute(sql`EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) ${query}`));
      const plan=JSON.stringify(result);
      expect(plan).toContain("poly_market_metadata_condition_latest_lower_idx");
      expect(plan).toContain("poly_market_outcomes_condition_token_latest_lower_idx");
      expect(plan).toContain("poly_trader_position_snapshots_wallet_condition_latest_lc_idx");
    });
  });
});
