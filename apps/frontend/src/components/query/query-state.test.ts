import { describe, expect, it } from "vitest";
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
