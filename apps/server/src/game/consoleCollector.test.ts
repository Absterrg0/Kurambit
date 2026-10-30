import { expect, it } from "vite-plus/test";
import { createConsoleCollector } from "./consoleCollector.ts";

it("keeps only the newest slice and reports the drop", () => {
  const collector = createConsoleCollector({ maxMessages: 3, maxChars: 10 });
  for (const text of ["one", "two", "three", "four"]) collector.record("log", text);
  expect(collector.messages().map((entry) => entry.text)).toEqual(["two", "three", "four"]);
  expect(collector.dropped()).toBe(1);
  expect(collector.totalErrors()).toBe(0);
});

it("counts an error emitted after forty ordinary logs", () => {
  const collector = createConsoleCollector({ maxMessages: 40, maxChars: 500 });
  for (let index = 0; index < 40; index++) collector.record("log", `ordinary ${index}`);
  collector.record("error", "engine blew up on frame 41");
  // The run must fail on the total, not on the retained suffix: the error's
  // own text was kept by displacing the oldest ordinary log.
  expect(collector.totalErrors()).toBe(1);
  expect(collector.messages()).toHaveLength(40);
  expect(collector.messages().some((entry) => entry.text.includes("blew up"))).toBe(true);
  expect(collector.dropped()).toBe(1);
});

it("preserves a salient late error when the ring is full of logs", () => {
  const collector = createConsoleCollector({ maxMessages: 2, maxChars: 500 });
  collector.record("log", "a");
  collector.record("log", "b");
  collector.record("error", "late failure");
  const texts = collector.messages().map((entry) => entry.text);
  expect(texts).toContain("late failure");
  expect(texts).toHaveLength(2);
  expect(collector.totalErrors()).toBe(1);
});

it("an all-error ring still drops honestly and counts every error", () => {
  const collector = createConsoleCollector({ maxMessages: 1, maxChars: 500 });
  collector.record("error", "first");
  collector.record("error", "second");
  expect(collector.messages().map((entry) => entry.text)).toEqual(["second"]);
  expect(collector.totalErrors()).toBe(2);
  expect(collector.dropped()).toBe(1);
});

it("drains retained text and the drop count together", () => {
  const collector = createConsoleCollector({ maxMessages: 2, maxChars: 500 });
  collector.record("log", "a");
  collector.record("log", "b");
  collector.record("log", "c");
  const drained = collector.drain();
  expect(drained.messages.map((entry) => entry.text)).toEqual(["b", "c"]);
  expect(drained.dropped).toBe(1);
  expect(collector.messages()).toEqual([]);
  expect(collector.dropped()).toBe(0);
  // The total survives the drain: per-act text resets, run accounting does not.
  expect(collector.totalErrors()).toBe(0);
});
