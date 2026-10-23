import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeDraft, KnowledgeDraftInput, NodalStudioPlatform } from "../platform";
import { KnowledgeEditor } from "./KnowledgeReview";
const input: KnowledgeDraftInput = { snapshotId:"snapshot",target:{kind:"table",schema:"public",name:"orders"},requestId:"answer",interpretationIndex:0 };
function fixture() {
  const draft: KnowledgeDraft = { id:"draft",sourceId:"source",snapshotId:"snapshot",target:input.target,oldDescription:"Original team description",draftText:"May describe purchase intent",expiresAt:new Date(Date.now()+300_000).toISOString(),basis:{tables:[],relationships:[],notes:[]},origin:{kind:"modelInterpretation",requestId:"answer",provider:"model",model:"test",generatedAt:null,evidence:{unknowns:["Grain remains uncertain"]}} };
  const mocks={prepareKnowledgeDraft:vi.fn().mockResolvedValue(draft),confirmKnowledgeDraft:vi.fn().mockResolvedValue({}),cancelKnowledgeDraft:vi.fn().mockResolvedValue(undefined)};
  return {draft,mocks,platform:mocks as unknown as NodalStudioPlatform,onSaved:vi.fn().mockResolvedValue(undefined),sourceId:"source",input};
}
afterEach(()=>vi.useRealTimers());
async function prepare() { fireEvent.click(screen.getByRole("button",{name:"Review and confirm description"}));await screen.findByLabelText("Proposed description"); }
describe("local knowledge confirmation",()=>{
  it("compares old/new text, preserves uncertainty and requires explicit edited confirmation",async()=>{
    const p=fixture();render(<KnowledgeEditor {...p}/>);await prepare();expect(screen.getByText("Original team description")).toBeVisible();expect(screen.getByLabelText("Proposed description")).toHaveValue("May describe purchase intent");expect(p.mocks.confirmKnowledgeDraft).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Proposed description"),{target:{value:"May describe one purchase intent; retries remain unknown"}});fireEvent.click(screen.getByRole("button",{name:"Confirm this description"}));await screen.findByText("Description confirmed on this device.");expect(p.mocks.confirmKnowledgeDraft).toHaveBeenCalledExactlyOnceWith("draft","May describe one purchase intent; retries remain unknown");expect(p.onSaved).toHaveBeenCalledOnce();
  });
  it("retains edits after a failed save and retries the same draft identity",async()=>{
    const p=fixture();p.mocks.confirmKnowledgeDraft.mockRejectedValueOnce(new Error("Concurrent annotation edit"));render(<KnowledgeEditor {...p}/>);await prepare();fireEvent.change(screen.getByLabelText("Proposed description"),{target:{value:"My edited description"}});fireEvent.click(screen.getByRole("button",{name:"Confirm this description"}));await screen.findByRole("alert");expect(screen.getByLabelText("Proposed description")).toHaveValue("My edited description");fireEvent.click(screen.getByRole("button",{name:"Confirm this description"}));await screen.findByText("Description confirmed on this device.");expect(p.mocks.confirmKnowledgeDraft).toHaveBeenNthCalledWith(2,"draft","My edited description");
  });
  it("keeps a committed draft saved when refreshing fails and retries only the refresh",async()=>{
    const p=fixture();p.onSaved.mockRejectedValueOnce(new Error("Refresh unavailable"));render(<KnowledgeEditor {...p}/>);await prepare();
    fireEvent.click(screen.getByRole("button",{name:"Confirm this description"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("The description was saved, but the view could not refresh.");
    expect(screen.getByText("Description confirmed on this device.")).toBeVisible();
    expect(screen.queryByRole("button",{name:"Confirm this description"})).toBeNull();
    expect(screen.getByLabelText("Proposed description")).toBeDisabled();
    fireEvent.click(screen.getByRole("button",{name:"Retry refresh"}));
    await act(async()=>{await Promise.resolve();});
    expect(screen.queryByRole("alert")).toBeNull();expect(p.onSaved).toHaveBeenCalledTimes(2);expect(p.mocks.confirmKnowledgeDraft).toHaveBeenCalledOnce();
  });
  it("cancels an old preparation and never attaches its late draft to another target",async()=>{
    const p=fixture();let resolve!:(draft:KnowledgeDraft)=>void;p.mocks.prepareKnowledgeDraft.mockReturnValueOnce(new Promise((r)=>{resolve=r;}));const view=render(<KnowledgeEditor {...p}/>);fireEvent.click(screen.getByRole("button",{name:"Review and confirm description"}));view.rerender(<KnowledgeEditor {...p} input={{...input,target:{...input.target,name:"customers"}}}/>);await act(async()=>{resolve(p.draft);await Promise.resolve();});expect(screen.queryByLabelText("Proposed description")).toBeNull();expect(p.mocks.cancelKnowledgeDraft).toHaveBeenCalledWith("draft");expect(p.mocks.confirmKnowledgeDraft).not.toHaveBeenCalled();
  });
  it("expires after a suspended tab resumes and cannot save stale text",async()=>{
    const p=fixture();render(<KnowledgeEditor {...p}/>);await prepare();vi.useFakeTimers();vi.setSystemTime(Date.parse(p.draft.expiresAt)+1);fireEvent(window,new Event("focus"));expect(screen.getByText(/Draft expired/)).toBeVisible();expect(screen.queryByRole("button",{name:"Confirm this description"})).toBeNull();expect(p.mocks.cancelKnowledgeDraft).toHaveBeenCalledWith("draft");
  });
  it("rejects a mismatched target before enabling confirmation",async()=>{ const p=fixture();p.mocks.prepareKnowledgeDraft.mockResolvedValue({...p.draft,sourceId:"other-source"});render(<KnowledgeEditor {...p}/>);fireEvent.click(screen.getByRole("button",{name:"Review and confirm description"}));await screen.findByRole("alert");expect(screen.queryByRole("button",{name:"Confirm this description"})).toBeNull(); });
  it("refreshes a submitted confirmation even when its response arrives after the deadline",async()=>{
    const p=fixture();let resolve!:(value:unknown)=>void;p.mocks.confirmKnowledgeDraft.mockReturnValueOnce(new Promise((r)=>{resolve=r;}));render(<KnowledgeEditor {...p}/>);await prepare();fireEvent.click(screen.getByRole("button",{name:"Confirm this description"}));
    vi.useFakeTimers();vi.setSystemTime(Date.parse(p.draft.expiresAt)+1);fireEvent(window,new Event("focus"));expect(screen.getByRole("button",{name:"Saving…"})).toBeDisabled();expect(p.mocks.cancelKnowledgeDraft).not.toHaveBeenCalled();
    await act(async()=>{resolve({});await Promise.resolve();});expect(screen.getByText("Description confirmed on this device.")).toBeVisible();expect(p.onSaved).toHaveBeenCalledOnce();
  });
});
