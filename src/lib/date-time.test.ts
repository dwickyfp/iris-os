import { describe, expect, it } from "vitest";
import {
  APP_TIME_ZONE,
  formatAppDate,
  formatAppDateTime,
  formatInAppTimeZone,
} from "./date-time";

describe("date-time", () => {
  const utcDate = new Date("2026-08-14T18:30:00.000Z");

  it("uses Asia/Jakarta for date boundaries", () => {
    expect(APP_TIME_ZONE).toBe("Asia/Jakarta");
    expect(formatAppDate(utcDate)).toBe("Aug 15, 2026");
  });

  it("formats date and time in Asia/Jakarta", () => {
    expect(formatAppDateTime(utcDate)).toBe("Aug 15, 2026, 1:30 AM");
    expect(
      formatInAppTimeZone(utcDate, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      }),
    ).toBe("Saturday, August 15, 2026 at 1:30:00 AM");
  });
});
