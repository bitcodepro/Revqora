import {describe,it,expect} from "vitest";
import {cachedGraphRows,rememberGraphRows,rememberGraphPosition,forgetGraphRows} from "./graphRowsCache";
import type {GraphRow} from "./types";
describe("repository history first-paint snapshots",()=>{
  it("restores rows and scroll only for the matching repository generation",()=>{const rows=new Map([[3,{index:3,oid:"a"} as GraphRow]]);rememberGraphRows("one",4,rows);rememberGraphPosition("one",4,123);expect(cachedGraphRows("one",4)?.top).toBe(123);expect(cachedGraphRows("one",4)?.rows.get(3)?.oid).toBe("a");expect(cachedGraphRows("two",4)).toBeNull();expect(cachedGraphRows("one",5)).toBeNull();rows.clear();expect(cachedGraphRows("one",4)?.rows.size).toBe(1);forgetGraphRows("one");expect(cachedGraphRows("one",4)).toBeNull();});
  it("bounds retained repositories, rows and oversized payloads",()=>{for(let i=0;i<70;i++)rememberGraphRows(`repo-${i}`,1,new Map([[0,{index:0,oid:String(i)} as GraphRow]]));expect(cachedGraphRows("repo-0",1)).toBeNull();expect(cachedGraphRows("repo-69",1)?.rows.size).toBe(1);rememberGraphRows("huge",1,new Map([[0,{subject:"x".repeat(256*1024)} as GraphRow]]));expect(cachedGraphRows("huge",1)?.rows.size).toBe(0);});
});
