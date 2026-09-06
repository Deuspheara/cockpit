import { ReconciliationService } from "../../reconciliation/service.js";
import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql, JSONValue } from "postgres";
import type { Database } from "../../../db/index.js";
import {
  AppError,
  NotFoundError,
  ConflictError,
} from "../../../shared/errors.js";
import { PortfolioService } from "../../portfolio/service.js";
import {
  parseCsv,
  type ParsedCsv,
  type CsvTransaction,
  type ImportIssue,
  type Instrument,
} from "./parser.js";

type SQL = Sql | TransactionSql;
export interface Destination {
  group: string;
  accountId: string | null;
  name: string;
  included: boolean;
}
interface Stage {
  parsed: ParsedCsv;
  destinations: Destination[];
  explicitDestinations?: boolean;
}
interface Counts {
  rows: number;
  new: number;
  duplicates: number;
  conflicts: number;
  skipped: number;
  warnings: number;
}
interface Preview {
  summary: Counts;
  destinations: (Destination & { summary: Counts })[];
  issues: ImportIssue[];
  categories: Record<string, number>;
  assets: number;
  candidates: { id: string; name: string; group: string | null }[];
}
interface Batch {
  id: string;
  creatorTokenId: string;
  provider: string;
  filename: string;
  status: string;
  revision: number;
  staged: Stage | null;
  preview: Preview;
  result: Result | null;
  expiresAt: Date;
  createdAt: Date;
  completedAt: Date | null;
}
interface Result {
  imported: number;
  duplicates: number;
  skipped: number;
  conflicts: number;
  positionsUpdated: number;
  completedAt: string;
  accounts: {
    id: string;
    name: string;
    imported: number;
    duplicates: number;
  }[];
}
interface AssetRow {
  id: string;
  symbol: string;
  assetType: string;
  quoteCurrency: string;
  externalIds: Record<string, string>;
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as JSONValue;
const empty = (): Counts => ({
  rows: 0,
  new: 0,
  duplicates: 0,
  conflicts: 0,
  skipped: 0,
  warnings: 0,
});
const label = (group: string) =>
  group === "PEA" ? "Trade Republic PEA" : "Trade Republic";
export async function expireCsvImports(sql: SQL) {
  await sql`UPDATE csv_import_batches SET status='expired',staged=NULL WHERE status='preview' AND expires_at<=now()`;
}
export class CsvImportService {
  constructor(private database: Database) {}
  private async accounts(sql: SQL) {
    return sql<
      {
        id: string;
        name: string;
        provider: string | null;
        providerAccountKey: string | null;
        sourceType: string;
        isArchived: boolean;
      }[]
    >`SELECT id,name,provider,provider_account_key,source_type,is_archived FROM accounts WHERE NOT is_archived AND source_type='manual'`;
  }
  private async validateDestinations(sql: SQL, destinations: Destination[]) {
    const accounts = await this.accounts(sql),
      used = new Set<string>();
    for (const d of destinations.filter((d) => d.included))
      if (d.accountId) {
        const a = accounts.find((a) => a.id === d.accountId);
        if (
          !a ||
          (a.provider && a.provider !== "trade_republic") ||
          (a.providerAccountKey && a.providerAccountKey !== d.group)
        )
          throw new ConflictError(
            "Choose an active compatible manual account.",
          );
        if (used.has(a.id))
          throw new ConflictError(
            "Each account group needs a separate destination.",
          );
        used.add(a.id);
        d.name = a.name;
      }
    return accounts;
  }
  async create(
    owner: string,
    filename: string,
    bytes: Uint8Array,
    provider: string,
    target?: string,
  ) {
    const parsed = parseCsv(bytes, provider),
      accounts = await this.accounts(this.database.sql);
    const destinations = parsed.groups.map((group) => {
      const matches = accounts.filter(
        (a) =>
          a.provider === "trade_republic" && a.providerAccountKey === group,
      );
      const selected = target
        ? accounts.find(
            (a) => a.id === target && a.providerAccountKey === group,
          )
        : undefined;
      return {
        group,
        accountId:
          selected?.id ?? (matches.length === 1 ? matches[0]!.id : null),
        name: label(group),
        included: true,
      };
    });
    if (target && !destinations.some((d) => d.accountId === target))
      throw new ConflictError(
        "The selected account does not match this export.",
      );
    // Ambiguous destination matches require a deliberate mapping before confirmation.
    for (const d of destinations)
      if (
        !d.accountId &&
        accounts.filter(
          (a) =>
            a.provider === "trade_republic" && a.providerAccountKey === d.group,
        ).length > 1
      )
        d.included = false;
    const staged = { parsed, destinations };
    const { preview } = await this.review(this.database.sql, staged);
    const [batch] = await this.database.sql<
      Batch[]
    >`INSERT INTO csv_import_batches(creator_token_id,provider,filename,parser_version,staged,preview) VALUES(${owner},${parsed.provider},${filename},${parsed.version},${this.database.sql.json(json(staged))},${this.database.sql.json(json(preview))}) RETURNING *`;
    return this.present(batch!);
  }
  private present(b: Batch) {
    return {
      id: b.id,
      provider: b.provider,
      filename: b.filename,
      status: b.status,
      revision: b.revision,
      createdAt: b.createdAt,
      expiresAt: b.expiresAt,
      ...b.preview,
      result: b.result,
    };
  }
  private async load(sql: SQL, id: string, owner: string, lock = false) {
    const rows = lock
      ? await sql<
          Batch[]
        >`SELECT * FROM csv_import_batches WHERE id=${id} AND creator_token_id=${owner} FOR UPDATE`
      : await sql<
          Batch[]
        >`SELECT * FROM csv_import_batches WHERE id=${id} AND creator_token_id=${owner}`;
    if (!rows[0]) throw new NotFoundError("Import not found");
    return rows[0];
  }
  async get(id: string, owner: string) {
    await expireCsvImports(this.database.sql);
    return this.present(await this.load(this.database.sql, id, owner));
  }
  async update(
    id: string,
    owner: string,
    revision: number,
    destinations: Destination[],
  ) {
    return this.database.sql.begin(async (tx) => {
      const batch = await this.load(tx, id, owner, true);
      this.requirePreview(batch, revision);
      if (
        destinations.length !== batch.staged!.destinations.length ||
        new Set(destinations.map((d) => d.group)).size !==
          destinations.length ||
        destinations.some((d) => !batch.staged!.parsed.groups.includes(d.group))
      )
        throw new AppError(
          "INVALID_DESTINATIONS",
          "Provide one destination for each detected group.",
        );
      batch.staged!.destinations = destinations;
      batch.staged!.explicitDestinations = true;
      const { preview } = await this.review(tx, batch.staged!);
      const [updated] = await tx<
        Batch[]
      >`UPDATE csv_import_batches SET staged=${tx.json(json(batch.staged))},preview=${tx.json(json(preview))},revision=revision+1 WHERE id=${id} RETURNING *`;
      return this.present(updated!);
    });
  }
  private requirePreview(b: Batch, revision: number) {
    if (
      b.status !== "preview" ||
      !b.staged ||
      b.expiresAt.getTime() <= Date.now()
    )
      throw new AppError(
        "IMPORT_EXPIRED",
        "This preview is no longer available. Choose the CSV again.",
        410,
      );
    if (b.revision !== revision)
      throw new ConflictError(
        "The preview changed. Review it before importing.",
      );
  }
  private matches(asset: AssetRow, instrument: Instrument) {
    return instrument.isin
      ? asset.externalIds.isin === instrument.isin ||
          asset.symbol === instrument.isin
      : instrument.assetType === "cash"
        ? asset.assetType === "cash" &&
          asset.quoteCurrency === instrument.currency
        : asset.externalIds.tradeRepublic === instrument.key;
  }
  private async review(sql: SQL, stage: Stage) {
    const accounts = await this.validateDestinations(sql, stage.destinations);
    const assets = await sql<
      AssetRow[]
    >`SELECT id,symbol,asset_type,quote_currency,external_ids FROM assets`;
    const targets = stage.destinations.filter((d) => d.included),
      ids = targets.flatMap((d) => (d.accountId ? [d.accountId] : []));
    const existing = ids.length
      ? await sql<
          {
            accountId: string;
            externalId: string;
            contentHash: string | null;
          }[]
        >`SELECT account_id,external_id,content_hash FROM transactions WHERE provider='trade_republic' AND account_id IN ${sql(ids)}`
      : [];
    const persisted = new Map(
      existing.map((e) => [`${e.accountId}:${e.externalId}`, e.contentHash]),
    );
    const seen = new Map<string, string>();
    const accepted: CsvTransaction[] = [];
    const issues = [...stage.parsed.issues];
    const groups = new Map(
      stage.destinations.map((d) => [d.group, { ...d, summary: empty() }]),
    );
    const categories: Record<string, number> = {};
    const instrumentCurrencies = new Map<string, string>();
    for (const t of stage.parsed.transactions.filter((t) =>
      targets.some((d) => d.group === t.group),
    )) {
      const prior = instrumentCurrencies.get(t.instrument.key);
      instrumentCurrencies.set(
        t.instrument.key,
        prior && prior !== t.currency ? "mixed" : t.currency,
      );
    }
    for (const issue of issues) {
      const g = groups.get(issue.group ?? "");
      if (g) {
        g.summary.rows++;
        g.summary.skipped++;
        g.summary.warnings++;
      }
    }
    const within = new Map<string, Set<string>>();
    for (const t of stage.parsed.transactions) {
      const k = `${t.group}:${t.externalId}`;
      const hashes = within.get(k) ?? new Set<string>();
      hashes.add(t.hash);
      within.set(k, hashes);
    }
    for (const t of stage.parsed.transactions) {
      const g = groups.get(t.group)!;
      g.summary.rows++;
      if (!g.included) continue;
      const issue = (code: string, message: string) => {
        issues.push({
          row: t.row,
          group: t.group,
          severity: "warning",
          code,
          message,
        });
        g.summary.warnings++;
      };
      if (within.get(`${t.group}:${t.externalId}`)!.size > 1) {
        g.summary.conflicts++;
        issue(
          "TRANSACTION_CONFLICT",
          "This file repeats an identifier with different financial values.",
        );
        continue;
      }
      const key = `${g.accountId ?? t.group}:${t.externalId}`,
        prior = persisted.get(key) ?? seen.get(key);
      if (persisted.has(key) || seen.has(key)) {
        if (prior === t.hash) {
          g.summary.duplicates++;
          if (!t.hasExternalId)
            issue(
              "INDISTINGUISHABLE_ROW",
              "An identical row without an identifier was ignored.",
            );
        } else {
          g.summary.conflicts++;
          issue(
            "TRANSACTION_CONFLICT",
            "An existing transaction with this identifier has different financial values.",
          );
        }
        continue;
      }
      if (assets.filter((a) => this.matches(a, t.instrument)).length > 1) {
        g.summary.skipped++;
        issue(
          "AMBIGUOUS_ASSET",
          "Multiple stored assets match this instrument. Resolve the duplicate assets before importing this row.",
        );
        continue;
      }
      const existingAsset = assets.find((a) => this.matches(a, t.instrument));
      const assetCurrency =
        existingAsset?.quoteCurrency ??
        instrumentCurrencies.get(t.instrument.key) ??
        t.currency;
      if (assetCurrency !== t.currency) {
        g.summary.skipped++;
        issue(
          "ASSET_CURRENCY_MISMATCH",
          "This instrument uses a different accounting currency. Currency conversion must be resolved before importing this row.",
        );
        continue;
      }
      instrumentCurrencies.set(t.instrument.key, t.currency);
      seen.set(key, t.hash);
      g.summary.new++;
      accepted.push(t);
      categories[t.event] = (categories[t.event] ?? 0) + 1;
    }
    const summary = empty();
    for (const g of groups.values())
      if (g.included)
        for (const key of Object.keys(summary) as (keyof Counts)[])
          summary[key] += g.summary[key];
    const ungrouped = issues.filter((i) => !groups.has(i.group ?? ""));
    summary.rows += ungrouped.length;
    summary.skipped += ungrouped.length;
    summary.warnings += ungrouped.length;
    const preview: Preview = {
      summary,
      destinations: [...groups.values()],
      issues,
      categories,
      assets: new Set(
        accepted
          .filter((t) => t.instrument.assetType !== "cash")
          .map((t) => t.instrument.key),
      ).size,
      candidates: accounts
        .filter((a) => !a.provider || a.provider === "trade_republic")
        .map((a) => ({ id: a.id, name: a.name, group: a.providerAccountKey })),
    };
    return { preview, accepted, assets };
  }
  async confirm(id: string, owner: string, revision: number) {
    const response = await this.database.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(64023002)`;
      const b = await this.load(tx, id, owner, true);
      if (b.result) return this.present(b);
      this.requirePreview(b, revision);
      const stage = b.staged!;
      // Another confirmed preview may have created the default account in the meantime.
      const accounts = await this.accounts(tx);
      for (const d of stage.destinations.filter(
        (d) => d.included && !d.accountId && !stage.explicitDestinations,
      )) {
        const matches = accounts.filter(
          (a) =>
            a.provider === "trade_republic" && a.providerAccountKey === d.group,
        );
        if (matches.length === 1) d.accountId = matches[0]!.id;
        else if (matches.length > 1)
          throw new ConflictError(
            "Choose the destination account before importing.",
          );
      }
      const { preview, accepted, assets } = await this.review(tx, stage);
      const oldIssues = b.preview.issues
        .map((i) => `${i.row}:${i.code}`)
        .sort()
        .join(",");
      const newIssues = preview.issues
        .map((i) => `${i.row}:${i.code}`)
        .sort()
        .join(",");
      if (oldIssues !== newIssues) {
        const [updated] = await tx<
          Batch[]
        >`UPDATE csv_import_batches SET staged=${tx.json(json(stage))},preview=${tx.json(json(preview))},revision=revision+1 WHERE id=${id} RETURNING *`;
        return this.present(updated!);
      }
      if (!stage.destinations.some((d) => d.included))
        throw new AppError(
          "NO_DESTINATION",
          "Select at least one account to import.",
        );
      const beforePositions = await new PortfolioService({
        sql: tx,
      }).positions();
      const result: Result = {
        imported: accepted.length,
        duplicates: preview.summary.duplicates,
        skipped: preview.summary.skipped,
        conflicts: preview.summary.conflicts,
        positionsUpdated: 0,
        completedAt: new Date().toISOString(),
        accounts: [],
      };
      const assetIds = new Map<string, string>();
      const instruments = new Map(
        accepted.map((t) => [t.instrument.key, t.instrument]),
      );
      // Cash exists even if the entire history consists of security trades.
      for (const t of accepted)
        instruments.set(`cash:${t.currency}`, {
          key: `cash:${t.currency}`,
          symbol: t.currency,
          name: t.currency,
          assetType: "cash",
          currency: t.currency,
        });
      for (const [key, instrument] of instruments) {
        const matches = assets.filter((a) => this.matches(a, instrument));
        if (matches.length > 1)
          throw new ConflictError(
            "Multiple cash assets match this currency. Resolve them before importing.",
          );
        if (matches[0]) {
          assetIds.set(key, matches[0].id);
          continue;
        }
        const assetId = randomUUID();
        await tx`INSERT INTO assets(id,asset_type,symbol,name,quote_currency,external_ids) VALUES(${assetId},${instrument.assetType},${instrument.symbol},${instrument.name},${instrument.currency},${tx.json(instrument.isin ? { isin: instrument.isin } : instrument.assetType === "crypto" ? { tradeRepublic: instrument.key } : {})})`;
        assetIds.set(key, assetId);
      }
      const rows: Record<string, unknown>[] = [];
      for (const d of stage.destinations.filter((d) => d.included)) {
        const entries = accepted.filter((t) => t.group === d.group),
          count = preview.destinations.find(
            (g) => g.group === d.group,
          )!.summary;
        if (!d.accountId && !entries.length) continue;
        if (!d.accountId) {
          d.accountId = randomUUID();
          await tx`INSERT INTO accounts(id,name,asset_class,source_type,institution,base_currency,provider,connection_type,provider_account_key) VALUES(${d.accountId},${d.name},'equities','manual','Trade Republic','EUR','trade_republic','manual_csv',${d.group})`;
        }
        await tx`UPDATE accounts SET provider='trade_republic',connection_type='manual_csv',provider_account_key=${d.group},last_imported_at=now(),updated_at=now() WHERE id=${d.accountId}`;
        for (const t of entries)
          rows.push({
            id: randomUUID(),
            account_id: d.accountId,
            asset_id: assetIds.get(t.instrument.key)!,
            type: t.type,
            occurred_at: t.occurredAt,
            quantity: t.quantity,
            unit_price: t.unitPrice,
            currency: t.currency,
            gross_amount: t.grossAmount,
            fee_amount: t.feeAmount,
            tax_amount: t.taxAmount,
            net_cash_amount: t.netCashAmount,
            source: "csv",
            provider: "trade_republic",
            external_id: t.externalId,
            content_hash: t.hash,
            import_batch_id: id,
            metadata: json({
              event: t.event,
              accountGroup: t.group,
              sourceRow: t.row,
              sourceTimestamp: t.occurredAt,
              parserVersion: stage.parsed.version,
              ...t.evidence,
            }),
          });
        await tx`INSERT INTO csv_import_accounts(batch_id,account_id,imported_rows,duplicate_rows) VALUES(${id},${d.accountId},${entries.length},${count.duplicates})`;
        result.accounts.push({
          id: d.accountId,
          name: accounts.find((a) => a.id === d.accountId)?.name ?? d.name,
          imported: entries.length,
          duplicates: count.duplicates,
        });
      }
      for (let offset = 0; offset < rows.length; offset += 500) {
        const chunk = rows.slice(offset, offset + 500);
        await tx`INSERT INTO transactions ${tx(chunk as never)}`;
      }
      for (const account of result.accounts)
        await new ReconciliationService({ sql: tx }).run(account.id);
      const positions = await new PortfolioService({ sql: tx }).positions();
      result.positionsUpdated = result.accounts.reduce((count, account) => {
        const before = new Map(
          (beforePositions.get(account.id) ?? []).map((p) => [p.assetId, p]),
        );
        const after = new Map(
          (positions.get(account.id) ?? []).map((p) => [p.assetId, p]),
        );
        return (
          count +
          [...new Set([...before.keys(), ...after.keys()])].filter(
            (key) =>
              before.get(key)?.quantity !== after.get(key)?.quantity ||
              before.get(key)?.costBasis !== after.get(key)?.costBasis,
          ).length
        );
      }, 0);
      await tx`INSERT INTO audit_log(actor,action,entity_type,entity_id,after) VALUES('user','csv.import','csv_import_batch',${id},${tx.json(json({ imported: result.imported, duplicates: result.duplicates, skipped: result.skipped, conflicts: result.conflicts }))})`;
      const [completed] = await tx<
        Batch[]
      >`UPDATE csv_import_batches SET status=${preview.summary.warnings ? "completed_with_warnings" : "completed"},staged=NULL,preview=${tx.json(json(preview))},result=${tx.json(json(result))},completed_at=now() WHERE id=${id} RETURNING *`;
      return this.present(completed!);
    });
    return response;
  }
  async cancel(id: string, owner: string) {
    return this.database.sql.begin(async (tx) => {
      const b = await this.load(tx, id, owner, true);
      if (b.status === "preview")
        await tx`UPDATE csv_import_batches SET status='cancelled',staged=NULL WHERE id=${id}`;
      return { cancelled: b.status === "preview" };
    });
  }
  async history(accountId: string, offset: number) {
    const [account] = await this.database
      .sql`SELECT id FROM accounts WHERE id=${accountId}`;
    if (!account) throw new NotFoundError();
    return this.database
      .sql`SELECT b.id,b.filename,b.status,b.completed_at,a.imported_rows,a.duplicate_rows FROM csv_import_accounts a JOIN csv_import_batches b ON b.id=a.batch_id WHERE a.account_id=${accountId} ORDER BY b.completed_at DESC,b.id DESC LIMIT 20 OFFSET ${offset}`;
  }
}
