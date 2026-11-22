import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  formatDayAwareTimestamp,
  formatRelativeTime,
  formatRelativeTimeLabel,
  formatRelativeTimeUntil,
  formatRelativeTimeUntilLabel,
  formatShortTimestamp,
  formatUpcomingTimestamp,
  msUntilRelativeTimeChange,
  relativeTimeElapsedMs,
  resolveTimestampLocale,
} from "./timestampFormat";

describe("resolveTimestampLocale", () => {
  it("defers to the runtime default when the host reports no locale", () => {
    expect(resolveTimestampLocale(null)).toBeUndefined();
    expect(resolveTimestampLocale(undefined)).toBeUndefined();
    expect(resolveTimestampLocale("   ")).toBeUndefined();
  });

  it("uses a BCP-47 tag reported by the host", () => {
    expect(resolveTimestampLocale("en-GB")).toBe("en-GB");
  });

  it("defers to the runtime default rather than throwing on an unusable tag", () => {
    expect(resolveTimestampLocale("not a locale")).toBeUndefined();
    expect(resolveTimestampLocale("en_GB")).toBeUndefined();
  });
});

describe("formatShortTimestamp", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each([
    ["en-GB", "15:44"],
    ["en-US", "3:44 PM"],
  ])("honors %s and the explicit hour-cycle settings", async (locale, localTime) => {
    vi.stubGlobal("window", { desktopBridge: { getSystemLocale: () => locale } });
    vi.resetModules();
    const { formatShortTimestamp: format } = await import("./timestampFormat");
    const date = new Date(2026, 3, 7, 15, 44).toISOString();
    // ICU can separate the day period with a narrow no-break space.
    expect(format(date, "locale").replace(/[  ]/g, " ")).toBe(localTime);
    expect(format(date, "12-hour").replace(/[  ]/g, " ")).toMatch(/^3:44 [ap]m$/i);
    expect(format(date, "24-hour")).toBe("15:44");
  });
});

describe("resolveWeekStartsOn", () => {
  it.each([
    ["en-US", 0],
    ["en-GB", 1],
    ["pl-PL", 1],
    ["ar-EG", 6],
  ])("starts the %s week on weekday %i", async (locale, weekday) => {
    const { resolveWeekStartsOn } = await import("./timestampFormat");
    expect(resolveWeekStartsOn(locale)).toBe(weekday);
  });

  it("leaves the default to the caller for a malformed locale", async () => {
    const { resolveWeekStartsOn } = await import("./timestampFormat");
    expect(resolveWeekStartsOn("not a locale")).toBeUndefined();
  });

  it("follows the locale the desktop host reports", async () => {
    vi.stubGlobal("window", { desktopBridge: { getSystemLocale: () => "en-GB" } });
    vi.resetModules();
    const { weekStartsOn } = await import("./timestampFormat");
    expect(weekStartsOn).toBe(1);
    vi.unstubAllGlobals();
    vi.resetModules();
  });
});

describe("formatChatTimestampTooltip", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it.each(["de-DE", "it-IT"])("keeps the English date label in a %s runtime", async (locale) => {
    const DateTimeFormat = Intl.DateTimeFormat;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
      return new DateTimeFormat(locales ?? locale, options);
    });
    vi.resetModules();
    const { formatChatTimestampTooltip: format } = await import("./timestampFormat");
    const date = new Date(2026, 5, 4, 14, 4).toISOString();

    expect(format(date, "24-hour")).toBe("14:04, 4th June 2026");
  });
});

describe("formatRelativeTimeUntilLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns Expired when the instant is in the past", () => {
    expect(formatRelativeTimeUntilLabel("2026-04-07T11:59:00.000Z")).toBe("Expired");
  });

  it("formats seconds remaining", () => {
    expect(formatRelativeTimeUntilLabel("2026-04-07T12:00:45.000Z")).toBe("45s left");
  });

  it("formats minutes remaining", () => {
    expect(formatRelativeTimeUntilLabel("2026-04-07T12:15:00.000Z")).toBe("15m left");
  });

  it("formats hours remaining", () => {
    expect(formatRelativeTimeUntilLabel("2026-04-07T18:00:00.000Z")).toBe("6h left");
  });
});

