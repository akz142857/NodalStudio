import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_QUERY_RESULT_HEIGHT, MIN_QUERY_RESULT_HEIGHT, resizedQueryResultHeight } from "./query-state";

describe("query result splitter", () => {
  it("grows upward and shrinks downward", () => {
    expect(resizedQueryResultHeight(300, 500, 400)).toBe(400);
    expect(resizedQueryResultHeight(300, 500, 600)).toBe(200);
  });

  it("keeps the output inside safe height limits", () => {
    expect(resizedQueryResultHeight(300, 500, -1000)).toBe(MAX_QUERY_RESULT_HEIGHT);
    expect(resizedQueryResultHeight(300, 500, 2000)).toBe(MIN_QUERY_RESULT_HEIGHT);
  });
});

describe("SQL draft restart preservation", () => {
  beforeEach(() => { localStorage.clear(); vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  it("restores the editor after a restart without persisting query results", async () => {
    const state = await import("./query-state");
    const session = { ...state.loadQuerySession("workspace"), draft: "SELECT 42", message: "sensitive result contents", activeTab: "history" as const };
    state.saveQuerySession("workspace", session);
    expect(localStorage.getItem("nodalstudio.query-draft.v1:workspace")).toBe(JSON.stringify({ draft: "SELECT 42" }));
    vi.resetModules();
    const reopened = await import("./query-state");
    expect(reopened.loadQuerySession("workspace")).toMatchObject({ draft: "SELECT 42", activeTab: "results" });
    expect(reopened.loadQuerySession("other").draft).toBe("");
    reopened.saveQuerySession("workspace", { ...session, draft: "" });
    vi.resetModules();
    expect((await import("./query-state")).loadQuerySession("workspace").draft).toBe("");
  });

  it("blocks an update on storage failure, retains the in-memory draft, and recovers on retry", async () => {
    const state = await import("./query-state");
    const { assertUpdateCanRestart } = await import("../../platform/update-guard");
    const session = { ...state.loadQuerySession("workspace"), draft: "SELECT 42" };
    const write = vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => { throw new DOMException("Full", "QuotaExceededError"); });
    state.saveQuerySession("workspace", session);
    expect(state.loadQuerySession("workspace").draft).toBe("SELECT 42");
    expect(assertUpdateCanRestart).toThrow("SQL draft");
    write.mockRestore();
    state.saveQuerySession("workspace", session);
    expect(assertUpdateCanRestart).not.toThrow();
  });

  it("removes persisted and in-memory drafts on factory reset without clearing unrelated preferences", async () => {
    const state = await import("./query-state");
    state.saveQuerySession("workspace", { ...state.loadQuerySession("workspace"), draft: "SELECT 42" });
    localStorage.setItem("unrelated", "keep");
    state.clearQuerySessions();
    expect(state.loadQuerySession("workspace").draft).toBe("");
    expect(localStorage.getItem("nodalstudio.query-draft.v1:workspace")).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("keep");
  });
});
