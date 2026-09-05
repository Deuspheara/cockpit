import type { Database } from "../../db/index.js";
import { Decimal, money, positiveDecimal } from "../../shared/decimal.js";
import { AppError } from "../../shared/errors.js";
export function parseECB(xml: string) {
  const date = xml.match(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/i)?.[1];
  if (!date)
    throw new AppError("PROVIDER_ERROR", "Invalid ECB reference date", 502);
  const quotes = [
    ...xml.matchAll(
      /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g,
    ),
  ].map((m) => ({ currency: m[1]!, rate: positiveDecimal.parse(m[2]) }));
  if (!quotes.some((q) => q.currency === "USD"))
    throw new AppError(
      "PROVIDER_ERROR",
      "ECB USD reference quote unavailable",
      502,
    );
  return { date, quotes };
}
export function parseECBHistory(xml: string) {
  const days = [
    ...xml.matchAll(
      /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]>([\s\S]*?)<\/Cube>/g,
    ),
  ].map((match) => parseECB(`<Cube time='${match[1]}'>${match[2]}</Cube>`));
  if (!days.length)
    throw new AppError(
      "PROVIDER_ERROR",
      "ECB historical rates unavailable",
      502,
    );
  return days;
}
export class FXService {
  constructor(
    private database: Database,
    private transport: typeof fetch = fetch,
  ) {}
  async refresh() {
    const response = await this.transport(
      "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
      { signal: AbortSignal.timeout(15000), redirect: "error" },
    );
    if (!response.ok)
      throw new AppError(
        "PROVIDER_ERROR",
        "ECB reference rates unavailable",
        502,
      );
    const { date, quotes } = parseECB(await response.text());
    await this.database.sql.begin(async (tx) => {
      for (const q of quotes) {
        await tx`INSERT INTO fx_quotes(base_currency,quote_currency,rate,quoted_at,source) VALUES('EUR',${q.currency},${q.rate},${date}::date,'ecb') ON CONFLICT DO NOTHING`;
        await tx`INSERT INTO fx_quotes(base_currency,quote_currency,rate,quoted_at,source) VALUES(${q.currency},'EUR',${money(new Decimal(1).div(q.rate))},${date}::date,'ecb') ON CONFLICT DO NOTHING`;
      }
    });
    await this.refreshHistory();
    return { quotedAt: date, source: "ecb" };
  }
  async refreshHistory() {
    const response = await this.transport(
      "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml",
      { signal: AbortSignal.timeout(20000), redirect: "error" },
    );
    if (!response.ok)
      throw new AppError(
        "PROVIDER_ERROR",
        "ECB historical rates unavailable",
        502,
      );
    const days = parseECBHistory(await response.text());
    const rows = days.flatMap((day) => {
      const usd = day.quotes.find((q) => q.currency === "USD")!;
      return [
        {
          base_currency: "USD",
          quote_currency: "EUR",
          rate: money(new Decimal(1).div(usd.rate)),
          quoted_at: day.date,
          source: "ecb",
        },
        {
          base_currency: "EUR",
          quote_currency: "USD",
          rate: usd.rate,
          quoted_at: day.date,
          source: "ecb",
        },
      ];
    });
    await this.database.sql.begin(async (tx) => {
      for (let offset = 0; offset < rows.length; offset += 500)
        await tx`INSERT INTO fx_quotes ${tx(rows.slice(offset, offset + 500))} ON CONFLICT DO NOTHING`;
    });
    return { days: days.length };
  }
}
