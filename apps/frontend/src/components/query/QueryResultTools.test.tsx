import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodalStudioPlatform, QueryExecutionResult } from "../../platform/types";
import { QueryResultGrid } from "./QueryResultGrid";
import { profileResult } from "./result-profile";
const result: QueryExecutionResult={queryId:"test",columns:[{name:"amount",databaseType:"numeric"}],rows:Array.from({length:205},(_,i)=>[{kind:"text",value:String(i),truncated:false}]),rowCount:205,truncated:true,durationMs:1,notices:[]};
describe("query result tools",()=>{
  beforeEach(()=>{
    HTMLDialogElement.prototype.showModal=function(){this.setAttribute("open","");};
    HTMLDialogElement.prototype.close=function(){this.removeAttribute("open");};
    vi.stubGlobal("Worker",class {
      onmessage?: (event:{data:{profiles:ReturnType<typeof profileResult>}})=>void;
      postMessage(r:QueryExecutionResult){queueMicrotask(()=>this.onmessage?.({data:{profiles:profileResult(r)}}));}
      terminate(){}
    });
  });
  afterEach(()=>vi.unstubAllGlobals());
  it("profiles all pages, supports column details and resets for a new result",async()=>{
    const {rerender}=render(<QueryResultGrid result={result}/>);
    fireEvent.click(screen.getByRole("button",{name:"Profile"}));
    const trigger = await screen.findByRole("button",{name:"Profile amount"}); trigger.focus(); fireEvent.click(trigger);
    const details=screen.getByRole("complementary",{name:"Profile of amount"});
    expect(details).toHaveTextContent("205 returned rows");expect(details).toHaveTextContent("102");expect(details).toHaveTextContent("not the full dataset");
    fireEvent.click(screen.getByRole("button",{name:"Close column profile"}));
    expect(screen.getByRole("button",{name:"Profile amount"})).toHaveFocus();
    rerender(<QueryResultGrid result={{...result,queryId:"new",rows:[],rowCount:0}}/>);
    expect(screen.queryByRole("button",{name:"Profile amount"})).toBeNull();
    expect(screen.getByRole("button",{name:"Profile"})).toHaveAttribute("aria-pressed","false");
  });
  it("exports an immutable result and cross-page selection without running SQL",async()=>{
    const exportQueryResult=vi.fn<NodalStudioPlatform["exportQueryResult"]>().mockResolvedValue(null);
    const platform={exportQueryResult} as unknown as NodalStudioPlatform;
    render(<QueryResultGrid result={result} platform={platform}/>);
    fireEvent.click(screen.getByRole("checkbox",{name:"Select row 1"}));
    fireEvent.click(screen.getByRole("button",{name:"Next"}));
    fireEvent.click(screen.getByRole("checkbox",{name:"Select row 205"}));
    fireEvent.click(screen.getByRole("button",{name:"Export…"}));
    const dialog=screen.getByRole("dialog");expect(dialog).toHaveTextContent("does not run SQL again");
    fireEvent.change(within(dialog).getByLabelText("Rows"),{target:{value:"selected"}});
    fireEvent.click(within(dialog).getByRole("radio",{name:/Excel/}));
    fireEvent.click(within(dialog).getByRole("button",{name:"Export…"}));
    await waitFor(()=>expect(exportQueryResult).toHaveBeenCalledOnce());
    const input=exportQueryResult.mock.calls[0][0];
    expect(input.selectedRows).toEqual([0,204]); expect(input.result).toBe(result);expect(input.format).toBe("xlsx");
    expect(await screen.findByText("Save cancelled. No file was written.")).toBeVisible();
  });
  it("uses an all-pages header checkbox and only reveals selection commands when needed",()=>{
    render(<QueryResultGrid result={result}/>);
    expect(screen.queryByRole("button",{name:"Clear selection"})).toBeNull();
    const all = screen.getByRole("checkbox",{name:"Select all returned rows"});
    fireEvent.click(screen.getByRole("checkbox",{name:"Select row 1"}));
    expect(all).toBePartiallyChecked();
    fireEvent.click(all);
    expect(all).toBeChecked(); expect(screen.getByText("205 selected")).toBeVisible();
    fireEvent.click(screen.getByRole("button",{name:"Next"}));
    expect(screen.getByRole("checkbox",{name:"Select row 205"})).toBeChecked();
    fireEvent.click(screen.getByRole("button",{name:"Clear selection"}));
    expect(all).not.toBeChecked(); expect(all).not.toBePartiallyChecked();
    expect(screen.queryByRole("button",{name:"Copy selected rows"})).toBeNull();
  });
  it("requires acknowledging incomplete cells and shows save failures",async()=>{
    const platform={exportQueryResult:vi.fn().mockRejectedValue(new Error("Disk full"))} as unknown as NodalStudioPlatform;
    render(<QueryResultGrid result={{...result,rows:[[{kind:"text",value:"cut",truncated:true}]],rowCount:1}} platform={platform}/>);
    fireEvent.click(screen.getByRole("button",{name:"Export…"}));
    expect(within(screen.getByRole("dialog")).getByRole("button",{name:"Export…"})).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox",{name:"Export these incomplete values"}));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button",{name:"Export…"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("Disk full");
  });
});
