import { SnapshotService } from "../snapshots/service.js";
import { PortfolioService } from "../portfolio/service.js";
import type { Database } from "../../db/index.js";
import type { Cache } from "../../shared/cache.js";
import type { Config } from "../../config.js";
import { AppError, ConflictError, NotFoundError } from "../../shared/errors.js";
import { AccountService } from "../accounts/service.js";
import { HyperliquidAdapter } from "./hyperliquid/adapter.js";
import { DydxAdapter } from "./dydx/adapter.js";
import { AlchemyPortfolioAdapter } from "./alchemy/adapter.js";
import type { ProviderAsset, ReadOnlyAccountProvider } from "./types.js";
import type { TransactionSql } from "postgres";
export class SyncService {
  private providers: Record<string, ReadOnlyAccountProvider>;
  constructor(
    private database: Database,
    private cache: Cache,
    config: Config,
    providers?: Record<string, ReadOnlyAccountProvider>,
  ) {
    this.providers = providers ?? {
      hyperliquid: new HyperliquidAdapter(),
      dydx: new DydxAdapter(),
      evm_wallet: new AlchemyPortfolioAdapter(
        config.ALCHEMY_API_KEY,
        config.ALCHEMY_NETWORKS.split(","),
      ),
    };
  }
  private async asset(tx: TransactionSql, a: ProviderAsset) {
    const [asset] =
      await tx`INSERT INTO assets(asset_type,symbol,name,quote_currency,chain,contract_address,external_ids)
   VALUES(${a.assetType},${a.symbol},${a.name},'USD',${a.chain ?? null},${a.contractAddress ?? null},${tx.json({ providerKey: a.key })})
   ON CONFLICT ((external_ids->>'providerKey')) WHERE external_ids ? 'providerKey' DO UPDATE SET symbol=excluded.symbol,name=excluded.name,updated_at=now() RETURNING id`;
    return String(asset!.id);
  }
  async enqueue(accountId: string) {
    const account = await new AccountService(this.database).get(accountId);
    if (
      account.sourceType === "manual" ||
      account.isArchived ||
      account.metadata.syncDisabled
    )
      throw new ConflictError("This account is not enabled for provider sync");
    const [run] = await this.database
      .sql`INSERT INTO sync_runs(account_id,provider,status) VALUES(${accountId},${account.sourceType},'queued')
      ON CONFLICT(account_id) WHERE status IN ('queued','running') DO UPDATE SET account_id=excluded.account_id RETURNING *`;
    return this.getRun(accountId, String(run!.id));
  }
  async getRun(accountId: string, runId?: string) {
    const rows = runId
      ? await this.database
          .sql`SELECT * FROM sync_runs WHERE account_id=${accountId} AND id=${runId}`
      : await this.database
          .sql`SELECT * FROM sync_runs WHERE account_id=${accountId} ORDER BY created_at DESC LIMIT 1`;
    const run = rows[0];
    if (!run) {
      if (runId) throw new NotFoundError("Sync run not found");
      return null;
    }
    return {
      ...run,
      provider: run.provider === "evm_wallet" ? "alchemy" : run.provider,
      ...(run.details as Record<string, unknown>),
    };
  }
  async runQueued() {
    await this.database
      .sql`UPDATE sync_runs SET status='failed',finished_at=now(),details='{"failure":{"code":"SYNC_INTERRUPTED","message":"Synchronization interrupted. Retry available.","retryable":true}}' WHERE status='running' AND started_at<now()-interval '15 minutes'`;
    for (let index = 0; index < 20; index++) {
      const [run] = await this.database
        .sql`UPDATE sync_runs SET status='running',started_at=now() WHERE id=(SELECT id FROM sync_runs WHERE status='queued' AND account_id IN (SELECT id FROM accounts WHERE NOT is_archived) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,account_id`;
      if (!run) break;
      try {
        await this.sync(String(run.accountId), String(run.id));
      } catch {
        await this.database
          .sql`UPDATE sync_runs SET status='failed',finished_at=now(),details='{"failure":{"code":"SYNC_UNAVAILABLE","message":"Synchronization could not start. Check the account and retry.","retryable":true}}' WHERE id=${String(run.id)} AND status='running'`;
      }
    }
  }
  async sync(
    accountId: string,
    claimedRunId?: string,
  ): Promise<{
    id: unknown;
    status: unknown;
    cached?: boolean;
    warnings?: string[];
  }> {
    const account = await new AccountService(this.database).get(accountId);
    if (
      account.sourceType === "manual" ||
      account.isArchived ||
      account.metadata.syncDisabled
    )
      throw new ConflictError("This account is not enabled for provider sync");
    const provider = this.providers[account.sourceType];
    if (!provider)
      throw new AppError("NOT_CONFIGURED", "Provider not configured", 503);
    if (!claimedRunId) {
      const [queued] = await this.database
        .sql`UPDATE sync_runs SET status='running',started_at=now() WHERE account_id=${accountId} AND status='queued' RETURNING id`;
      if (queued) return this.sync(accountId, String(queued.id));
    }
    const [previous] = await this.database
      .sql`SELECT cursor,started_at FROM sync_runs WHERE account_id=${accountId} AND status IN ('success','partial') ORDER BY started_at DESC LIMIT 1`;
    const [recent] = claimedRunId
      ? []
      : await this.database
          .sql`SELECT id,status FROM sync_runs WHERE account_id=${accountId} AND started_at>now()-interval '15 seconds' ORDER BY started_at DESC LIMIT 1`;
    if (recent) return { id: recent.id, status: recent.status, cached: true };
    let runId: string = claimedRunId ?? "";
    if (!claimedRunId)
      try {
        await this.database
          .sql`UPDATE sync_runs SET status='failed',error_message='Worker interrupted',finished_at=now() WHERE account_id=${accountId} AND status='running' AND started_at<now()-interval '15 minutes'`;
        const [run] = await this.database
          .sql`INSERT INTO sync_runs(account_id,provider,status,started_at) VALUES(${accountId},${provider.kind},'running',now()) RETURNING id`;
        runId = String(run!.id);
      } catch {
        throw new ConflictError("A sync is already in progress");
      }
    let receivedProviderData = false;
    try {
      const result = await provider.syncAccount(
        account,
        (previous?.cursor ?? {}) as Record<string, unknown>,
      );
      receivedProviderData = true;
      if (!result.coveredScopes.length && !result.positions.length)
        throw new AppError(
          result.failure?.code ?? "PROVIDER_ERROR",
          result.failure?.message ??
            (result.warnings.join("; ") || "No provider data available"),
          502,
          {
            warnings: result.warnings,
            retryable: result.failure?.retryable ?? true,
            networkWarnings: result.warnings.map((message) => ({
              network: message.split(":")[0],
              message,
            })),
          },
        );
      const observedAt = new Date();
      await this.database.sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(64023002)`;
        const [active] =
          await tx`SELECT id FROM accounts WHERE id=${accountId} AND NOT is_archived FOR UPDATE`;
        if (!active) throw new ConflictError("Account removed");
        const seen = new Set<string>();
        for (const p of result.positions) {
          const assetId = await this.asset(tx, p.asset);
          seen.add(assetId);
          await tx`INSERT INTO holding_observations(account_id,asset_id,observed_at,quantity,unit_price,market_value,currency,source,unrealized_pnl,realized_pnl,side,entry_price,leverage,liquidation_price,metadata)
      VALUES(${accountId},${assetId},${observedAt},${p.quantity},${p.unitPrice ?? null},${p.marketValue ?? null},${p.currency},${provider.kind},${p.unrealizedPnl ?? null},${p.realizedPnl ?? null},${p.side ?? null},${p.entryPrice ?? null},${p.leverage ?? null},${p.liquidationPrice ?? null},${tx.json({ scope: p.scope, syncRunId: runId, ...p.metadata })})`;
        }
        // Only a completely fetched provider section can prove that a previously held position is now absent.
        const latest =
          await tx`SELECT DISTINCT ON(asset_id) * FROM holding_observations WHERE account_id=${accountId} ORDER BY asset_id,observed_at DESC,created_at DESC`;
        for (const old of latest) {
          const scope = (old.metadata as Record<string, unknown>).scope;
          if (
            !seen.has(String(old.assetId)) &&
            typeof scope === "string" &&
            result.coveredScopes.includes(scope) &&
            String(old.quantity) !== "0.000000000000000000"
          )
            await tx`INSERT INTO holding_observations(account_id,asset_id,observed_at,quantity,market_value,currency,source,metadata) VALUES(${accountId},${String(old.assetId)},${observedAt},'0','0',${String(old.currency)},${provider.kind},${tx.json({ scope, syncRunId: runId, closed: true })})`;
        }
        for (const t of result.transactions) {
          const assetId = await this.asset(tx, t.asset);
          await tx`INSERT INTO transactions(account_id,asset_id,type,occurred_at,quantity,unit_price,fee_amount,currency,source,external_id)
      VALUES(${accountId},${assetId},${t.type},${t.occurredAt},${t.quantity},${t.unitPrice ?? null},${t.feeAmount ?? null},${t.currency},${provider.kind},${t.externalId}) ON CONFLICT(source,account_id,external_id) DO NOTHING`;
        }
        for (const point of result.history ?? []) {
          await tx`INSERT INTO provider_account_history(account_id,at,resolution,equity,total_pnl,net_transfers,currency,source)
            VALUES(${accountId},${point.at},${point.resolution},${point.equity},${point.totalPnl},${point.netTransfers},${point.currency},${provider.kind})
            ON CONFLICT(account_id,at,resolution,source) DO UPDATE SET equity=excluded.equity,total_pnl=excluded.total_pnl,net_transfers=excluded.net_transfers,retrieved_at=now()`;
        }
        const status = result.warnings.length ? "partial" : "success";
        await tx`UPDATE sync_runs SET status=${status},cursor=${tx.json(result.cursor)},error_message=${result.warnings.join("; ") || null},details=${tx.json({ warnings: result.warnings, networkWarnings: result.warnings.map((message) => ({ network: message.split(":")[0], message })) })},finished_at=now() WHERE id=${runId}`;
        await tx`UPDATE accounts SET updated_at=now(),metadata=metadata || ${tx.json(JSON.parse(JSON.stringify(result.metadata ?? {})) as Record<string, string>)} WHERE id=${accountId}`;
      });
      // Record the first usable valuation immediately after connection, not at the next quarter hour.
      try {
        const prior = await this.database
          .sql`SELECT 1 FROM account_valuations WHERE account_id=${accountId} LIMIT 1`;
        if (!prior.length)
          await new SnapshotService(
            this.database,
            new PortfolioService(this.database),
          ).capture();
      } catch {
        /* A snapshot retry must not misreport an already committed provider sync as failed. */
      }
      try {
        await this.cache.incr("portfolio:revision");
      } catch {}
      return {
        id: runId,
        status: result.warnings.length ? "partial" : "success",
        warnings: result.warnings,
      };
    } catch (error) {
      const saveFailure = receivedProviderData && !(error instanceof AppError);
      const alchemyError =
        error instanceof AppError && error.code.startsWith("ALCHEMY_");
      const message = alchemyError
        ? error.message
        : saveFailure
          ? "Synchronization data could not be saved on the server. Your account is saved; retry synchronization."
          : account.sourceType === "evm_wallet"
            ? "Alchemy unavailable. Your wallet is saved; retry synchronization."
            : error instanceof AppError
              ? error.message
              : "Provider data could not be validated or saved";
      const failure = {
        code: alchemyError
          ? error.code
          : saveFailure
            ? "SYNC_SAVE_FAILED"
            : account.sourceType === "evm_wallet"
              ? "ALCHEMY_UNAVAILABLE"
              : "PROVIDER_ERROR",
        message,
        retryable:
          error instanceof AppError &&
          typeof (error.details as { retryable?: unknown } | undefined)
            ?.retryable === "boolean"
            ? (error.details as { retryable: boolean }).retryable
            : true,
      };
      await this.database
        .sql`UPDATE sync_runs SET status='failed',error_message=${message},details=${this.database.sql.json({ failure, ...(error instanceof AppError ? (error.details as Record<string, unknown>) : {}) })},finished_at=now() WHERE id=${runId} AND status='running'`;
      try {
        await this.cache.incr("portfolio:revision");
      } catch {}
      throw new AppError(failure.code, message, 502, {
        retryable: failure.retryable,
      });
    }
  }
  async syncAll() {
    const accounts = await new AccountService(this.database).list();
    for (const a of accounts)
      if (a.sourceType !== "manual" && !a.metadata.syncDisabled) {
        try {
          await this.sync(a.id);
        } catch {
          /* sync_runs retains sanitized error; other accounts still sync. */
        }
      }
  }
}
