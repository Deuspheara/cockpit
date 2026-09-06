import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  digest,
  parseCsv,
  readCsv,
  TradeRepublicCsvImporter,
  normalizeHeader,
  validISIN,
} from "../src/modules/imports/csv/parser.js";
const fixture = readFileSync(
  new URL("./fixtures/trade-republic.csv", import.meta.url),
);
const parsed = () => parseCsv(fixture);
function row(patch: Record<string, string>) {
  const input = readCsv(fixture),
    r = input.records.find(
      (r) => r.values[input.headers.indexOf("type")] === "BUY",
    )!;
  const values = [...r.values];
  for (const [key, value] of Object.entries(patch))
    values[input.headers.indexOf(key)] = value;
  return new TradeRepublicCsvImporter().parse({
    headers: input.headers,
    records: [{ row: 2, values }],
  });
}
describe("Trade Republic CSV", () => {
  it("uses the supplied schema and separates the two accounts", () => {
    const p = parsed();
    expect(p.totalRows).toBe(18);
    expect(p.groups.sort()).toEqual(["DEFAULT", "PEA"]);
    expect(p.transactions.length).toBe(15);
    expect(new Set(p.transactions.map((t) => t.event))).toEqual(
      new Set([
        "BUY",
        "SELL",
        "TRANSFER_INBOUND",
        "TRANSFER_IN",
        "TRANSFER_OUT",
        "CARD_TRANSACTION",
        "DIVIDEND",
        "INTEREST_PAYMENT",
        "PEA_MARKETING",
      ]),
    );
    expect(
      p.issues.filter((i) => i.code === "AMBIGUOUS_TAX_EVENT"),
    ).toHaveLength(2);
  });
  it("handles BOM, header whitespace, CRLF, quoted commas and embedded newlines", () => {
    const input = readCsv(
      Buffer.from(
        "\ufeff" + fixture.toString().replace("datetime,", "  DATETIME  ,"),
      ),
    );
    expect(input.headers[0]).toBe("datetime");
    expect(
      parseCsv(Buffer.from("\ufeff" + fixture.toString())).transactions,
    ).toEqual(parsed().transactions);
    expect(
      readCsv(Buffer.from('a,b\r\n"one,two","three\nfour"\r\n')).records[0]!
        .values,
    ).toEqual(["one,two", "three\nfour"]);
    expect(normalizeHeader(" \ufeff Transaction   ID ")).toBe("transaction id");
  });
  it("does not turn dividend shares into holdings", () => {
    for (const t of parsed().transactions.filter(
      (t) => t.event === "DIVIDEND",
    )) {
      expect(t.instrument.assetType).toBe("cash");
      expect(t.type).toBe("INCOME");
      expect(t.evidence.relatedIsin).toBeTruthy();
    }
  });
  it("normalizes sale quantities and signed charges", () => {
    for (const t of parsed().transactions.filter((t) => t.event === "SELL"))
      expect(t.quantity.startsWith("-")).toBe(false);
    const t = row({
      shares: "2",
      price: "10",
      amount: "-20",
      fee: "-1",
      tax: "-2",
    }).transactions[0]!;
    expect(t.quantity).toBe("2.000000000000000000");
    expect(t.netCashAmount).toBe("-23.000000000000000000");
    expect(t.taxAmount).toBe("2.000000000000000000");
  });
  it.each([
    [{ amount: "1,50" }, "INVALID_AMOUNT"],
    [{ datetime: "2026-02-30T00:00:00Z" }, "INVALID_DATE"],
    [{ type: "FUTURE_EVENT" }, "UNKNOWN_TRANSACTION_TYPE"],
    [{ symbol: "Apple" }, "INVALID_ASSET_IDENTIFIER"],
    [{ shares: "" }, "INVALID_AMOUNT"],
    [{ fee: "1" }, "AMBIGUOUS_CHARGES"],
    [{ currency: "=EUR" }, "UNSUPPORTED_CURRENCY"],
  ] as [Record<string, string>, string][])(
    "reports stable row issues",
    (patch, code) => {
      expect(row(patch).issues[0]!.code).toBe(code);
      expect(row(patch).transactions).toHaveLength(0);
    },
  );
  it("fingerprints absent IDs and ignores cosmetic names", () => {
    const a = row({ transaction_id: "" }),
      b = row({ transaction_id: "", name: "=plain data" });
    expect(a.transactions[0]!.externalId).toMatch(/^fingerprint:/);
    expect(a.transactions[0]!.hash).toBe(b.transactions[0]!.hash);
  });
  it("preserves microseconds in financial identity", () => {
    const a = row({
        datetime: "2026-01-01T00:00:00.000001Z",
        date: "2026-01-01",
      }),
      b = row({ datetime: "2026-01-01T00:00:00.000002Z", date: "2026-01-01" });
    expect(a.transactions[0]!.hash).not.toBe(b.transactions[0]!.hash);
  });
  it("rejects unsupported, empty, binary, broken quoting and oversized files", () => {
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from("foo,bar\n1,2"),
      Buffer.from("\0bad"),
      Buffer.from('a,b\n"broken'),
      Buffer.alloc(10 * 1024 * 1024 + 1),
    ])
      expect(() => parseCsv(bytes)).toThrow();
  });
  it("hashes financial objects independently of property order", () => {
    expect(digest({ a: "1", b: { x: "2", y: "3" } })).toBe(
      digest({ b: { y: "3", x: "2" }, a: "1" }),
    );
  });
  it("reports whitespace-only files as empty", () => {
    expect(() => parseCsv(Buffer.from(" \r\n"))).toThrow(
      "doesn't contain any transactions",
    );
  });
  it("validates ISIN checksums", () => {
    expect(validISIN("US0378331005")).toBe(true);
    expect(validISIN("US0378331006")).toBe(false);
  });
});
