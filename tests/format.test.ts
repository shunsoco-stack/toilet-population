import { describe, expect, it } from "vitest";
import { formatDuration, formatTimer } from "../src/lib/format";

describe("Japanese time formatting", () => {
  it("rounds remaining time up so a positive remainder never looks expired", () => {
    expect(formatTimer(600_000)).toBe("10:00");
    expect(formatTimer(1)).toBe("00:01");
    expect(formatTimer(-1)).toBe("00:00");
  });
  it("rounds recorded elapsed time down", () => {
    expect(formatDuration(125_999)).toBe("2分 05秒");
    expect(formatDuration(600_000)).toBe("10分 00秒");
    expect(formatDuration(-1)).toBe("0分 00秒");
  });
});
