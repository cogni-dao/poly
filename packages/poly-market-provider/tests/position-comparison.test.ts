import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { comparePositionIdentity, selectPositionMetadata } from "../src/domain/position-comparison.js";
const bytes = readFileSync(new URL("./fixtures/position-comparison-oracle.v1.json", import.meta.url));
const oracle = JSON.parse(bytes.toString());
describe("independent frozen position identity oracle", () => {
  it("preserves the preimplementation144-case oracle and all denominators", () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("7a1da7717b51a1505a17e4e37b0a878b72d28ef6efe7166de1e802d75aa53859");
    expect(oracle.cases).toHaveLength(144);
    const known = oracle.cases.filter((c: {expected:{exactMatch:boolean|null}}) => c.expected.exactMatch !== null);
    let tp=0,fp=0,fn=0,tn=0;
    for (const c of oracle.cases) {
      const result = comparePositionIdentity(c.left,c.right);
      expect(result, c.id).toMatchObject(c.expected);
      if (c.expected.exactMatch === true) result.exactMatch === true ? tp++ : fn++;
      if (c.expected.exactMatch === false) result.exactMatch === true ? fp++ : tn++;
    }
    expect([tp,fp,fn,tn,known.length]).toEqual([60,0,0,60,120]);
    expect(tp/(tp+fp)).toBeGreaterThanOrEqual(.99);
    expect((tp+tn)/known.length).toBeGreaterThanOrEqual(.99);
  });
  it("never borrows the other token's label and ignores sparse newer metadata", () => {
    const identity={conditionId:`0x${"a".repeat(64)}`,tokenId:"123456789012345678901234567890"};
    const result=selectPositionMetadata(identity,[
      {...identity,tokenId:"999",source:"canonical",observedAt:"2026-10-16T02:00:00Z",marketTitle:"Known market",outcome:"Opposite"},
      {...identity,source:"current",observedAt:"2026-10-16T03:00:00Z",marketTitle:null,outcome:null},
      {...identity,source:"snapshot",observedAt:"2026-10-16T01:00:00Z",outcome:"Our exact outcome"},
    ]);
    expect(result).toMatchObject({marketTitle:"Known market",outcome:"Our exact outcome",availability:"complete"});
  });
  it("retains unavailable and conflicting metadata instead of assigning an opposite label", () => {
    const identity={conditionId:`0x${"b".repeat(64)}`,tokenId:"12"};
    expect(selectPositionMetadata(identity,[{...identity,tokenId:"13",source:"x",observedAt:null,outcome:"Other"}]).outcome).toBeNull();
    expect(selectPositionMetadata(identity,[{...identity,source:"x",observedAt:null,outcome:"A"},{...identity,source:"x",observedAt:null,outcome:"B"}]).availability).toBe("conflict");
  });
});

describe("independent source-backed reporting oracle", () => {
  const reportingBytes=readFileSync(new URL("./fixtures/position-reporting-oracle.v1.json",import.meta.url));
  const reporting=JSON.parse(reportingBytes.toString());
  it("resolves all123 captured labels and rejects all123 wrong-token labels separately from identity",()=>{
    expect(createHash("sha256").update(reportingBytes).digest("hex")).toBe("0958b943b9560001566805e11457c33b88fbad2061781869ee9d5f5baa65906d");
    let correct=0,wrongToken=0,known=0,negative=0;
    for(const c of reporting.cases){
      const result=selectPositionMetadata(c.identity,c.candidates);
      for(const field of ["outcome","marketTitle","marketSlug","eventSlug"] as const){
        if(field in c.expected)expect(result[field],`${c.id}:${field}`).toBe(c.expected[field]);
      }
      if(c.expected.outcomeAvailability==="available"){
        known++;if(result.outcome===c.expected.outcome&&result.marketTitle===c.expected.marketTitle)correct++;
      }else{negative++;if(result.outcome!==null)wrongToken++;}
    }
    expect([known,negative,wrongToken]).toEqual([123,123,0]);
    expect(correct/known).toBeGreaterThanOrEqual(.99);
  });
});
