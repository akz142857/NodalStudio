import { describe, expect, it } from "vitest";
import type { QueryCell, QueryExecutionResult } from "../../platform";
import { profileColumn, resultCellText } from "./result-profile";
const text = (value: string): QueryCell => ({ kind:"text",value,truncated:false });
function fixture(cells: QueryCell[], databaseType="text"): QueryExecutionResult { return { queryId:"test", columns:[{name:"value",databaseType}], rows:cells.map((c)=>[c]), rowCount:cells.length, durationMs:1,truncated:true,notices:[] }; }
describe("returned-result profiling", () => {
  it("separates NULL, empty, distinct and once-only values across every page", () => {
    const result=fixture([...Array.from({length:250},()=>text("a")),text(""),text("b"),{kind:"null"}]);
    expect(profileColumn(result,0)).toMatchObject({total:253,nulls:1,empty:1,distinct:3,unique:2});
    expect(profileColumn(result,0).top[0]).toEqual({label:"a",count:250});
    expect(profileColumn(fixture([]),0)).toMatchObject({total:0,nulls:0,distinct:0,unique:0});
    expect(profileColumn(fixture([{kind:"null"}]),0)).toMatchObject({nulls:1,distinct:0});
  });
  it("does decimal arithmetic without rounding long integers through Number", () => {
    expect(profileColumn(fixture([text("9223372036854775806"),text("9223372036854775807")],"int8"),0).numeric).toMatchObject({min:"9223372036854775806",max:"9223372036854775807",mean:"9223372036854775806.5"});
    const p=profileColumn(fixture([text("0.123456789123456789"),text("0.123456789123456791")],"numeric"),0);
    expect(p.numeric?.mean).toBe("0.12345678912345679"); expect(p.numeric?.bins.reduce((n,b)=>n+b.count,0)).toBe(2);
    expect(profileColumn(fixture([text("1"),text("0"),text("0")],"numeric"),0).numeric?.mean).toBe("≈ 0.333333");
    expect(profileColumn(fixture([text("NaN")],"numeric"),0).numeric).toBeUndefined();
  });
  it("does not turn truncated prefixes or binary lengths into fake distinct statistics", () => {
    expect(profileColumn(fixture([{kind:"text",value:"a",truncated:true},text("a")]),0)).toMatchObject({distinct:null,unique:null,incomplete:1,top:[]});
    expect(profileColumn(fixture([{kind:"binary",byteLength:42}],"bytea"),0)).toMatchObject({distinct:null,incomplete:1});
    const json: QueryCell={kind:"json",value:{id:123},raw:'{"id":9223372036854775807}',truncated:false};
    expect(resultCellText(json)).toContain("9223372036854775807");
    expect(profileColumn(fixture([json],"jsonb"),0)).toMatchObject({distinct:null,top:[]});
  });
  it("orders timezone-aware dates by their instant and never calculates UUID means", () => {
    const p=profileColumn(fixture([text("2026-01-02T00:00:00+08:00"),text("2026-01-01T18:00:00Z")],"timestamptz"),0);
    expect(p.dates).toEqual({min:"2026-01-02T00:00:00+08:00",max:"2026-01-01T18:00:00Z"});
    expect(profileColumn(fixture([text("123")],"uuid"),0).numeric).toBeUndefined();
  });
});
