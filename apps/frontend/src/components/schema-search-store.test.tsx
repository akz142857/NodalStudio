import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createSchemaSearchStore, DeferredSearchQuery } from "./schema-search-store";

describe("schema search store", () => {
  it("updates query consumers without re-rendering their parent", () => {
    const store = createSchemaSearchStore();
    let parentRenders = 0;
    function Parent() {
      parentRenders += 1;
      return <DeferredSearchQuery store={store}>{(query) => <output>{query || "empty"}</output>}</DeferredSearchQuery>;
    }
    render(<Parent />);
    act(() => store.getState().setQuery("orders"));
    expect(screen.getByRole("status")).toHaveTextContent("orders");
    expect(parentRenders).toBe(1);
  });

  it("keeps independent state per store instance", () => {
    const first = createSchemaSearchStore();
    const second = createSchemaSearchStore();
    first.getState().setQuery("users");
    first.getState().setOpen(true);
    expect(second.getState()).toMatchObject({ query: "", open: false, active: 0 });
  });
});
