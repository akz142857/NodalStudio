import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportSnapshot } from "../test/schema-report-fixture";
import { diagramTable } from "../test/diagram-comparison-fixture";
import { SchemaPreflightPanel } from "./SchemaPreflightPanel";
import * as checker from "../preflight/schema-preflight";

const fixture = structuredClone(reportSnapshot);
fixture.schemas[0].tables[1].primaryKey = null;
Object.assign(fixture.schemas[0].tables[1].columns[1], { typeName: "text", formattedType: "text" });
const pkArticle = () => { fireEvent.click(screen.getByRole("button", { name: /Design suggestion.*public.orders/ })); return screen.getByRole("article", { name: "table-primary-key: public.orders" }); };
const rows = () => document.querySelectorAll(".preflight-finding-row");
const mount = (snapshot = fixture) => render(<SchemaPreflightPanel snapshot={snapshot} onClose={() => {}} onLocate={() => {}} />);
const checkStatus = () => within(screen.getByRole("group", { name: "Structure checks" })).getByRole("status");
const finish = async () => waitFor(() => expect(checkStatus()).toHaveTextContent("Completed"));

describe("Structure preflight panel", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("retains filters, selection and review draft while hidden and restores them on return", async () => {
    const props = {snapshot: fixture, onClose: () => {}, onLocate: () => {}};
    const {rerender} = render(<SchemaPreflightPanel {...props} />); await finish();
    fireEvent.change(screen.getByLabelText("Search findings"), {target:{value:"orders"}});
    fireEvent.click(within(pkArticle()).getByText("Ignore with a reason"));
    fireEvent.change(within(pkArticle()).getByLabelText("Ignore reason"), {target:{value:"Review in progress"}});
    rerender(<SchemaPreflightPanel {...props} active={false} />);
    expect(screen.queryByRole("region",{name:"Structure preflight"})).not.toBeInTheDocument();
    rerender(<SchemaPreflightPanel {...props} active />);
    expect(screen.getByLabelText("Search findings")).toHaveValue("orders");
    expect(within(pkArticle()).getByLabelText("Ignore reason")).toHaveValue("Review in progress");
  });

  it("explains scope, dialect, coverage, evidence, suggestions and information limits without claiming validity", async () => {
    const locate = vi.fn(); const close = vi.fn();
    render(<SchemaPreflightPanel snapshot={fixture} onClose={close} onLocate={locate} />);
    await finish();
    expect(checkStatus()).toHaveTextContent("3 tables · 6 columns · 1 physical foreign keys · 2 findings");
    expect(screen.getByText(/PostgreSQL 17/)).toBeVisible();
    fireEvent.click(screen.getByRole("button",{name:"Rule coverage"}));
    fireEvent.click(screen.getByText("MySQL FK types",{selector:"strong"}));
    expect(screen.getByText(/Not applicable: this is not a MySQL/)).toBeVisible();
    fireEvent.click(screen.getByRole("button",{name:"Check findings"}));
    pkArticle();
    expect(within(pkArticle()).getByText("Snapshot primaryKey: absent")).toBeVisible();
    fireEvent.click(within(pkArticle()).getByRole("button", { name: "Locate table" }));
    expect(locate).toHaveBeenCalledWith(fixture.schemas[0].tables[1].key);
    fireEvent.click(screen.getByRole("button",{name:/Suspected issue.*public.orders/}));
    const suspect = screen.getByRole("article", { name: /postgres-fk-types/ });
    fireEvent.click(within(suspect).getByRole("button", { name: /Locate referenced table/ }));
    expect(locate).toHaveBeenLastCalledWith(fixture.schemas[0].tables[0].key);
    fireEvent.click(screen.getByRole("button", { name: "Back to diagram" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("filters independently by rule, outcome and evidence search and enables naming hints explicitly", async () => {
    const snapshot = structuredClone(fixture); snapshot.schemas[1].tables[0].key.name = "archive orders";
    mount(snapshot); await finish();
    fireEvent.change(screen.getByLabelText("Rule", { exact: true }), { target: { value: "table-primary-key" } });
    expect(rows()).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "suspected" } });
    expect(rows()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Rule", { exact: true }), { target: { value: "" } });
    expect(rows()).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Search findings"), { target: { value: "customer_id" } });
    expect(rows()).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Search findings"), { target: { value: "no-match" } });
    expect(rows()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Search findings"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "style" } });
    expect(rows()).toHaveLength(0);
    fireEvent.click(screen.getByRole("checkbox", { name: /Include whitespace/ }));
    await finish();
    expect(screen.getByRole("article", { name: /name-spaces/ })).toHaveTextContent("may require quoting in SQL");
    fireEvent.click(screen.getByRole("button",{name:"Rule coverage"}));
    fireEvent.click(screen.getByText("Names containing whitespace",{selector:"strong"}));
    expect(screen.getByText(/Quoted identifiers containing whitespace are legal/)).toBeVisible();
  });

  it("requires and persists ignore reasons, restores findings, and retains check counts across reruns", async () => {
    const { unmount } = mount(); await finish();
    fireEvent.click(within(pkArticle()).getByText("Ignore with a reason"));
    expect(within(pkArticle()).getByRole("button", { name: "Ignore finding" })).toBeDisabled();
    fireEvent.change(within(pkArticle()).getByLabelText("Ignore reason"), { target: { value: "Intentional staging table" } });
    fireEvent.click(within(pkArticle()).getByRole("button", { name: "Ignore finding" }));
    expect(screen.queryByRole("article", { name: "table-primary-key: public.orders" })).not.toBeInTheDocument();
    expect(checkStatus()).toHaveTextContent("2 findings (1 ignored)");
    unmount(); mount(); await finish();
    expect(checkStatus()).toHaveTextContent("1 ignored");
    fireEvent.click(screen.getByRole("checkbox", { name: "Show ignored findings" }));
    expect(within(pkArticle()).getByText("Ignored: Intentional staging table")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Run checks again" })); await finish();
    expect(checkStatus()).toHaveTextContent("1 ignored");
    fireEvent.click(within(pkArticle()).getByRole("button", { name: "Restore finding" }));
    expect(checkStatus()).toHaveTextContent("0 ignored");
  });

  it("keeps failed review saves in session and retries without losing the reason", async () => {
    mount(); await finish();
    const spy = vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => { throw new Error("storage denied"); });
    fireEvent.click(within(pkArticle()).getByText("Ignore with a reason"));
    fireEvent.change(within(pkArticle()).getByLabelText("Ignore reason"), { target: { value: "Reviewed locally" } });
    fireEvent.click(within(pkArticle()).getByRole("button", { name: "Ignore finding" }));
    expect(screen.getByRole("alert")).toHaveTextContent("remain in this session");
    fireEvent.click(screen.getByRole("button", { name: "Retry review save" }));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show ignored findings" }));
    expect(pkArticle()).toHaveTextContent("Reviewed locally");
  });

  it("does not reuse ignored reasons across sources/fingerprints and clears stale run output", async () => {
    const { rerender } = mount(); await finish();
    fireEvent.click(within(pkArticle()).getByText("Ignore with a reason"));
    fireEvent.change(within(pkArticle()).getByLabelText("Ignore reason"), { target: { value: "Expected" } });
    fireEvent.click(within(pkArticle()).getByRole("button", { name: "Ignore finding" }));
    for (const snapshot of [{ ...fixture, sourceId: "different" }, { ...fixture, fingerprint: "different" }]) {
      rerender(<SchemaPreflightPanel snapshot={snapshot} onClose={() => {}} onLocate={() => {}} />);
      expect(checkStatus()).toHaveTextContent("Running");
      await finish(); expect(pkArticle()).toBeVisible(); expect(checkStatus()).toHaveTextContent("0 ignored");
    }
  });

  it("shows uncertainty for MySQL string lengths and safe empty results", async () => {
    const snapshot = structuredClone(reportSnapshot); snapshot.database.databaseType = "mySql";
    for (const table of snapshot.schemas.flatMap((schema) => schema.tables)) for (const column of table.columns) Object.assign(column, { typeSchema: "mysql", typeName: "varchar", formattedType: table.key.name === "customers" ? "varchar(100)" : "varchar(20)" });
    const { rerender } = mount(snapshot); await finish();
    expect(within(screen.getByRole("article", { name: /mysql-fk-types/ })).getByText("Information gap")).toBeVisible();
    expect(within(screen.getByRole("article")).getByText(/neither is captured/)).toBeVisible();
    fireEvent.click(screen.getByRole("button",{name:"Rule coverage"}));
    expect(screen.getByText("Partial")).toBeVisible();
    fireEvent.click(screen.getByRole("button",{name:"Check findings"}));
    rerender(<SchemaPreflightPanel snapshot={reportSnapshot} onClose={() => {}} onLocate={() => {}} />); await finish();
    expect(screen.getByText(/No findings from the enabled checks/)).toBeVisible();
    expect(screen.queryByText(/database is valid/i)).not.toBeInTheDocument();
  });

  it("paginates large finding lists and resets the page size when filtering", async () => {
    const snapshot = { ...reportSnapshot, schemas: [{ name: "public", views: [], enums: [], tables: Array.from({ length: 150 }, (_, i) => ({ ...diagramTable(`table_${i}`), primaryKey: null })) }] };
    mount(snapshot); await finish();
    expect(rows()).toHaveLength(100);
    fireEvent.click(screen.getByRole("button", { name: "Load 100 more findings" }));
    expect(rows()).toHaveLength(150);
    fireEvent.change(screen.getByLabelText("Search findings"), { target: { value: "table_" } });
    expect(rows()).toHaveLength(100);
  });

  it("shows metadata errors and allows rerunning; unreadable notes never prevent checks", async () => {
    const key = `nodalstudio:preflight-reviews:v1:${JSON.stringify([fixture.sourceId, fixture.fingerprint])}`;
    localStorage.setItem(key, "broken json");
    vi.spyOn(checker, "runSchemaPreflight").mockImplementationOnce(() => { throw new Error("fixture failure"); });
    mount();
    await waitFor(() => expect(screen.getAllByRole("alert").some((element) => element.textContent?.includes("Preflight failed"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Retry preflight" })); await finish();
    expect(screen.getByRole("alert")).toHaveTextContent("could not be loaded");
    expect(pkArticle()).toBeVisible();
  });

  it("retries loading local review notes without rerunning checks or writing to storage", async () => {
    const key = `nodalstudio:preflight-reviews:v1:${JSON.stringify([fixture.sourceId, fixture.fingerprint])}`;
    localStorage.setItem(key, "broken json"); const check = vi.spyOn(checker, "runSchemaPreflight");
    mount(); await finish(); expect(screen.getByRole("alert")).toHaveTextContent("could not be loaded");
    localStorage.removeItem(key); const save = vi.spyOn(localStorage, "setItem");
    fireEvent.click(screen.getByRole("button", { name: "Retry review load" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); expect(check).toHaveBeenCalledOnce(); expect(save).not.toHaveBeenCalled(); expect(pkArticle()).toBeVisible();
  });
});
