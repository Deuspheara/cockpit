import { SnapshotService } from "../snapshots/service.js";
import { PortfolioService } from "../portfolio/service.js";
import type { Database } from "../../db/index.js";
import type { Cache } from "../../shared/cache.js";
import type { Config } from "../../config.js";
import { AppError, ConflictError } from "../../shared/errors.js";
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
  async sync(accountId: string) {
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
    const [previous] = await this.database
      .sql`SELECT cursor,started_at FROM sync_runs WHERE account_id=${accountId} AND status IN ('success','partial') ORDER BY started_at DESC LIMIT 1`;
    const [recent] = await this.database
      .sql`SELECT id,status FROM sync_runs WHERE account_id=${accountId} AND started_at>now()-interval '15 seconds' ORDER BY started_at DESC LIMIT 1`;
    if (recent) return { id: recent.id, status: recent.status, cached: true };
    let runId: string;
    try {
      await this.database
        .sql`UPDATE sync_runs SET status='failed',error_message='Worker interrupted',finished_at=now() WHERE account_id=${accountId} AND status='running' AND started_at<now()-interval '15 minutes'`;
      const [run] = await this.database
        .sql`INSERT INTO sync_runs(account_id,provider,status) VALUES(${accountId},${provider.kind},'running') RETURNING id`;
      runId = String(run!.id);
    } catch {
      throw new ConflictError("A sync is already in progress");
    }
    try {
      const result = await provider.syncAccount(
        account,
        (previous?.cursor ?? {}) as Record<string, unknown>,
      );
      if (!result.coveredScopes.length && !result.positions.length)
        throw new AppError(
          "PROVIDER_ERROR",
          result.warnings.join("; ") || "No provider data available",
          502,
        );
      const observedAt = new Date();
      await this.database.sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(64023002)`;
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
        await tx`UPDATE sync_runs SET status=${status},cursor=${tx.json(result.cursor)},error_message=${result.warnings.join("; ") || null},finished_at=now() WHERE id=${runId}`;
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
      const message =
        error instanceof AppError
          ? error.message
          : "Provider data could not be validated or saved";
      await this.database
        .sql`UPDATE sync_runs SET status='failed',error_message=${message},finished_at=now() WHERE id=${runId}`;
      try {
        await this.cache.incr("portfolio:revision");
      } catch {}
      throw new AppError("PROVIDER_ERROR", message, 502);
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
