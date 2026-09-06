import { ReconciliationService } from "../reconciliation/service.js";
import { Decimal, money } from "../../shared/decimal.js";
import { changeEffects } from "./effects.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Database } from "../../db/index.js";
import type { TransactionSql, JSONValue } from "postgres";
import { AppError, ConflictError, NotFoundError } from "../../shared/errors.js";
import { transactionInput, observationInput } from "../ledger/schemas.js";
import { ruleInput } from "../recurring/schemas.js";
import { previousDay } from "../recurring/calendar.js";

// Only application services construct operations. HTTP/model callers submit typed intents.
const tableSchema = z.enum([
  "accounts",
  "assets",
  "transactions",
  "holding_observations",
  "recurring_rules",
  "recurring_occurrences",
]);
type Table = z.infer<typeof tableSchema>;
type RecordValue = Record<string, unknown>;
export interface Operation {
  table: Table;
  id: string;
  before: RecordValue | null;
  after: RecordValue | null;
}
interface ChangeSet {
  id: string;
  kind: string;
  title: string;
  summary: string;
  status: string;
  createdBy: string;
  operations: Operation[];
  inverseOperations: Operation[] | null;
}
const columns: Record<Table, string[]> = {
  accounts: [
    "provider",
    "connectionType",
    "providerAccountKey",
    "lastImportedAt",
    "id",
    "name",
    "assetClass",
    "sourceType",
    "institution",
    "baseCurrency",
    "externalAddress",
    "externalSubaccount",
    "metadata",
    "sortOrder",
    "isArchived",
    "createdAt",
    "updatedAt",
  ],
  assets: [
    "id",
    "assetType",
    "symbol",
    "name",
    "quoteCurrency",
    "chain",
    "contractAddress",
    "externalIds",
    "createdAt",
    "updatedAt",
  ],
  transactions: [
    "provider",
    "importBatchId",
    "contentHash",
    "netCashAmount",
    "taxAmount",
    "id",
    "accountId",
    "assetId",
    "type",
    "occurredAt",
    "quantity",
    "unitPrice",
    "currency",
    "grossAmount",
    "feeAmount",
    "notes",
    "source",
    "externalId",
    "recurrenceOccurrenceId",
    "transferGroupId",
    "isVoided",
    "metadata",
    "createdAt",
    "updatedAt",
  ],
  holding_observations: [
    "id",
    "accountId",
    "assetId",
    "observedAt",
    "quantity",
    "unitPrice",
    "marketValue",
    "currency",
    "costBasis",
    "unrealizedPnl",
    "realizedPnl",
    "side",
    "entryPrice",
    "leverage",
    "liquidationPrice",
    "source",
    "confidence",
    "importSessionId",
    "externalId",
    "metadata",
    "createdAt",
  ],
  recurring_rules: [
    "id",
    "seriesId",
    "accountId",
    "assetId",
    "transactionType",
    "inputMode",
    "quantity",
    "cashAmount",
    "currency",
    "cadence",
    "interval",
    "weekday",
    "dayOfMonth",
    "startOn",
    "endOn",
    "autoPost",
    "enabled",
    "supersedesRuleId",
    "createdAt",
    "updatedAt",
  ],
  recurring_occurrences: [
    "id",
    "ruleId",
    "dueAt",
    "status",
    "transactionId",
    "createdAt",
    "updatedAt",
  ],
};
const json = (v: unknown): Record<string, JSONValue> =>
  JSON.parse(JSON.stringify(v)) as Record<string, JSONValue>;
