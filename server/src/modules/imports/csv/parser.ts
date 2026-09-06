import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { Decimal, decimalString, money } from "../../../shared/decimal.js";
import { AppError } from "../../../shared/errors.js";
import type { TransactionInput } from "../../ledger/schemas.js";

export const MAX_CSV_BYTES = 10 * 1024 * 1024;
export type Provider = "trade_republic";
export interface ImportIssue {
  row: number;
  severity: "warning" | "error";
  code: string;
  message: string;
  group?: string;
}
export interface Instrument {
  key: string;
  symbol: string;
  name: string;
  assetType: "equity" | "etf" | "crypto" | "other" | "cash";
  currency: string;
  isin?: string;
}
export interface CsvTransaction {
  row: number;
  group: string;
  externalId: string;
  hasExternalId: boolean;
  hash: string;
  type: TransactionInput["type"];
  event: string;
  occurredAt: string;
  instrument: Instrument;
  quantity: string;
  unitPrice: string | null;
  grossAmount: string;
  feeAmount: string;
  taxAmount: string;
  netCashAmount: string;
  currency: string;
  evidence: Record<string, string>;
}
export interface ParsedCsv {
  provider: Provider;
  version: string;
  totalRows: number;
  transactions: CsvTransaction[];
  issues: ImportIssue[];
  groups: string[];
}
export interface CsvInput {
  headers: string[];
  records: { row: number; values: string[] }[];
}
export interface CsvImporter {
  readonly provider: Provider;
  detect(input: CsvInput): boolean;
  parse(input: CsvInput): ParsedCsv;
}
export const digest = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([a], [b]) =>
                a < b ? -1 : a > b ? 1 : 0,
              ),
            )
          : item,
      ),
    )
    .digest("hex");
export const normalizeHeader = (value: string) =>
  value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
