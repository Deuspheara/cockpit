import type { Range } from "./service.js";
export interface ChartSample {
  at: string;
  value: string;
  source?: string;
}
const HOUR = 3600000,
  DAY = 24 * HOUR;
export function chartInterval(range: Range, points: ChartSample[]) {
  const span =
    points.length > 1
      ? new Date(points.at(-1)!.at).getTime() -
        new Date(points[0]!.at).getTime()
      : 0;
  return {
    "1d": HOUR,
    "1w": 6 * HOUR,
    "3w": DAY,
    "1m": DAY,
    "3m": DAY,
    "1y": 7 * DAY,
    all: span > 365 * DAY ? 30 * DAY : span > 90 * DAY ? 7 * DAY : DAY,
  }[range];
}
// Last actual observation in each UTC time bucket. No averaged money and no invented gap-fill.
// sourceAt retains the observation time; at locates the display bucket on an even time grid.
export function sampleChart<T extends ChartSample>(points: T[], range: Range) {
  const sorted = [...points].sort((a, b) => a.at.localeCompare(b.at));
  const interval = chartInterval(range, sorted),
    buckets = new Map<number, T>();
  for (const point of sorted)
    buckets.set(
      Math.floor(new Date(point.at).getTime() / interval) * interval,
      point,
    );
  return [...buckets.entries()].map(([at, point]) => ({
    ...point,
    sourceAt: point.at,
    at: new Date(at).toISOString(),
  }));
}
