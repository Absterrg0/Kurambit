import { MessageId, RunId } from "@kurambit/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  observeTimelineRun,
  getRowBottom,
  readTimelinePosition,
  rememberTimelinePosition,
  timelineContentOverflowsViewport,
} from "./timelineScrollAnchoring";

function buildState({
  positions,
  sizes,
  scroll = 0,
  scrollLength = 700,
}: {
  readonly positions: readonly number[];
  readonly sizes: readonly number[];
  readonly scroll?: number;
  readonly scrollLength?: number;
}) {
  return {
    data: positions.map((_, index) => index),
    scroll,
    scrollLength,
    positionAtIndex: (index: number) => positions[index],
    sizeAtIndex: (index: number) => sizes[index],
  };
}

describe("timelineContentOverflowsViewport", () => {
  const inset = { composerInset: 100, anchorOffset: 24 };

  it("reports overflow from the last row, not the inset spacer", () => {
    const fits = buildState({ positions: [0, 200], sizes: [200, 300], scrollLength: 700 });
    expect(timelineContentOverflowsViewport(fits, inset)).toBe(false);

    const overflows = buildState({ positions: [0, 200], sizes: [200, 400], scrollLength: 700 });
    expect(timelineContentOverflowsViewport(overflows, inset)).toBe(true);
  });

  it("treats an empty or unmeasured list as fitting", () => {
    expect(timelineContentOverflowsViewport(undefined, inset)).toBe(false);
    expect(
      timelineContentOverflowsViewport(
        buildState({ positions: [0, 200], sizes: [200, 400], scrollLength: 0 }),
        inset,
      ),
    ).toBe(false);
    expect(timelineContentOverflowsViewport(buildState({ positions: [], sizes: [] }), inset)).toBe(
      false,
    );
    expect(
      timelineContentOverflowsViewport(
        buildState({ positions: [0, 200], sizes: [200, Number.NaN] }),
        inset,
      ),
    ).toBe(false);
  });
});

describe("timeline scroll anchoring", () => {
  it("measures row bottoms from LegendList row position and size", () => {
    const state = buildState({
      positions: [0, 120],
      sizes: [80, 40],
    });

    expect(getRowBottom(state, 1)).toBe(160);
  });
});

describe("observeTimelineRun", () => {
  const existing = {
    threadKey: "environment:thread",
    hydrated: true,
    runId: RunId.make("existing-run"),
    queued: false,
    messageId: MessageId.make("existing-message"),
  };
  const next = {
    ...existing,
    runId: RunId.make("new-run"),
    messageId: MessageId.make("new-message"),
  };

  it("opens an already hydrated thread at the end instead of framing its existing run", () => {
    const opened = observeTimelineRun(null, existing);
    expect(opened.anchorMessageId).toBeNull();
    expect(observeTimelineRun(opened.observation, existing).anchorMessageId).toBeNull();
    expect(observeTimelineRun(opened.observation, next).anchorMessageId).toBe(next.messageId);
  });

  it("does not mistake delayed hydration for a newly started turn", () => {
    const loading = { ...existing, hydrated: false, runId: null, messageId: null };
    const opened = observeTimelineRun(null, loading);
    const stillLoading = observeTimelineRun(opened.observation, loading);
    const hydrated = observeTimelineRun(stillLoading.observation, existing);
    expect(hydrated.anchorMessageId).toBeNull();
    expect(observeTimelineRun(hydrated.observation, next).anchorMessageId).toBe(next.messageId);
  });

  it("keeps the end position while a stale cached run is replaced during synchronization", () => {
    const cached = observeTimelineRun(null, { ...existing, hydrated: false });
    const synchronizing = observeTimelineRun(cached.observation, { ...next, hydrated: false });
    expect(synchronizing.anchorMessageId).toBeNull();
    const live = observeTimelineRun(synchronizing.observation, next);
    expect(live.anchorMessageId).toBeNull();
    expect(
      observeTimelineRun(live.observation, {
        ...next,
        runId: RunId.make("later-run"),
        messageId: MessageId.make("later-message"),
      }).anchorMessageId,
    ).toBe("later-message");
  });

  it("does not anchor when an existing run's user message arrives after its run", () => {
    const opened = observeTimelineRun(null, { ...existing, messageId: null });
    expect(observeTimelineRun(opened.observation, existing).anchorMessageId).toBeNull();
  });

  it("waits for a new run's user message and frames it only once", () => {
    const opened = observeTimelineRun(null, existing);
    const waiting = observeTimelineRun(opened.observation, { ...next, messageId: null });
    expect(waiting.anchorMessageId).toBeNull();
    const ready = observeTimelineRun(waiting.observation, next);
    expect(ready.anchorMessageId).toBe(next.messageId);
    expect(observeTimelineRun(ready.observation, next).anchorMessageId).toBeNull();
  });

  it("establishes a separate baseline when the same thread ID belongs to another environment", () => {
    const opened = observeTimelineRun(null, existing);
    expect(
      observeTimelineRun(opened.observation, { ...next, threadKey: "other:thread" })
        .anchorMessageId,
    ).toBeNull();
  });

  it("does not reset the baseline during a temporary loss of projection data", () => {
    const opened = observeTimelineRun(null, existing);
    const reconnecting = observeTimelineRun(opened.observation, {
      ...existing,
      hydrated: false,
      runId: null,
    });
    expect(observeTimelineRun(reconnecting.observation, existing).anchorMessageId).toBeNull();
  });

  it("frames the first new run in an initially empty thread", () => {
    const opened = observeTimelineRun(null, { ...existing, runId: null, messageId: null });
    expect(observeTimelineRun(opened.observation, next).anchorMessageId).toBe(next.messageId);
  });

  it("waits for a queued run to start before framing it", () => {
    const opened = observeTimelineRun(null, { ...existing, queued: true });
    expect(opened.anchorMessageId).toBeNull();
    expect(observeTimelineRun(opened.observation, existing).anchorMessageId).toBe(
      existing.messageId,
    );
  });
});

describe("remembered timeline positions", () => {
  it("keeps reading positions and end-follow independent across threads and environments", () => {
    const reading = { rowId: "message-4", offsetWithinRow: 32, scrollOffset: 932, atEnd: false };
    const following = { rowId: "message-9", offsetWithinRow: 10, scrollOffset: 2010, atEnd: true };
    rememberTimelinePosition("scroll-test-a:thread-1", reading, false);
    rememberTimelinePosition("scroll-test-a:thread-2", following, true);
    rememberTimelinePosition("scroll-test-b:thread-1", following, true);
    expect(readTimelinePosition("scroll-test-a:thread-1")).toEqual(reading);
    expect(readTimelinePosition("scroll-test-a:thread-2")).toEqual(following);
    expect(readTimelinePosition("scroll-test-b:thread-1")).toEqual(following);
    expect(readTimelinePosition("scroll-test-a:unvisited")).toBeUndefined();
    rememberTimelinePosition("scroll-test-a:thread-1", following, true);
    expect(readTimelinePosition("scroll-test-a:thread-1")).toEqual(following);
  });
});