const required = [
  "datetime",
  "date",
  "account_type",
  "category",
  "type",
  "asset_class",
  "name",
  "symbol",
  "shares",
  "price",
  "amount",
  "fee",
  "tax",
  "currency",
  "original_amount",
  "original_currency",
  "fx_rate",
  "transaction_id",
];
export function readCsv(bytes: Uint8Array): CsvInput {
  if (!bytes.length)
    throw new AppError(
      "EMPTY_CSV",
      "This CSV doesn't contain any transactions.",
    );
  if (bytes.length > MAX_CSV_BYTES)
    throw new AppError("UPLOAD_LIMIT", "CSV exceeds the 10 MB limit.", 413);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AppError("INVALID_CSV", "Choose a UTF-8 CSV file.");
  }
  if (!text.trim())
    throw new AppError(
      "EMPTY_CSV",
      "This CSV doesn't contain any transactions.",
    );
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
    throw new AppError("INVALID_CSV", "The file is not CSV text.");
  try {
    const records = parse(text, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      max_record_size: 65536,
      info: true,
      to: 50002,
    }) as unknown as { record: string[]; info: { lines: number } }[];
    if (!records.length) throw new Error();
    if (records.length > 50001)
      throw new AppError("ROW_LIMIT", "Choose a CSV with at most 50,000 rows.");
    const headers = records.shift()!.record.map(normalizeHeader);
    if (headers.length > 64 || new Set(headers).size !== headers.length)
      throw new Error();
    return {
      headers,
      records: records.map((r) => ({ row: r.info.lines, values: r.record })),
    };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(
      "INVALID_CSV",
      "The CSV structure is invalid. Check the export and try again.",
    );
  }
}
function fail(code: string, message: string): never {
  throw new AppError(code, message);
}
function decimal(value: string, optional = false) {
  if (!value && optional) return new Decimal(0);
  if (!decimalString.safeParse(value).success)
    fail(
      "INVALID_AMOUNT",
      "An amount is missing or has an unsupported number format.",
    );
  return new Decimal(value);
}
export function validISIN(value: string) {
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(value)) return false;
  const digits = [...value]
    .map((c) => (/\d/.test(c) ? c : String(c.charCodeAt(0) - 55)))
    .join("");
  let sum = 0;
  [...digits].reverse().forEach((c, i) => {
    let n = Number(c) * (i % 2 ? 2 : 1);
    sum += n > 9 ? n - 9 : n;
  });
  return sum % 10 === 0;
}
function timestamp(value: string) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(
    value,
  );
  if (
    !m ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 19) !== `${m[1]}T${m[2]}`
  )
    fail("INVALID_DATE", "Expected a valid UTC ISO timestamp.");
  return `${m[1]}T${m[2]}.${(m[3] ?? "").padEnd(6, "0")}Z`;
}
export class TradeRepublicCsvImporter implements CsvImporter {
  readonly provider = "trade_republic" as const;
  detect(input: CsvInput) {
    return (
      required.every((h) => input.headers.includes(h)) &&
      (!input.records.length ||
        input.records.some(
          (r) =>
            ["DEFAULT", "PEA"].includes(
              r.values[input.headers.indexOf("account_type")]?.trim() ?? "",
            ) &&
            ["CASH", "TRADING"].includes(
              r.values[input.headers.indexOf("category")]?.trim() ?? "",
            ),
        ))
    );
  }
  parse(input: CsvInput): ParsedCsv {
    const result: ParsedCsv = {
      provider: this.provider,
      version: "1",
      totalRows: input.records.length,
      transactions: [],
      issues: [],
      groups: [],
    };
    for (const record of input.records) {
      let group: string | undefined;
      try {
        if (record.values.length !== input.headers.length)
          fail("MALFORMED_ROW", "The row has a different number of columns.");
        const r = Object.fromEntries(
          input.headers.map((h, i) => [h, record.values[i]!.trim()]),
        );
        const accountGroup = r.account_type!;
        if (!["DEFAULT", "PEA"].includes(accountGroup))
          fail("UNKNOWN_ACCOUNT_TYPE", "This account group is not supported.");
        group = accountGroup;
        if (!result.groups.includes(group)) result.groups.push(group);
        const event = r.type!,
          trade = event === "BUY" || event === "SELL";
        const types: Record<string, CsvTransaction["type"]> = {
          BUY: "BUY",
          SELL: "SELL",
          TRANSFER_INBOUND: "DEPOSIT",
          TRANSFER_IN: "TRANSFER_IN",
          TRANSFER_OUT: "TRANSFER_OUT",
          CARD_TRANSACTION: "WITHDRAWAL",
          DIVIDEND: "INCOME",
          INTEREST_PAYMENT: "INCOME",
          PEA_MARKETING: "INCOME",
        };
        const type = types[event];
        if (!type)
          fail(
            event === "TAX_OPTIMIZATION"
              ? "AMBIGUOUS_TAX_EVENT"
              : "UNKNOWN_TRANSACTION_TYPE",
            event === "TAX_OPTIMIZATION"
              ? "Tax adjustment skipped because its cash effect is not established."
              : "This event type is not supported.",
          );
        if (r.category !== (trade ? "TRADING" : "CASH"))
          fail(
            "INVALID_CATEGORY",
            "Event category does not match its transaction type.",
          );
        const occurredAt = timestamp(r.datetime!);
        if (r.date !== occurredAt.slice(0, 10))
          fail("INVALID_DATE", "Date and timestamp disagree.");
        const currency = r.currency!;
        if (!/^[A-Z]{3}$/.test(currency))
          fail(
            "UNSUPPORTED_CURRENCY",
            "Expected a three-letter currency code.",
          );
        const amount = decimal(r.amount!),
          fee = decimal(r.fee!, true),
          tax = decimal(r.tax!, true);
        if (fee.gt(0) || tax.gt(0))
          fail(
            "AMBIGUOUS_CHARGES",
            "Positive fee or tax adjustments require review.",
          );
        const outgoing = ["BUY", "WITHDRAWAL", "TRANSFER_OUT"].includes(type);
        if (outgoing ? amount.gte(0) : amount.lt(0))
          fail("INVALID_AMOUNT", "The amount sign does not match this event.");
        const net = amount.plus(fee).plus(tax);
        if (!trade && (net.isZero() || (!outgoing && net.lt(0))))
          fail(
            "AMBIGUOUS_CASH_EVENT",
            "Zero or reversed cash movement requires review.",
          );
        let instrument: Instrument = {
          key: `cash:${currency}`,
          symbol: currency,
          name: currency,
          assetType: "cash",
          currency,
        };
        let quantity = net.abs(),
          unitPrice: string | null = null;
        const evidence: Record<string, string> = {};
        if (trade) {
          const shares = decimal(r.shares!);
          quantity = shares.abs();
          if (
            quantity.isZero() ||
            (event === "BUY" ? shares.lt(0) : shares.gt(0))
          )
            fail(
              "INVALID_QUANTITY",
              "The shares sign does not match the trade.",
            );
          const price = decimal(r.price!);
          if (price.lt(0)) fail("INVALID_AMOUNT", "Price cannot be negative.");
          if (quantity.mul(price).minus(amount.abs()).abs().gt("0.01"))
            fail(
              "INCONSISTENT_TRADE",
              "Shares, price, and gross amount disagree.",
            );
          if (event === "SELL" && net.lt(0))
            fail("AMBIGUOUS_CHARGES", "Sale charges exceed gross proceeds.");
          unitPrice = money(price);
          const symbol = r.symbol!;
          if (r.asset_class === "CRYPTO" && symbol === "BTC")
            instrument = {
              key: "trade_republic:crypto:BTC",
              symbol,
              name: "Bitcoin",
              assetType: "crypto",
              currency,
            };
          else {
            if (!validISIN(symbol))
              fail(
                "INVALID_ASSET_IDENTIFIER",
                "A valid ISIN is required for this security.",
              );
            const cls: Record<string, Instrument["assetType"]> = {
              STOCK: "equity",
              FUND: "etf",
              DERIVATIVE: "other",
            };
            if (!cls[r.asset_class!])
              fail("UNKNOWN_ASSET_CLASS", "This asset class is not supported.");
            instrument = {
              key: `isin:${symbol}`,
              isin: symbol,
              symbol,
              name: r.name?.slice(0, 150) || symbol,
              assetType: cls[r.asset_class!]!,
              currency,
            };
          }
        } else if (event === "DIVIDEND" && r.symbol) {
          if (!validISIN(r.symbol))
            fail(
              "INVALID_ASSET_IDENTIFIER",
              "Dividend security identifier is invalid.",
            );
          evidence.relatedIsin = r.symbol;
        }
        if (r.original_amount || r.original_currency || r.fx_rate) {
          evidence.originalAmount = money(decimal(r.original_amount!));
          if (!/^[A-Z]{3}$/.test(r.original_currency!))
            fail("UNSUPPORTED_CURRENCY", "Original currency is invalid.");
          const rate = decimal(r.fx_rate!);
          if (rate.lte(0)) fail("INVALID_AMOUNT", "FX rate must be positive.");
          evidence.originalCurrency = r.original_currency!;
          evidence.fxRate = money(rate);
        }
        const financial = {
          group,
          type,
          event,
          occurredAt,
          instrumentKey: instrument.key,
          quantity: money(quantity),
          unitPrice,
          grossAmount: money(amount.abs()),
          feeAmount: money(fee.abs()),
          taxAmount: money(tax.abs()),
          netCashAmount: money(net),
          currency,
          evidence,
        };
        for (const value of [
          financial.quantity,
          financial.unitPrice,
          financial.grossAmount,
          financial.feeAmount,
          financial.taxAmount,
          financial.netCashAmount,
        ]) {
          if (value !== null && !decimalString.safeParse(value).success)
            fail(
              "AMOUNT_OUT_OF_RANGE",
              "The calculated value exceeds the supported decimal range.",
            );
        }
        // Exclude display names and CSV row order. Preserve microseconds in the identity hash.
        const hash = digest(financial),
          external = r.transaction_id!;
        if (external.length > 200)
          fail("INVALID_EXTERNAL_ID", "Transaction identifier is too long.");
        result.transactions.push({
          ...financial,
          row: record.row,
          instrument,
          externalId: external || `fingerprint:${hash}`,
          hasExternalId: !!external,
          hash,
        });
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        result.issues.push({
          row: record.row,
          severity: "warning",
          code: e.code,
          message: e.message,
          ...(group ? { group } : {}),
        });
      }
    }
    return result;
  }
}
const importers: CsvImporter[] = [new TradeRepublicCsvImporter()];
export function parseCsv(bytes: Uint8Array, provider = "auto") {
  const input = readCsv(bytes),
    importer = importers.find(
      (i) =>
        (provider === "auto" || provider === i.provider) && i.detect(input),
    );
  if (!importer)
    throw new AppError(
      "UNSUPPORTED_CSV",
      "We couldn't recognize this CSV. Supported provider: Trade Republic.",
    );
  if (!input.records.length)
    throw new AppError(
      "EMPTY_CSV",
      "This CSV doesn't contain any transactions.",
    );
  return importer.parse(input);
}