describe("formatDayAwareTimestamp", () => {
  // Instants are built with the local-time Date constructor so the
  // calendar-day boundaries hold in any test timezone or locale.
  const iso = (y: number, monthIndex: number, d: number, h: number, mi: number) =>
    new Date(y, monthIndex, d, h, mi).toISOString();
  const now = new Date(2026, 7, 14, 12, 0).getTime();
  const time = (isoDate: string) => formatShortTimestamp(isoDate, "12-hour");

  it("shows time only for today", () => {
    const messageAt = iso(2026, 7, 14, 9, 30);
    expect(formatDayAwareTimestamp(messageAt, "12-hour", now)).toBe(time(messageAt));
  });

  it("labels the previous calendar day as yesterday even when under 24h old", () => {
    const messageAt = iso(2026, 7, 13, 23, 30);
    const justPastMidnight = new Date(2026, 7, 14, 0, 30).getTime();
    expect(formatDayAwareTimestamp(messageAt, "12-hour", justPastMidnight)).toBe(
      `yesterday at ${time(messageAt)}`,
    );
  });

  it("prefixes older same-year messages with the numeric date", () => {
    const messageAt = iso(2026, 7, 12, 12, 34);
    const datePart = new Intl.DateTimeFormat(undefined, {
      month: "numeric",
      day: "numeric",
    }).format(new Date(messageAt));
    expect(formatDayAwareTimestamp(messageAt, "12-hour", now)).toBe(
      `${datePart} ${time(messageAt)}`,
    );
  });

  it("includes the year once the calendar year differs", () => {
    const messageAt = iso(2025, 11, 31, 18, 0);
    const datePart = new Intl.DateTimeFormat(undefined, {
      month: "numeric",
      day: "numeric",
      year: "numeric",
    }).format(new Date(messageAt));
    expect(formatDayAwareTimestamp(messageAt, "12-hour", now)).toBe(
      `${datePart} ${time(messageAt)}`,
    );
  });

  it("uses the host locale for both the numeric date and wall-clock time", async () => {
    vi.stubGlobal("window", {
      desktopBridge: { getSystemLocale: () => "en-GB" },
    });
    vi.resetModules();

    const { formatDayAwareTimestamp: formatWithHostLocale } = await import("./timestampFormat");
    const messageAt = iso(2026, 7, 12, 15, 44);

    expect(formatWithHostLocale(messageAt, "locale", now)).toBe("12/08 15:44");

    vi.unstubAllGlobals();
  });

  it("returns an empty string for invalid input", () => {
    expect(formatDayAwareTimestamp("not-a-date", "12-hour", now)).toBe("");
  });
});

describe("formatUpcomingTimestamp", () => {
  const now = new Date(2026, 7, 14, 12, 0).getTime();

  it.each([
    [14, ""],
    [15, "tomorrow at "],
    [13, "yesterday at "],
  ])("keeps the reset day visible for day %i", (day, prefix) => {
    const resetAt = new Date(2026, 7, day, 14, 30).toISOString();
    expect(formatUpcomingTimestamp(resetAt, "12-hour", now)).toBe(
      `${prefix}${formatShortTimestamp(resetAt, "12-hour")}`,
    );
  });

  it("preserves the date of an older reset in the transcript", () => {
    const resetAt = new Date(2026, 7, 12, 14, 30).toISOString();
    expect(formatUpcomingTimestamp(resetAt, "12-hour", now)).toBe(
      formatDayAwareTimestamp(resetAt, "12-hour", now),
    );
  });
});

describe("invalid timestamp inputs", () => {
  it("returns an empty short timestamp instead of throwing", () => {
    expect(formatShortTimestamp("not-a-date", "12-hour")).toBe("");
  });

  it("returns an empty relative time label instead of a NaN label", () => {
    expect(formatRelativeTime("not-a-date")).toBeNull();
    expect(formatRelativeTimeLabel("not-a-date")).toBe("");
  });

  it("has no relative time boundary for an invalid timestamp", () => {
    expect(relativeTimeElapsedMs("not-a-date")).toBeNull();
    expect(msUntilRelativeTimeChange("not-a-date")).toBeNull();
  });

  it("returns an empty relative time until label instead of a NaN label", () => {
    expect(formatRelativeTimeUntil("not-a-date")).toBeNull();
    expect(formatRelativeTimeUntilLabel("not-a-date")).toBe("");
  });
});

describe("relative time boundaries", () => {
  const nowMs = Date.parse("2026-04-07T12:00:00.000Z");

  it("waits for the label to change instead of the next second", () => {
    // "just now" turns into "1m ago" at the one-minute mark.
    expect(msUntilRelativeTimeChange("2026-04-07T11:59:40.000Z", nowMs)).toBe(40_000);
    // "2m ago" turns into "3m ago" a minute after the 2m mark.
    expect(msUntilRelativeTimeChange("2026-04-07T11:57:30.000Z", nowMs)).toBe(30_000);
    // "3h ago" holds until the 4h mark.
    expect(msUntilRelativeTimeChange("2026-04-07T08:30:00.000Z", nowMs)).toBe(30 * 60_000);
    // "2d ago" holds until the 3d mark.
    expect(msUntilRelativeTimeChange("2026-04-05T00:00:00.000Z", nowMs)).toBe(12 * 3_600_000);
    // A future timestamp reads "just now" until a minute after it.
    expect(msUntilRelativeTimeChange("2026-04-07T12:00:10.000Z", nowMs)).toBe(70_000);
    // A far-future timestamp stays within setTimeout's range.
    expect(msUntilRelativeTimeChange("2026-06-01T00:00:00.000Z", nowMs)).toBe(86_400_000);
  });

  it("keeps the elapsed snapshot stable while the label is unchanged", () => {
    const at = "2026-04-07T11:57:30.000Z";
    expect(relativeTimeElapsedMs(at, nowMs)).toBe(2 * 60_000);
    expect(relativeTimeElapsedMs(at, nowMs + 29_999)).toBe(2 * 60_000);
    expect(relativeTimeElapsedMs(at, nowMs + 30_000)).toBe(3 * 60_000);
  });
});
