import { describe, it, expect } from "vitest";
import { sampleChart } from "../src/modules/portfolio/sampling.js";
describe("consistent chart sampling", () => {
  it("gives old daily data and dense recent hourly data equal daily weight", () => {
    const points = [
      { at: "2026-08-01T00:00:00Z", value: "100" },
      { at: "2026-08-02T00:00:00Z", value: "110" },
      ...Array.from({ length: 24 }, (_, h) => ({
        at: `2026-08-03T${String(h).padStart(2, "0")}:00:00Z`,
        value: String(120 + h),
      })),
    ];
    const sampled = sampleChart(points, "1m");
    expect(sampled).toHaveLength(3);
    expect(sampled.map((p) => p.value)).toEqual(["100", "110", "143"]);
    expect(
      new Date(sampled[2]!.at).getTime() - new Date(sampled[1]!.at).getTime(),
    ).toBe(86400000);
    expect(sampled[2]!.sourceAt).toBe("2026-08-03T23:00:00Z");
  });
  it("uses hourly, daily and weekly buckets appropriate to the chosen horizon", () => {
    const points = Array.from({ length: 24 * 14 }, (_, h) => ({
      at: new Date(Date.UTC(2026, 7, 1) + h * 3600000).toISOString(),
      value: String(h),
    }));
    expect(sampleChart(points.slice(0, 24), "1d")).toHaveLength(24);
    expect(sampleChart(points, "3w")).toHaveLength(14);
    expect(sampleChart(points, "1y").length).toBeLessThanOrEqual(3);
  });
  it("retains actual values and leaves missing time buckets unfilled", () => {
    const points = [
      { at: "2026-08-01T01:00:00Z", value: "0.100000000000000001" },
      { at: "2026-08-03T01:00:00Z", value: "0.200000000000000001" },
    ];
    const sampled = sampleChart(points, "1m");
    expect(sampled.map((p) => p.value)).toEqual(points.map((p) => p.value));
    expect(sampled).toHaveLength(2);
  });
});