export class ChangeSetService {
  constructor(private database: Database) {}
  async get(id: string) {
    const [c] = await this.database.sql<
      ChangeSet[]
    >`SELECT * FROM change_sets WHERE id=${id}`;
    if (!c) throw new NotFoundError("Change set not found");
    return this.present(c);
  }
  private async present(c: ChangeSet) {
    const rows = await this.database.sql<
      { id: string; label: string }[]
    >`SELECT id,name AS label FROM accounts UNION ALL SELECT id,symbol||' · '||name AS label FROM assets`;
    const labels: Record<string, string> = Object.fromEntries(
      rows.map((r) => [r.id, r.label]),
    );
    for (const op of c.operations)
      if (op.after && (op.table === "accounts" || op.table === "assets"))
        labels[op.id] = String(op.after.name ?? op.after.symbol);
    return { ...c, effects: changeEffects(c.operations), labels };
  }
  async draft(
    kind: string,
    title: string,
    operations: Operation[],
    createdBy: "user" | "agent" | "reconciliation" = "user",
  ) {
    if (!operations.length || operations.length > 100)
      throw new AppError(
        "VALIDATION_ERROR",
        "Change sets must contain 1–100 operations",
      );
    const [change] = await this.database.sql<
      ChangeSet[]
    >`INSERT INTO change_sets(kind,title,summary,operations,created_by)
   VALUES(${kind},${title},${`${operations.length} explicit record change(s)`},${this.database.sql.json(json(operations))},${createdBy}) RETURNING *`;
    return this.present(change!);
  }
  async requireManual(accountId: string) {
    const [a] = await this.database
      .sql`SELECT source_type,is_archived FROM accounts WHERE id=${accountId}`;
    if (!a) throw new NotFoundError("Account not found");
    if (a.sourceType !== "manual" || a.isArchived)
      throw new ConflictError(
        "Financial edits require an active manual account",
      );
  }
  async proposeTransaction(input: unknown, actor: "user" | "agent" = "user") {
    const t = transactionInput.parse(input);
    await this.requireManual(t.accountId);
    return this.draft(
      "transaction.create",
      "Add transaction",
      [
        {
          table: "transactions",
          id: randomUUID(),
          before: null,
          after: {
            ...t,
            source: actor === "agent" ? "agent" : "manual",
            isVoided: false,
          },
        },
      ],
      actor,
    );
  }
  async proposeObservation(input: unknown, actor: "user" | "agent" = "user") {
    const o = observationInput.parse(input);
    await this.requireManual(o.accountId);
    return this.draft(
      "observation.create",
      "Record observed position",
      [
        {
          table: "holding_observations",
          id: randomUUID(),
          before: null,
          after: { ...o, source: actor === "agent" ? "agent" : "manual" },
        },
      ],
      actor,
    );
  }
  async proposeTransactionEdit(
    id: string,
    input: unknown | null,
    actor: "user" | "agent" = "user",
  ) {
    const [record] = await this.database
      .sql`SELECT * FROM transactions WHERE id=${id}`;
    if (!record) throw new NotFoundError();
    await this.requireManual(String(record.accountId));
    if (record.externalId)
      throw new ConflictError("Provider activity is read-only");
    const before = json(record);
    const after: RecordValue =
      input === null
        ? { ...before, isVoided: true }
        : { ...before, ...transactionInput.parse(input) };
    if (
      input !== null &&
      after.unitPrice != null &&
      (after.quantity !== before.quantity ||
        after.unitPrice !== before.unitPrice)
    )
      after.grossAmount = money(
        new Decimal(String(after.quantity)).mul(String(after.unitPrice)),
      );
    if (
      after.accountId !== before.accountId ||
      after.assetId !== before.assetId
    )
      throw new ConflictError(
        "Correct an event within its existing account and asset",
      );
    return this.draft(
      input === null ? "transaction.void" : "transaction.edit",
      input === null ? "Void transaction" : "Correct transaction",
      [{ table: "transactions", id, before, after }],
      actor,
    );
  }
  async proposeRule(input: unknown, actor: "user" | "agent" = "user") {
    const r = ruleInput.parse(input);
    await this.requireManual(r.accountId);
    return this.draft(
      "rule.create",
      "Create recurring investment",
      [
        {
          table: "recurring_rules",
          id: randomUUID(),
          before: null,
          after: { ...r, seriesId: randomUUID(), enabled: true },
        },
      ],
      actor,
    );
  }
  async proposeRuleChange(
    id: string,
    effectiveOn: string,
    replacement: unknown | null,
    actor: "user" | "agent" = "user",
  ) {
    z.iso.date().parse(effectiveOn);
    const [record] = await this.database
      .sql`SELECT * FROM recurring_rules WHERE id=${id}`;
    if (!record) throw new NotFoundError();
    await this.requireManual(String(record.accountId));
    const before = json(record);
    const start = String(before.startOn).slice(0, 10);
    const end = before.endOn ? String(before.endOn).slice(0, 10) : null;
    if (effectiveOn < start || (end && effectiveOn > end))
      throw new ConflictError(
        "Effective date must fall within this rule version",
      );
    const later = await this.database
      .sql`SELECT * FROM recurring_rules WHERE series_id=${String(before.seriesId)} AND start_on>=${effectiveOn}::date AND id<>${id} AND enabled ORDER BY start_on`;
    const affectedRuleIds = [id, ...later.map((r) => String(r.id))];
    const operations: Operation[] = [
      {
        table: "recurring_rules",
        id,
        before,
        after:
          effectiveOn === start
            ? { ...before, enabled: false }
            : { ...before, endOn: previousDay(effectiveOn) },
      },
    ];
    for (const rule of later)
      operations.push({
        table: "recurring_rules",
        id: String(rule.id),
        before: json(rule),
        after: { ...json(rule), enabled: false },
      });
    if (replacement !== null) {
      const r = ruleInput.parse(replacement);
      if (
        r.startOn !== effectiveOn ||
        r.accountId !== before.accountId ||
        r.assetId !== before.assetId
      )
        throw new ConflictError(
          "Replacement must match account, asset and effective date",
        );
      operations.push({
        table: "recurring_rules",
        id: randomUUID(),
        before: null,
        after: {
          ...r,
          seriesId: before.seriesId,
          supersedesRuleId: id,
          enabled: true,
        },
      });
    }
    const occurrences = await this.database
      .sql`SELECT * FROM recurring_occurrences WHERE rule_id IN ${this.database.sql(affectedRuleIds)} AND due_at >= ${effectiveOn}::date AND status NOT IN ('detached','skipped') ORDER BY due_at`;
    for (const o of occurrences) {
      operations.push({
        table: "recurring_occurrences",
        id: String(o.id),
        before: json(o),
        after: { ...json(o), status: "skipped" },
      });
      if (o.transactionId) {
        const [t] = await this.database
          .sql`SELECT * FROM transactions WHERE id=${String(o.transactionId)}`;
        if (t && !t.isVoided)
          operations.push({
            table: "transactions",
            id: String(t.id),
            before: json(t),
            after: { ...json(t), isVoided: true },
          });
      }
    }
    return this.draft(
      replacement === null ? "rule.stop" : "rule.split",
      replacement === null
        ? `Stop from ${effectiveOn}`
        : `Change from ${effectiveOn}`,
      operations,
      actor,
    );
  }
  async proposeEntireSeries(ruleId: string, replacement: unknown) {
    const [rule] = await this.database
      .sql`SELECT series_id FROM recurring_rules WHERE id=${ruleId}`;
    if (!rule) throw new NotFoundError();
    const [first] = await this.database
      .sql`SELECT id,start_on FROM recurring_rules WHERE series_id=${String(rule.seriesId)} ORDER BY start_on,created_at DESC LIMIT 1`;
    const input = ruleInput.parse(replacement);
    if (input.startOn !== String(first!.startOn))
      throw new ConflictError(
        `An entire-series replacement must start on ${String(first!.startOn)}`,
      );
    return this.proposeRuleChange(String(first!.id), input.startOn, input);
  }
  async proposePostOccurrence(id: string, input: unknown) {
    const [o] = await this.database
      .sql`SELECT * FROM recurring_occurrences WHERE id=${id}`;
    if (!o) throw new NotFoundError();
    if (o.status !== "planned")
      throw new ConflictError("Only a planned occurrence can be confirmed");
    const [r] = await this.database
      .sql`SELECT * FROM recurring_rules WHERE id=${String(o.ruleId)}`;
    const transaction = transactionInput.parse(input);
    if (
      transaction.accountId !== r?.accountId ||
      transaction.assetId !== r?.assetId ||
      transaction.type !== r?.transactionType
    )
      throw new ConflictError(
        "The confirmed transaction must match the recurring account, asset and type",
      );
    await this.requireManual(transaction.accountId);
    const transactionId = randomUUID();
    return this.draft(
      "occurrence.confirm",
      "Confirm actual recurring transaction",
      [
        {
          table: "transactions",
          id: transactionId,
          before: null,
          after: {
            ...transaction,
            source: "recurring_rule",
            recurrenceOccurrenceId: id,
            isVoided: false,
          },
        },
        {
          table: "recurring_occurrences",
          id,
          before: json(o),
          after: { ...json(o), status: "posted", transactionId },
        },
      ],
    );
  }
  async proposeOccurrence(
    id: string,
    status: "skipped" | "detached",
    actor: "user" | "agent" = "user",
  ) {
    const [record] = await this.database
      .sql`SELECT * FROM recurring_occurrences WHERE id=${id}`;
    if (!record) throw new NotFoundError();
    const operations: Operation[] = [
      {
        table: "recurring_occurrences",
        id,
        before: json(record),
        after: { ...json(record), status },
      },
    ];
    if (status === "skipped" && record.transactionId) {
      const [t] = await this.database
        .sql`SELECT * FROM transactions WHERE id=${String(record.transactionId)}`;
      if (t && !t.isVoided)
        operations.push({
          table: "transactions",
          id: String(t.id),
          before: json(t),
          after: { ...json(t), isVoided: true },
        });
    }
    return this.draft(
      `occurrence.${status}`,
      status === "skipped" ? "Skip occurrence" : "Detach occurrence",
      operations,
      actor,
    );
  }
  private async execute(tx: TransactionSql, op: Operation): Promise<Operation> {
    const table = tableSchema.parse(op.table);
    z.uuid().toLowerCase().parse(op.id);
    const [existing] =
      await tx`SELECT * FROM ${tx(table)} WHERE id=${op.id} FOR UPDATE`;
    const actual = existing ? json(existing) : null;
    if (!isDeepStrictEqual(actual, op.before))
      throw new ConflictError(
        "Data changed since this preview. Create a fresh proposal.",
      );
    if (op.after === null) {
      await tx`DELETE FROM ${tx(table)} WHERE id=${op.id}`;
      return { ...op, after: null };
    }
    const data: RecordValue = { ...op.after, id: op.id };
    if (Object.keys(data).some((k) => !columns[table].includes(k)))
      throw new AppError("VALIDATION_ERROR", "Unsupported operation field");
    if (
      ["transactions", "holding_observations", "recurring_rules"].includes(
        table,
      )
    ) {
      const [account] =
        await tx`SELECT source_type,is_archived FROM accounts WHERE id=${String(data.accountId)} FOR SHARE`;
      if (!account || account.sourceType !== "manual" || account.isArchived)
        throw new ConflictError("Account no longer allows manual edits");
    }
    if (table === "transactions") {
      const [asset] =
        await tx`SELECT quote_currency FROM assets WHERE id=${String(data.assetId)}`;
      if (asset && asset.quoteCurrency !== data.currency)
        throw new ConflictError(
          "Transaction currency must match the asset quote currency in V1",
        );
    }
    // All fields are application-owned, allowlisted above. SQL identifiers never come from the model.
    const sqlData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data))
      sqlData[key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase())] = value;
    const keys = Object.keys(sqlData);
    let result;
    if (actual === null)
      [result] =
        await tx`INSERT INTO ${tx(table)} ${tx(sqlData as never, keys)} RETURNING *`;
    else {
      delete sqlData.id;
      delete sqlData.created_at;
      if (columns[table].includes("updatedAt"))
        sqlData.updated_at = new Date().toISOString();
      [result] =
        await tx`UPDATE ${tx(table)} SET ${tx(sqlData as never, Object.keys(sqlData))} WHERE id=${op.id} RETURNING *`;
    }
    return { ...op, after: json(result) };
  }
  async apply(id: string, undo = false) {
    const result = await this.database.sql.begin(async (tx) => {
      // Same lock as recurrence materialization and snapshots: no new occurrence escapes a retrospective preview.
      await tx`SELECT pg_advisory_xact_lock(64023002)`;
      const [c] = await tx<
        ChangeSet[]
      >`SELECT * FROM change_sets WHERE id=${id} FOR UPDATE`;
      if (!c) throw new NotFoundError();
      if ((!undo && c.status === "applied") || (undo && c.status === "undone"))
        return c;
      if (c.status !== (undo ? "applied" : "draft"))
        throw new ConflictError("Invalid change-set state");
      const ops = undo ? c.inverseOperations : c.operations;
      if (!ops) throw new ConflictError("Undo unavailable");
      // Verify occurrence membership has not changed since a series preview was prepared.
      if (!undo && (c.kind === "rule.stop" || c.kind === "rule.split")) {
        const ruleOp = ops[0]!;
        const effective = ruleOp.after?.endOn
          ? new Date(
              new Date(
                `${String(ruleOp.after.endOn).slice(0, 10)}T00:00:00Z`,
              ).getTime() + 86400000,
            ).toISOString()
          : String(ruleOp.before?.startOn);
        const rows =
          await tx`SELECT id FROM recurring_occurrences WHERE rule_id IN ${tx(ops.filter((op) => op.table === "recurring_rules" && op.before !== null).map((op) => op.id))} AND due_at>=${effective}::timestamptz AND status NOT IN ('detached','skipped')`;
        if (
          rows.some(
            (row) =>
              !ops.some(
                (op) =>
                  op.table === "recurring_occurrences" && op.id === row.id,
              ),
          )
        )
          throw new ConflictError(
            "New occurrences exist. Refresh the preview.",
          );
      }
      const executed: Operation[] = [];
      for (const op of ops) {
        const result = await this.execute(tx, op);
        executed.push(result);
        await tx`INSERT INTO audit_log(actor,action,entity_type,entity_id,change_set_id,before,after)
     VALUES('user',${undo ? "undo" : "apply"},${op.table},${op.id},${id},${op.before ? tx.json(json(op.before)) : null},${result.after ? tx.json(json(result.after)) : null})`;
      }
      const negative =
        await tx`SELECT t.account_id,t.asset_id FROM transactions t JOIN accounts a ON a.id=t.account_id JOIN assets s ON s.id=t.asset_id WHERE NOT t.is_voided AND a.source_type='manual' AND s.asset_type<>'cash' GROUP BY t.account_id,t.asset_id HAVING sum(CASE WHEN t.type IN ('SELL','WITHDRAWAL','TRANSFER_OUT','FEE') THEN -t.quantity ELSE t.quantity END)<0`;
      if (negative.length)
        throw new ConflictError(
          "The change would create a negative manual holding. Add the missing acquisition history first.",
        );
      for (const accountId of new Set(
        executed
          .filter((op) =>
            ["transactions", "holding_observations"].includes(op.table),
          )
          .map((op) => String((op.after ?? op.before)?.accountId)),
      ))
        await new ReconciliationService({ sql: tx }).run(accountId);
      if (c.kind === "import.apply")
        await tx`UPDATE import_sessions SET status=${undo ? "ready_for_review" : "applied"},change_set_id=${undo ? null : id},revision=revision+1,updated_at=now() WHERE change_set_id=${id}`;
      if (undo) {
        const [updated] = await tx<
          ChangeSet[]
        >`UPDATE change_sets SET status='undone',undone_at=now() WHERE id=${id} RETURNING *`;
        return updated!;
      }
      const inverse = executed
        .slice()
        .reverse()
        .map((op) => ({
          table: op.table,
          id: op.id,
          before: op.after,
          after:
            op.before === null
              ? op.table === "transactions"
                ? { ...op.after, isVoided: true }
                : op.table === "accounts"
                  ? { ...op.after, isArchived: true }
                  : op.table === "assets"
                    ? op.after
                    : null
              : op.before,
        }));
      const [updated] = await tx<
        ChangeSet[]
      >`UPDATE change_sets SET status='applied',applied_at=now(),operations=${tx.json(json(executed))},inverse_operations=${tx.json(json(inverse))} WHERE id=${id} RETURNING *`;
      return updated!;
    });
    return this.present(result);
  }
  async reject(id: string) {
    const [c] = await this.database.sql<
      ChangeSet[]
    >`UPDATE change_sets SET status='rejected' WHERE id=${id} AND status='draft' RETURNING *`;
    if (!c) throw new ConflictError("Only drafts can be rejected");
    await this.database
      .sql`UPDATE import_sessions SET change_set_id=NULL,updated_at=now() WHERE change_set_id=${id}`;
    return c;
  }
}
