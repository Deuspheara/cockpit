import { randomUUID } from "node:crypto";
import { z } from "zod";
import { decimalString, currency, Decimal } from "../../shared/decimal.js";
const text = z.string().max(1000).nullable().default(null);
const amount = decimalString.nullable().default(null);
export const extractionSchema = z
  .object({
    likelyInstitution: text,
    likelyAccountName: text,
    capturedAt: z.iso.datetime({ offset: true }).nullable().default(null),
    capturedAtInferred: z.boolean().default(false),
    currency: currency.nullable().default(null),
    positions: z
      .array(
        z
          .object({
            candidateId: z.uuid().nullable().default(null),
            symbol: text,
            name: text,
            isin: text,
            quantity: amount,
            unitPrice: amount,
            unitPriceCurrency: currency.nullable().default(null),
            marketValue: amount,
            averageCost: amount,
            performancePercent: amount,
            currency: currency.nullable().default(null),
            confidence: z.number().min(0).max(1),
            evidence: text,
            providerKey: text,
            providerExchange: text,
            matchStatus: z
              .enum(["unmatched", "matched", "ambiguous"])
              .default("unmatched"),
            quantitySource: z
              .enum(["visible", "estimated", "user", "value_only"])
              .default("value_only"),
            sourceLines: z.number().int().min(1).default(1),
            sourceCandidateIds: z.array(z.uuid()).max(50).default([]),
            quotePrice: amount,
            quoteCurrency: currency.nullable().default(null),
            quoteAt: z.iso.datetime({ offset: true }).nullable().default(null),
            fxRate: amount,
          })
          .strict(),
      )
      .max(50)
      .default([]),
    derivatives: z
      .array(
        z
          .object({
            candidateId: z.uuid().nullable().default(null),
            underlyingSymbol: text,
            name: text,
            optionType: z.enum(["call", "put"]).nullable().default(null),
            strike: amount,
            expiration: z.iso.date().nullable().default(null),
            contractSymbol: text,
            quantity: amount,
            marketValue: amount,
            currency: currency.nullable().default(null),
            confidence: z.number().min(0).max(1),
            evidence: text,
            quantitySource: z
              .enum(["visible", "estimated", "user", "value_only"])
              .default("value_only"),
            sourceLines: z.number().int().min(1).default(1),
            sourceCandidateIds: z.array(z.uuid()).max(50).default([]),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    transactions: z
      .array(
        z
          .object({
            type: z
              .enum(["BUY", "SELL", "DEPOSIT", "WITHDRAWAL", "FEE"])
              .nullable()
              .default(null),
            symbol: text,
            name: text,
            occurredAt: z.iso
              .datetime({ offset: true })
              .nullable()
              .default(null),
            quantity: amount,
            unitPrice: amount,
            amount: amount,
            fee: amount,
            currency: currency.nullable().default(null),
            confidence: z.number().min(0).max(1),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    missingInformation: z.array(z.string().max(500)).max(30).default([]),
    ambiguities: z.array(z.string().max(500)).max(30).default([]),
  })
  .strict();
export type ImportExtraction = z.infer<typeof extractionSchema>;
// Recover explicit option labels if vision placed them in the stock list.
// Unknown underlying/expiry stay unknown; never price an option using its stock.
export function classifyDerivativeRows(e: ImportExtraction): ImportExtraction {
  const positions: ImportExtraction["positions"] = [];
  const derivatives = [...e.derivatives];
  for (const p of e.positions) {
    const label = [p.name, p.symbol].filter(Boolean).join(" ");
    const type = /\b(put|call)\b/i.exec(label)?.[1]?.toLowerCase();
    if (!type || /\b(etf|fund)\b/i.test(label)) {
      positions.push(p);
      continue;
    }
    const strike =
      /\b(?:put|call)\s+(\d+(?:[.,]\d+)?)(?=\s|$)/i
        .exec(label)?.[1]
        ?.replace(",", ".") ?? null;
    const dateText = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(label)?.[1];
    const expiration = z.iso.date().safeParse(dateText).success
      ? dateText!
      : null;
    derivatives.push(
      extractionSchema.parse({
        derivatives: [
          {
            candidateId: p.candidateId,
            name: p.name ?? p.symbol,
            optionType: type,
            underlyingSymbol:
              p.symbol &&
              /^[A-Z][A-Z0-9.]{0,11}$/.test(p.symbol) &&
              !/^(PUT|CALL)$/.test(p.symbol) &&
              !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(p.symbol)
                ? p.symbol
                : null,
            strike,
            expiration,
            quantity: p.quantity,
            marketValue: p.marketValue,
            currency: p.currency ?? e.currency,
            confidence: p.confidence,
            evidence: p.evidence,
            quantitySource: p.quantitySource,
            sourceLines: p.sourceLines,
            sourceCandidateIds: p.sourceCandidateIds,
          },
        ],
      }).derivatives[0]!,
    );
  }
  return { ...e, positions, derivatives };
}
export function normalizeExtraction(e: ImportExtraction): ImportExtraction {
  e = classifyDerivativeRows(e);
  return extractionSchema.parse({
    ...e,
    positions: e.positions.map((position) => {
      const candidateId = position.candidateId ?? randomUUID();
      return {
        ...position,
        candidateId,
        sourceCandidateIds: position.sourceCandidateIds.length
          ? position.sourceCandidateIds
          : [candidateId],
        quantitySource:
          position.quantitySource === "value_only" && position.quantity !== null
            ? "visible"
            : position.quantitySource,
      };
    }),
    derivatives: e.derivatives.map((derivative) => {
      const candidateId = derivative.candidateId ?? randomUUID();
      return {
        ...derivative,
        candidateId,
        sourceCandidateIds: derivative.sourceCandidateIds.length
          ? derivative.sourceCandidateIds
          : [candidateId],
        quantitySource:
          derivative.quantitySource === "value_only" &&
          derivative.quantity !== null
            ? "visible"
            : derivative.quantitySource,
      };
    }),
  });
}
export function extractionBlockers(e: ImportExtraction): string[] {
  const blockers: string[] = [];
  if (!e.positions.length && !e.transactions.length && !e.derivatives.length)
    blockers.push(
      "No financial lines were extracted. Add a clearer screenshot.",
    );
  const keys = new Set<string>();
  e.positions.forEach((p, index) => {
    const label = p.symbol ?? p.name ?? `Position ${index + 1}`;
    if (!p.symbol) blockers.push(`Choose the exact instrument for ${label}.`);
    if (p.matchStatus === "ambiguous")
      blockers.push(`Choose the exact instrument for ${label}.`);
    if (p.quantity === null && p.marketValue === null)
      blockers.push(`${label} needs a quantity or market value.`);
    else if (p.quantity !== null && new Decimal(p.quantity).lt(0))
      blockers.push(
        `${label}: confirm a nonnegative quantity and position direction.`,
      );
    if (!(p.currency ?? e.currency))
      blockers.push(`Choose the currency for ${label}.`);
    const key = p.isin ?? p.symbol ?? String(index);
    if (keys.has(key))
      blockers.push(`Resolve the conflicting observations for ${label}.`);
    keys.add(key);
    for (const value of [p.unitPrice, p.marketValue, p.averageCost])
      if (value !== null && new Decimal(value).lt(0))
        blockers.push(`${label}: confirm the negative financial value.`);
  });
  e.derivatives.forEach((d, index) => {
    const label = d.name ?? `Derivative ${index + 1}`;
    if (!d.underlyingSymbol || !d.optionType || !d.strike || !d.expiration)
      blockers.push(
        `${label} needs its underlying, type, strike, and expiration.`,
      );
    if (!d.currency) blockers.push(`Choose the currency for ${label}.`);
    if (d.quantity === null && d.marketValue === null)
      blockers.push(`${label} needs a quantity or market value.`);
    if (d.strike !== null && new Decimal(d.strike).lte(0))
      blockers.push(`${label} needs a positive strike.`);
    if (d.quantity !== null && new Decimal(d.quantity).lt(0))
      blockers.push(`${label} needs a nonnegative contract quantity.`);
    if (d.marketValue !== null && new Decimal(d.marketValue).lt(0))
      blockers.push(`${label}: confirm the negative market value.`);
  });
  e.transactions.forEach((t, index) => {
    if (
      !t.type ||
      !t.symbol ||
      !t.occurredAt ||
      !t.quantity ||
      !(t.currency ?? e.currency) ||
      new Decimal(t.quantity ?? 0).lte(0)
    )
      blockers.push(
        `Transaction ${index + 1} needs type, asset, timestamp, positive quantity and currency.`,
      );
  });
  return [...new Set(blockers)];
}
export function extractionWarnings(e: ImportExtraction): string[] {
  const warnings: string[] = [];
  if (e.missingInformation.length)
    warnings.push(
      `${e.missingInformation.length} field${e.missingInformation.length === 1 ? " was" : "s were"} not visible; review the highlighted rows.`,
    );
  if (e.ambiguities.length)
    warnings.push(
      `${e.ambiguities.length} possible conflict${e.ambiguities.length === 1 ? " was" : "s were"} found; review the summary before applying.`,
    );
  if (e.capturedAtInferred)
    warnings.push("Observation date was inferred from the upload date.");
  let estimated = 0;
  let valueOnly = 0;
  let unmatched = 0;
  let lowConfidence = 0;
  for (const p of e.positions) {
    if (p.quantitySource === "estimated") estimated++;
    if (p.quantitySource === "value_only") valueOnly++;
    if (p.matchStatus === "unmatched" && p.symbol) unmatched++;
    if (p.confidence < 0.8) lowConfidence++;
  }
  for (const d of e.derivatives) {
    if (d.quantitySource === "value_only") valueOnly++;
    if (d.confidence < 0.8) lowConfidence++;
  }
  if (estimated)
    warnings.push(
      `${estimated} ${estimated === 1 ? "quantity was" : "quantities were"} estimated from eligible dated prices.`,
    );
  if (valueOnly)
    warnings.push(
      `${valueOnly} ${valueOnly === 1 ? "position has" : "positions have"} an unknown quantity; visible market values will still be recorded.`,
    );
  if (unmatched)
    warnings.push(
      `${unmatched} instrument ${unmatched === 1 ? "match needs" : "matches need"} verification because EODHD market data was unavailable or inconclusive.`,
    );
  if (lowConfidence)
    warnings.push(
      `${lowConfidence} ${lowConfidence === 1 ? "row has" : "rows have"} low extraction confidence.`,
    );
  return [...new Set(warnings)];
}
export function validateExtraction(e: ImportExtraction): string[] {
  return extractionBlockers(e);
}
export function mergeExtractions(
  previous: ImportExtraction,
  next: ImportExtraction,
): ImportExtraction {
  const positions = previous.positions.map((p) => ({ ...p }));
  if (
    previous.capturedAt &&
    next.capturedAt &&
    previous.capturedAt !== next.capturedAt
  )
    next.ambiguities.push(
      "Screenshots have different observation dates. Confirm which date and holdings should be imported.",
    );
  for (const candidate of next.positions) {
    const existing = positions.find(
      (p) =>
        (p.isin ?? p.symbol) === (candidate.isin ?? candidate.symbol) &&
        p.quantity === candidate.quantity &&
        p.currency === candidate.currency,
    );
    if (!existing) positions.push(candidate);
    else
      for (const key of [
        "unitPrice",
        "marketValue",
        "averageCost",
        "name",
        "isin",
      ] as const) {
        if (existing[key] === null) existing[key] = candidate[key];
        else if (candidate[key] !== null && candidate[key] !== existing[key])
          next.ambiguities.push(`Conflicting ${key} for ${candidate.symbol}`);
      }
  }
  const transactions = [...previous.transactions];
  for (const t of next.transactions)
    if (!transactions.some((old) => JSON.stringify(old) === JSON.stringify(t)))
      transactions.push(t);
  return extractionSchema.parse({
    ...next,
    likelyAccountName: next.likelyAccountName ?? previous.likelyAccountName,
    likelyInstitution: next.likelyInstitution ?? previous.likelyInstitution,
    capturedAt: next.capturedAt ?? previous.capturedAt,
    currency: next.currency ?? previous.currency,
    positions,
    derivatives: [...previous.derivatives, ...next.derivatives],
    transactions,
    missingInformation: [
      ...previous.missingInformation,
      ...next.missingInformation,
    ],
    ambiguities: [...previous.ambiguities, ...next.ambiguities],
  });
}
