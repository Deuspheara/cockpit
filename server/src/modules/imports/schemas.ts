import { z } from "zod";
import { decimalString, currency, Decimal } from "../../shared/decimal.js";
const text = z.string().max(1000).nullable().default(null);
const amount = decimalString.nullable().default(null);
export const extractionSchema = z
  .object({
    likelyInstitution: text,
    likelyAccountName: text,
    capturedAt: z.iso.datetime({ offset: true }).nullable().default(null),
    currency: currency.nullable().default(null),
    positions: z
      .array(
        z
          .object({
            symbol: text,
            name: text,
            isin: text,
            quantity: amount,
            unitPrice: amount,
            marketValue: amount,
            averageCost: amount,
            currency: currency.nullable().default(null),
            confidence: z.number().min(0).max(1),
            evidence: text,
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
export function validateExtraction(e: ImportExtraction): string[] {
  const questions = [...e.missingInformation, ...e.ambiguities];
  if (!e.positions.length && !e.transactions.length)
    questions.push(
      "No financial lines were extracted. Add a clearer screenshot.",
    );
  if (e.positions.length && !e.capturedAt)
    questions.push("On what date were these positions observed?");
  const keys = new Set<string>();
  e.positions.forEach((p, index) => {
    const label = p.symbol ?? p.name ?? `Position ${index + 1}`;
    if (!p.symbol) questions.push(`What is the asset symbol for ${label}?`);
    if (p.quantity === null)
      questions.push(`How many units of ${label} are held?`);
    else if (new Decimal(p.quantity).lt(0))
      questions.push(
        `${label}: confirm a nonnegative quantity and position direction.`,
      );
    if (!(p.currency ?? e.currency))
      questions.push(`Which currency applies to ${label}?`);
    if (p.confidence < 0.8)
      questions.push(`Please confirm the low-confidence fields for ${label}.`);
    const key = p.isin ?? p.symbol ?? String(index);
    if (keys.has(key))
      questions.push(`Resolve the conflicting observations for ${label}.`);
    keys.add(key);
    for (const value of [p.unitPrice, p.marketValue, p.averageCost])
      if (value !== null && new Decimal(value).lt(0))
        questions.push(`${label}: confirm the negative financial value.`);
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
      questions.push(
        `Transaction ${index + 1} needs type, asset, timestamp, positive quantity and currency.`,
      );
    if (t.confidence < 0.8)
      questions.push(`Please confirm transaction ${index + 1}.`);
  });
  return [...new Set(questions)];
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
    transactions,
    missingInformation: [
      ...previous.missingInformation,
      ...next.missingInformation,
    ],
    ambiguities: [...previous.ambiguities, ...next.ambiguities],
  });
}
