import { expect, it } from "vitest";
import { CanvasAttribution, coveredTime } from "./canvas-attribution";
it("clips and unions nested synchronous spans instead of double-counting a frame", () => {
  expect(coveredTime([{ start: -10, end: 20 }, { start: 5, end: 15 }, { start: 15, end: 40 }, { start: 70, end: 110 }], 0, 100)).toBe(70);
});
it("keeps React effect costs and unknown frame time separate from measured synchronous work", () => {
  const trace = new CanvasAttribution(); trace.phase = "load";
  trace.span({ kind: "raf-callback", start: 0, end: 20 });
  trace.span({ kind: "node-internals:measure", start: 5, end: 15, count: 32 });
  trace.react.push({ kind: "react-passive-effects", phase: "load", detail: "mount", at: 80, duration: 30, commitTime: 40 });
  trace.frames.push({ phase: "load", detail: "mount", start: 0, end: 100, ms: 100 });
  const gap = trace.summary("load").find((row) => "frame" in row);
  expect(gap && "frame" in gap ? gap.frame.instrumentedWallMs : undefined).toBe(20);
  expect(gap && "frame" in gap ? gap.frame.unattributedWallMs : undefined).toBe(80);
  expect(gap && "frame" in gap ? gap.frame.passiveEffectsMs : undefined).toBe(30);
  expect(JSON.stringify(trace.snapshot())).not.toContain('"paintMs"');
});
it("bounds retained events, reports loss explicitly and resets the scenario clock anchor", () => {
  const trace = new CanvasAttribution(2); trace.phase = "load";
  trace.span({ kind: "one", start: 0, end: 1 }); trace.effect("react-render", 2, 0);
  trace.span({ kind: "dropped", start: 0, end: 1 });
  expect(trace.snapshot().dropped).toBe(1);
  const frame = { start: 0, end: 100, ms: 100, phase: "load", detail: "test" };
  trace.frame(frame); trace.frame(frame); trace.frame(frame);
  expect(trace.frames).toHaveLength(2); expect(trace.dropped).toBe(2);
  trace.reset(); expect(trace.snapshot()).toMatchObject({ spans: [], react: [], frames: [], dropped: 0 });
});
