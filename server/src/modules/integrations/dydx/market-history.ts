import { sampleChart } from "../../portfolio/sampling.js";
import { z } from "zod";
import { providerJSON, type Fetch } from "../http.js";
import { providerDecimal } from "../types.js";
import type { Range } from "../../portfolio/service.js";
const candles = z.object({
  candles: z.array(
    z.object({
      startedAt: z.iso.datetime({ offset: true }),
      close: providerDecimal,
    }),
  ),
});
export async function marketHistory(
  ticker: string,
  range: Range,
  transport: Fetch = fetch,
) {
  z.string()
    .regex(/^[A-Z0-9.-]+-USD$/)
    .parse(ticker);
  const days = {
    "1d": 1,
    "1w": 7,
    "3w": 21,
    "1m": 30,
    "3m": 90,
    "1y": 365,
    all: 1000,
  }[range];
  const resolution = days <= 7 ? "1HOUR" : "1DAY";
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const points = new Map<string, { at: string; value: string }>();
  let before = new Date().toISOString(),
    limited = false;
  for (let page = 0; page < 11; page++) {
    const response = candles.parse(
      await providerJSON(
        `https://indexer.dydx.trade/v4/candles/perpetualMarkets/${encodeURIComponent(ticker)}?resolution=${resolution}&limit=100&fromISO=${encodeURIComponent(since)}&toISO=${encodeURIComponent(before)}`,
        undefined,
        transport,
      ),
    );
    for (const c of response.candles)
      points.set(c.startedAt, { at: c.startedAt, value: c.close });
    const oldest = response.candles.map((c) => c.startedAt).sort()[0];
    if (response.candles.length < 100 || !oldest || oldest <= since) break;
    const next = new Date(new Date(oldest).getTime() - 1).toISOString();
    if (next >= before) {
      limited = true;
      break;
    }
    before = next;
    if (page === 10) limited = true;
  }
  return {
    ticker,
    currency: "USD",
    source: "dydx_candle_close",
    resolution,
    limited,
    chart: sampleChart([...points.values()], range),
  };
}
