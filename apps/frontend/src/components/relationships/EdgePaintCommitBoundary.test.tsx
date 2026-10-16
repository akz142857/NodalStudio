import { Component } from "react";
import { createPortal } from "react-dom";
import { render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { EdgePaintCommitBoundary } from "./EdgePaintCommitBoundary";

afterEach(() => { document.querySelectorAll("[data-test-paint-host]").forEach((node) => node.remove()); });

it("retires edge children outside the live document and restores the same root, siblings and surviving paths", () => {
  const host = document.createElement("div"); host.dataset.testPaintHost = "true";
  const root = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const sibling = document.createElement("div"); host.append(root, sibling); document.body.append(host);
  const cleanup: boolean[] = [];
  class Paint extends Component<{ id: number }> {
    componentWillUnmount() { cleanup.push(root.isConnected); }
    render() { return <g tabIndex={0} data-id={this.props.id}><path d="M0,0 L2,2" /></g>; }
  }
  const scope = {};
  const tree = (count: number, scopeValue = scope, enabled = true) => <EdgePaintCommitBoundary root={root} count={count} scope={scopeValue} enabled={enabled}>
    {createPortal(Array.from({ length: count }, (_, id) => <Paint key={id} id={id} />), root)}
  </EdgePaintCommitBoundary>;
  const { rerender, unmount } = render(tree(512));
  const surviving = root.querySelector('[data-id="0"]');
  (surviving as SVGGElement).focus();
  expect(document.activeElement).toBe(surviving);
  rerender(tree(2));
  expect(cleanup).toHaveLength(510); expect(cleanup.every((connected) => !connected)).toBe(true);
  expect(root.isConnected).toBe(true); expect(root.nextSibling).toBe(sibling);
  expect(root.querySelector('[data-id="0"]')).toBe(surviving);
  expect(document.activeElement).toBe(surviving);
  rerender(tree(10)); cleanup.length = 0;
  rerender(tree(1)); expect(cleanup.every(Boolean)).toBe(true);
  rerender(tree(512)); cleanup.length = 0;
  rerender(tree(1, {})); expect(cleanup.every(Boolean)).toBe(true);
  rerender(tree(512, scope, false)); cleanup.length = 0;
  rerender(tree(1, scope, false)); expect(cleanup.every(Boolean)).toBe(true);
  unmount(); expect(root.childElementCount).toBe(0); expect(root.isConnected).toBe(true);
});
