import type { Sql, TransactionSql, JSONValue } from "postgres";
import { randomUUID } from "node:crypto";
import type { Database } from "../../db/index.js";
import type { Config } from "../../config.js";
import type { Cache } from "../../shared/cache.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import { Decimal, money } from "../../shared/decimal.js";
import {
  EODHDClient,
  EODHDQuotaCoordinator,
  MarketProviderError,
  OpenFigiClient,
  type EodBar,
  type EodhdListing,
  type EODHDRequestGate,
  type OpenFigiEvidence,
} from "./providers.js";

type SQL = Sql | TransactionSql;
type JobType = "resolve" | "refresh_latest" | "backfill_history";
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as JSONValue;

export function normalizedIsin(value: string | null | undefined) {
  const isin = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin) ? isin : null;
}

export async function enqueueMarketDataJob(
  sql: SQL,
  securityId: string,
  jobType: JobType,
  mappingRevision?: number,
  nextAttemptAt = new Date(),
) {
  const [budget] = await sql<{ blockedUntil: Date }[]>`
    SELECT blocked_until FROM provider_call_budgets
    WHERE provider='eodhd' AND budget_day=(now() AT TIME ZONE 'UTC')::date
      AND blocked_until>now()`;
  const scheduledAt =
    budget && budget.blockedUntil > nextAttemptAt
      ? budget.blockedUntil
      : nextAttemptAt;
  const rows = await sql`
    INSERT INTO market_data_jobs(security_id,job_type,mapping_revision,next_attempt_at)
    VALUES(${securityId},${jobType},${mappingRevision ?? null},${scheduledAt})
    ON CONFLICT DO NOTHING RETURNING id`;
  return rows.length > 0;
}

export async function linkSecurityAsset(
  sql: SQL,
  input: {
    assetId: string;
    isin: string;
    name: string;
    assetType: string;
  },
) {
  const isin = normalizedIsin(input.isin);
  if (!isin) return null;
  const [security] = await sql<
    {
      id: string;
      selectionLocked: boolean;
      verificationRevision: number;
    }[]
  >`
    INSERT INTO securities(isin,name,asset_type)
    VALUES(${isin},${input.name},${input.assetType})
    ON CONFLICT(isin) DO UPDATE SET updated_at=now()
    RETURNING id,selection_locked,verification_revision`;
  await sql`UPDATE assets SET security_id=${security!.id},updated_at=now() WHERE id=${input.assetId}`;
  await sql`
    UPDATE securities SET primary_asset_id=coalesce(primary_asset_id,${input.assetId}),updated_at=now()
    WHERE id=${security!.id}`;
  const [mapping] = await sql`
    SELECT m.id FROM provider_mappings m
    JOIN security_listings l ON l.id=m.listing_id
    WHERE l.security_id=${security!.id} AND l.active
      AND m.provider='eodhd' AND m.verification_status='verified'
      AND m.verification_revision=${security!.verificationRevision}
    LIMIT 1`;
  if (!mapping && !security!.selectionLocked)
    await enqueueMarketDataJob(sql, security!.id, "resolve");
  return security!.id;
}

interface SecurityRow {
  id: string;
  isin: string;
  name: string;
  assetType: string;
  identityStatus: string;
  identityEvidence: Record<string, unknown>;
  preferredMappingId: string | null;
  selectionLocked: boolean;
  revision: number;
  verificationRevision: number;
}
interface JobRow {
  id: string;
  securityId: string;
  isin: string;
  jobType: JobType;
  mappingRevision: number | null;
  attempts: number;
}
interface MappingRow {
  id: string;
  listingId: string;
  securityId: string;
  providerSymbol: string;
  providerExchange: string | null;
  verificationStatus: string;
  revision: number;
  verificationRevision: number;
  quoteCurrency: string;
  unitMultiplier: string;
  ticker: string;
  mic: string | null;
  name: string;
  active: boolean;
  evidence: { isPrimary?: boolean };
}

export class MarketDataService {
  private eodhd: EODHDClient;
  private openFigi: OpenFigiClient;
  private eodhdGate: EODHDRequestGate;
  constructor(
    private database: Database,
    cache: Cache,
    private config: Config,
    clients?: { eodhd?: EODHDClient; openFigi?: OpenFigiClient },
    eodhdGate?: EODHDRequestGate,
  ) {
    this.eodhdGate =
      eodhdGate ?? new EODHDQuotaCoordinator(database, cache, config);
    this.eodhd = clients?.eodhd ?? new EODHDClient(this.eodhdGate, config);
    this.openFigi =
      clients?.openFigi ?? new OpenFigiClient(cache, config.OPENFIGI_API_KEY);
  }

  private async security(id: string) {
    const [row] = await this.database.sql<SecurityRow[]>`
      SELECT * FROM securities WHERE id=${id}`;
    if (!row) throw new NotFoundError("Security not found");
    return row;
  }

  private async mapping(id: string) {
    const [row] = await this.database.sql<MappingRow[]>`
      SELECT m.*,l.security_id,l.quote_currency,l.unit_multiplier,l.ticker,l.mic,l.name,l.active
      FROM provider_mappings m JOIN security_listings l ON l.id=m.listing_id
      WHERE m.id=${id}`;
    if (!row) throw new NotFoundError("Market-data mapping not found");
    return row;
  }

  private async state(
    securityId: string,
    stage: string,
    status: string,
    options: {
      errorClass?: string | null;
      provider?: string | null;
      providerCode?: string | null;
      message?: string | null;
      success?: boolean;
      nextRetryAt?: Date | null;
      metadata?: unknown;
    } = {},
  ) {
    await this.database.sql`
      INSERT INTO market_data_state(
        security_id,stage,status,error_class,provider,provider_code,message,
        last_attempt_at,last_success_at,next_retry_at,metadata
      ) VALUES(
        ${securityId},${stage},${status},${options.errorClass ?? null},
        ${options.provider ?? null},${options.providerCode ?? null},${options.message ?? null},
        now(),${options.success ? new Date() : null},${options.nextRetryAt ?? null},
        ${this.database.sql.json(json(options.metadata ?? {}))}
      )
      ON CONFLICT(security_id,stage) DO UPDATE SET
        status=excluded.status,error_class=excluded.error_class,provider=excluded.provider,
        provider_code=excluded.provider_code,message=excluded.message,last_attempt_at=now(),
        last_success_at=CASE WHEN ${options.success ?? false} THEN now() ELSE market_data_state.last_success_at END,
        next_retry_at=excluded.next_retry_at,metadata=excluded.metadata,updated_at=now()`;
  }

  private async saveListings(
    security: SecurityRow,
    candidates: EodhdListing[],
    figi: unknown[],
  ) {
    const mappings: MappingRow[] = [];
    await this.database.sql.begin(async (tx) => {
      for (const candidate of candidates) {
        await tx`
          INSERT INTO security_listings(security_id,ticker,name,quote_currency)
          VALUES(${security.id},${candidate.ticker},${candidate.name},${candidate.currency})
          ON CONFLICT DO NOTHING`;
        const [listing] = await tx<{ id: string }[]>`
          SELECT id FROM security_listings
          WHERE security_id=${security.id} AND ticker=${candidate.ticker}
            AND mic IS NULL AND quote_currency=${candidate.currency}
          ORDER BY created_at LIMIT 1`;
        if (!listing) continue;
        await tx`
          UPDATE security_listings SET name=${candidate.name},active=true,updated_at=now()
          WHERE id=${listing.id}`;
        const [conflict] = await tx<{ securityId: string }[]>`
          SELECT l.security_id FROM provider_mappings m
          JOIN security_listings l ON l.id=m.listing_id
          WHERE m.provider='eodhd' AND m.provider_symbol=${candidate.providerSymbol}`;
        if (conflict && conflict.securityId !== security.id) continue;
        await tx`
          INSERT INTO provider_mappings(
            listing_id,provider,provider_symbol,provider_exchange,verification_status,evidence,
            verified_at,verification_revision
          ) VALUES(
            ${listing.id},'eodhd',${candidate.providerSymbol},${candidate.exchange},'verified',
            ${tx.json(json({ source: "eodhd_exact_isin", isin: security.isin, isPrimary: candidate.isPrimary, openFigi: figi }))},now(),${security.verificationRevision}
          )
          ON CONFLICT(provider,provider_symbol) DO UPDATE SET
            listing_id=excluded.listing_id,provider_exchange=excluded.provider_exchange,
            evidence=excluded.evidence,verification_status='verified',verified_at=now(),
            verification_revision=excluded.verification_revision,updated_at=now()`;
      }
    });
    const rows = await this.database.sql<MappingRow[]>`
      SELECT m.*,l.security_id,l.quote_currency,l.unit_multiplier,l.ticker,l.mic,l.name,l.active
      FROM provider_mappings m JOIN security_listings l ON l.id=m.listing_id
      WHERE l.security_id=${security.id} AND l.active
        AND m.verification_status='verified'
        AND m.verification_revision=${security.verificationRevision}
      ORDER BY (m.evidence->>'isPrimary')::boolean DESC,m.provider_symbol`;
    mappings.push(...rows);
    return mappings;
  }

  private async reusableMappings(security: SecurityRow) {
    return this.database.sql<MappingRow[]>`
      SELECT m.*,l.security_id,l.quote_currency,l.unit_multiplier,l.ticker,l.mic,l.name,l.active
      FROM provider_mappings m JOIN security_listings l ON l.id=m.listing_id
      WHERE l.security_id=${security.id} AND l.active
        AND m.provider='eodhd' AND m.verification_status='verified'
        AND m.verification_revision=${security.verificationRevision}
      ORDER BY (m.evidence->>'isPrimary')::boolean DESC,m.provider_symbol`;
  }

  private automaticMapping(
    mappings: MappingRow[],
    preferredMappingId: string | null,
  ) {
    const preferred = mappings.find((m) => m.id === preferredMappingId);
    if (preferred) return preferred;
    if (mappings.length === 1) return mappings[0]!;
    const primary = mappings.filter((m) => m.evidence?.isPrimary === true);
    return primary.length === 1 ? primary[0]! : null;
  }

  private async resolve(
    securityId: string,
    openFigiEvidence?: OpenFigiEvidence[],
  ) {
    const security = await this.security(securityId);
    const reusable = await this.reusableMappings(security);
    if (security.selectionLocked) {
      const selected = reusable.find(
        (mapping) => mapping.id === security.preferredMappingId,
      );
      await this.state(
        securityId,
        "selection",
        selected ? "selected" : "selection_pending",
        {
          success: !!selected,
          message: selected
            ? null
            : "The locked listing is no longer active or currently verified.",
        },
      );
      return;
    }
    if (reusable.length) {
      const selected = this.automaticMapping(
        reusable,
        security.preferredMappingId,
      );
      let revision = security.revision;
      if (selected?.id !== security.preferredMappingId) {
        const updated = await this.database.sql`
          UPDATE securities SET preferred_mapping_id=${selected?.id ?? null},
            identity_status='identity_resolved',revision=revision+1,updated_at=now()
          WHERE id=${securityId} AND revision=${security.revision} AND NOT selection_locked
          RETURNING id`;
        if (!updated.length) return;
        revision++;
      }
      await this.state(
        securityId,
        "selection",
        selected ? "selected" : "selection_required",
        {
          success: !!selected,
          message: selected ? null : "Listing selection required",
          metadata: {
            resolutionReason: selected ? null : "listing_selection_required",
          },
        },
      );
      if (selected && selected.id !== security.preferredMappingId)
        await enqueueMarketDataJob(
          this.database.sql,
          securityId,
          "backfill_history",
          revision,
        );
      return;
    }

    let figi = openFigiEvidence;
    if (!figi)
      try {
        figi = await this.openFigi.mapIsin(security.isin);
      } catch (error) {
        if (!(error instanceof MarketProviderError)) throw error;
        figi = [];
      }
    await this.database.sql`
      UPDATE securities SET identity_evidence=${this.database.sql.json(json({ openFigi: figi }))},updated_at=now()
      WHERE id=${securityId} AND revision=${security.revision} AND NOT selection_locked`;

    let candidates = await this.eodhd.searchIsin(security.isin);
    if (!candidates.length) {
      const mapped = await this.eodhd.mapIsin(security.isin);
      const figiTickers = new Set(
        figi.flatMap((item) =>
          item.ticker?.trim() ? [item.ticker.trim().toUpperCase()] : [],
        ),
      );
      const symbol = [...mapped].sort((left, right) => {
        const leftTicker = left.split(".")[0]!.toUpperCase();
        const rightTicker = right.split(".")[0]!.toUpperCase();
        const evidenceOrder =
          Number(!figiTickers.has(leftTicker)) -
          Number(!figiTickers.has(rightTicker));
        return evidenceOrder || left.localeCompare(right);
      })[0];
      if (symbol)
        candidates = await this.eodhd.searchExact(symbol, security.isin);
    }
    const mappings = await this.saveListings(security, candidates, figi);
    if (!mappings.length) {
      const updated = await this.database.sql`
        UPDATE securities SET identity_status='identity_not_found',
          identity_evidence=${this.database.sql.json(json({ openFigi: figi }))},
          revision=revision+1,updated_at=now()
        WHERE id=${securityId} AND revision=${security.revision} AND NOT selection_locked
        RETURNING id`;
      if (!updated.length) return;
      await this.state(securityId, "selection", "not_found", {
        message: "No exact-ISIN EODHD listing found",
        metadata: {
          openFigi: figi,
          resolutionReason: "exact_isin_not_found",
        },
      });
      return;
    }
    const selected = this.automaticMapping(
      mappings,
      security.preferredMappingId,
    );
    const updated = await this.database.sql`
      UPDATE securities SET identity_status='identity_resolved',
        identity_evidence=${this.database.sql.json(json({ source: "eodhd_exact_isin", openFigi: figi }))},
        preferred_mapping_id=${selected?.id ?? null},selection_locked=false,
        revision=revision+1,updated_at=now()
      WHERE id=${securityId} AND revision=${security.revision} AND NOT selection_locked
      RETURNING id`;
    if (!updated.length) return;
    await this.state(
      securityId,
      "selection",
      selected ? "selected" : "selection_required",
      {
        success: !!selected,
        message: selected ? null : "Listing selection required",
        metadata: {
          resolutionReason: selected ? null : "listing_selection_required",
        },
      },
    );
    if (selected)
      await enqueueMarketDataJob(
        this.database.sql,
        securityId,
        "backfill_history",
        security.revision + 1,
      );
  }

  private async selected(securityId: string, expectedRevision?: number | null) {
    const security = await this.security(securityId);
    if (
      expectedRevision !== null &&
      expectedRevision !== undefined &&
      security.revision !== expectedRevision
    )
      throw new ConflictError("The market-data selection changed.");
    if (!security.preferredMappingId)
      throw new ConflictError("Choose a verified valuation listing first.");
    const mapping = await this.mapping(security.preferredMappingId);
    if (
      mapping.securityId !== securityId ||
      mapping.verificationStatus !== "verified" ||
      !mapping.active ||
      mapping.verificationRevision !== security.verificationRevision
    )
      throw new ConflictError("The selected mapping is no longer verified.");
    return { security, mapping };
  }

  private async storeBars(mapping: MappingRow, bars: EodBar[]) {
    for (let offset = 0; offset < bars.length; offset += 500) {
      const rows = bars.slice(offset, offset + 500).map((bar) => ({
        mapping_id: mapping.id,
        kind: "eod",
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        adjusted_close: bar.adjustedClose,
        volume: bar.volume,
        currency: mapping.quoteCurrency,
        unit_multiplier: mapping.unitMultiplier,
        market_date: bar.date,
        time_precision: "date",
        adjustment_basis: "raw",
        metadata: {},
      }));
      if (rows.length)
        await this.database.sql`
          INSERT INTO market_prices ${this.database.sql(rows as never)}
          ON CONFLICT(mapping_id,kind,market_date,adjustment_basis) DO UPDATE SET
            open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,
            adjusted_close=excluded.adjusted_close,volume=excluded.volume,currency=excluded.currency,
            unit_multiplier=excluded.unit_multiplier,fetched_at=now(),metadata=excluded.metadata`;
    }
  }

  private isFresh(date: string) {
    let expected = new Date();
    expected.setUTCDate(expected.getUTCDate() - 1);
    let weekdays = 0;
    while (date < expected.toISOString().slice(0, 10) && weekdays < 4) {
      const day = expected.getUTCDay();
      if (day !== 0 && day !== 6) weekdays++;
      expected.setUTCDate(expected.getUTCDate() - 1);
    }
    return weekdays <= 3;
  }

  private nextDailyRefresh() {
    const next = new Date();
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(6, 0, 0, 0);
    while (next.getUTCDay() === 0 || next.getUTCDay() === 6)
      next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }

  private async refreshLatest(securityId: string, revision: number | null) {
    const { mapping } = await this.selected(securityId, revision);
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 10 * 86400000)
      .toISOString()
      .slice(0, 10);
    const bars = await this.eodhd.daily(mapping.providerSymbol, from, to);
    if (!bars.length) {
      await this.state(securityId, "latest_price", "price_missing", {
        provider: "eodhd",
        message: "EODHD returned no completed daily bar.",
      });
      return;
    }
    await this.storeBars(mapping, bars);
    const latest = bars.at(-1)!;
    const actionDate = this.corporateActionDate(bars);
    if (actionDate)
      await this.state(securityId, "history", "history_partial", {
        provider: "eodhd",
        errorClass: "corporate_action_review",
        message: `A possible quantity-changing corporate action needs review from ${actionDate}.`,
        metadata: { corporateActionDate: actionDate },
      });
    await this.state(
      securityId,
      "latest_price",
      this.isFresh(latest.date) ? "price_current" : "price_stale",
      {
        provider: "eodhd",
        success: true,
        metadata: { marketDate: latest.date, timePrecision: "date" },
      },
    );
  }

  private async historyStart(securityId: string) {
    const [row] = await this.database.sql<{ earliest: Date | null }[]>`
      SELECT min(at) AS earliest FROM (
        SELECT t.occurred_at AS at FROM transactions t JOIN assets a ON a.id=t.asset_id
        WHERE a.security_id=${securityId} AND NOT t.is_voided
        UNION ALL
        SELECT h.observed_at AS at FROM holding_observations h JOIN assets a ON a.id=h.asset_id
        WHERE a.security_id=${securityId}
      ) dates`;
    return (row?.earliest ?? new Date(Date.now() - 365 * 86400000))
      .toISOString()
      .slice(0, 10);
  }

  private corporateActionDate(bars: EodBar[]) {
    let previous: Decimal | null = null;
    for (const bar of bars) {
      if (!bar.adjustedClose || new Decimal(bar.adjustedClose).isZero())
        continue;
      const ratio = new Decimal(bar.close).div(bar.adjustedClose);
      if (previous && ratio.minus(previous).abs().div(previous).gt("0.10"))
        return bar.date;
      previous = ratio;
    }
    return null;
  }

  private async backfillHistory(securityId: string, revision: number | null) {
    const { mapping } = await this.selected(securityId, revision);
    const from = await this.historyStart(securityId);
    const to = new Date().toISOString().slice(0, 10);
    const bars = await this.eodhd.daily(mapping.providerSymbol, from, to);
    await this.storeBars(mapping, bars);
    const actionDate = this.corporateActionDate(bars);
    const latest = bars.at(-1);
    if (latest)
      await this.state(
        securityId,
        "latest_price",
        this.isFresh(latest.date) ? "price_current" : "price_stale",
        {
          provider: "eodhd",
          success: true,
          metadata: { marketDate: latest.date, timePrecision: "date" },
        },
      );
    else
      await this.state(securityId, "latest_price", "price_missing", {
        provider: "eodhd",
        message: "EODHD returned no completed daily bar.",
      });
    await this.state(
      securityId,
      "history",
      actionDate
        ? "history_partial"
        : bars.length
          ? "history_ready"
          : "history_missing",
      {
        provider: "eodhd",
        success: bars.length > 0,
        errorClass: actionDate ? "corporate_action_review" : null,
        message: actionDate
          ? `A possible quantity-changing corporate action needs review from ${actionDate}.`
          : bars.length
            ? null
            : "No daily history was returned.",
        metadata: {
          from,
          to,
          rows: bars.length,
          corporateActionDate: actionDate,
        },
      },
    );
    await enqueueMarketDataJob(
      this.database.sql,
      securityId,
      "refresh_latest",
      revision ?? undefined,
      this.nextDailyRefresh(),
    );
  }

  private retryDelay(attempts: number) {
    return Math.min(86400000, 60000 * 5 ** Math.min(attempts, 5));
  }

  private async failJob(job: JobRow, error: unknown) {
    const provider =
      error instanceof MarketProviderError
        ? error
        : new MarketProviderError(
            "provider_unavailable",
            "Market-data processing failed and will be retried.",
          );
    const retryable = ![
      "configuration_error",
      "authentication_error",
      "not_entitled",
      "invalid_provider_data",
    ].includes(provider.failure);
    const next =
      provider.retryAt ?? new Date(Date.now() + this.retryDelay(job.attempts));
    if (retryable && !provider.retryAt) provider.retryAt = next;
    const selectionQuota =
      job.jobType === "resolve" && provider.failure === "quota_exhausted";
    await this.database.sql`
      UPDATE market_data_jobs SET status=${retryable ? "queued" : "failed"},
        next_attempt_at=${next},lease_until=NULL,
        failure=${this.database.sql.json(json({ errorClass: provider.failure, message: provider.message, providerCode: provider.providerCode }))},
        finished_at=${retryable ? null : new Date()},updated_at=now() WHERE id=${job.id}`;
    const stage =
      job.jobType === "resolve"
        ? "selection"
        : job.jobType === "refresh_latest"
          ? "latest_price"
          : "history";
    if (job.jobType === "backfill_history") {
      const [existing] = await this.database.sql<
        {
          errorClass: string | null;
          message: string | null;
          metadata: Record<string, unknown>;
        }[]
      >`
        SELECT error_class,message,metadata FROM market_data_state
        WHERE security_id=${job.securityId} AND stage='history'`;
      if (existing?.errorClass === "corporate_action_review") {
        await this.state(job.securityId, stage, "history_partial", {
          errorClass: existing.errorClass,
          provider: "eodhd",
          message: existing.message,
          nextRetryAt: retryable ? next : null,
          metadata: existing.metadata,
        });
        if (provider.failure === "quota_exhausted")
          await this.deferQueuedForQuota(next);
        return provider;
      }
    }
    await this.state(
      job.securityId,
      stage,
      selectionQuota
        ? "verification_delayed"
        : job.jobType === "refresh_latest"
          ? "price_stale"
          : job.jobType === "backfill_history"
            ? "history_partial"
            : "selection_pending",
      {
        errorClass: provider.failure,
        provider: "eodhd",
        providerCode: provider.providerCode,
        message: selectionQuota
          ? "Verification delayed until EODHD quota resets"
          : provider.message,
        nextRetryAt: retryable ? next : null,
        metadata: selectionQuota
          ? { resolutionReason: "verification_quota_delayed" }
          : {},
      },
    );
    if (provider.failure === "quota_exhausted")
      await this.deferQueuedForQuota(next);
    return provider;
  }

  private async deferQueuedForQuota(retryAt: Date) {
    await this.database.sql`
      UPDATE market_data_jobs SET next_attempt_at=greatest(next_attempt_at,${retryAt}),updated_at=now()
      WHERE status='queued' AND next_attempt_at<${retryAt}`;
    await this.database.sql`
      INSERT INTO market_data_state(
        security_id,stage,status,error_class,provider,message,last_attempt_at,next_retry_at,metadata
      )
      SELECT DISTINCT j.security_id,'selection','verification_delayed','quota_exhausted','eodhd',
        'Verification delayed until EODHD quota resets',now(),${retryAt},
        '{"resolutionReason":"verification_quota_delayed"}'::jsonb
      FROM market_data_jobs j WHERE j.status='queued' AND j.job_type='resolve'
      ON CONFLICT(security_id,stage) DO UPDATE SET
        status='verification_delayed',error_class='quota_exhausted',provider='eodhd',
        message='Verification delayed until EODHD quota resets',last_attempt_at=now(),
        next_retry_at=${retryAt},metadata=excluded.metadata,updated_at=now()`;
  }

  private async run(job: JobRow, figi?: OpenFigiEvidence[]) {
    try {
      if (job.jobType === "resolve") await this.resolve(job.securityId, figi);
      else if (job.jobType === "refresh_latest")
        await this.refreshLatest(job.securityId, job.mappingRevision);
      else await this.backfillHistory(job.securityId, job.mappingRevision);
      await this.database.sql`
        UPDATE market_data_jobs SET status='completed',lease_until=NULL,failure=NULL,
          finished_at=now(),updated_at=now() WHERE id=${job.id}`;
      if (job.jobType === "refresh_latest")
        await enqueueMarketDataJob(
          this.database.sql,
          job.securityId,
          "refresh_latest",
          (await this.security(job.securityId)).revision,
          this.nextDailyRefresh(),
        );
      return null;
    } catch (error) {
      if (error instanceof ConflictError) {
        await this.database.sql`
          UPDATE market_data_jobs SET status='completed',lease_until=NULL,
            failure=${this.database.sql.json(json({ errorClass: "stale_revision", message: error.message }))},finished_at=now(),updated_at=now()
          WHERE id=${job.id}`;
        return null;
      }
      return this.failJob(job, error);
    }
  }

  async runDue(limit = this.config.MARKET_DATA_MAX_CONCURRENCY) {
    const blockedUntil = await this.eodhdGate.blockedUntil();
    if (blockedUntil) await this.deferQueuedForQuota(blockedUntil);
    const [resolveDue] = await this.database.sql`
      SELECT id FROM market_data_jobs
      WHERE status='queued' AND job_type='resolve' AND next_attempt_at<=now()
      LIMIT 1`;
    const leaseOwner = resolveDue ? randomUUID() : null;
    const canClaimResolve = leaseOwner
      ? ((await this.eodhdGate.claimDiscoveryLease?.(leaseOwner)) ?? true)
      : false;
    const jobs = await this.database.sql.begin(async (tx) => {
      await tx`
        UPDATE market_data_jobs SET status='queued',lease_until=NULL,updated_at=now()
        WHERE status='running' AND lease_until<now()`;
      return tx<JobRow[]>`
        WITH due AS (
          SELECT j.id,s.isin FROM market_data_jobs j
          JOIN securities s ON s.id=j.security_id
          WHERE j.status='queued' AND j.next_attempt_at<=now()
            AND (j.job_type<>'resolve' OR ${canClaimResolve})
          ORDER BY CASE j.job_type WHEN 'resolve' THEN 0 WHEN 'backfill_history' THEN 1 ELSE 2 END,
            s.isin,j.id
          FOR UPDATE SKIP LOCKED LIMIT ${limit}
        )
        UPDATE market_data_jobs j SET status='running',attempts=attempts+1,
          lease_until=now()+interval '2 minutes',updated_at=now()
        FROM due WHERE j.id=due.id RETURNING j.*,due.isin`;
    });
    const priority: Record<JobType, number> = {
      resolve: 0,
      backfill_history: 1,
      refresh_latest: 2,
    };
    jobs.sort(
      (left, right) =>
        priority[left.jobType] - priority[right.jobType] ||
        left.isin.localeCompare(right.isin) ||
        left.id.localeCompare(right.id),
    );
    if (!jobs.length) {
      if (leaseOwner) await this.eodhdGate.releaseDiscoveryLease?.(leaseOwner);
      return 0;
    }
    const resolveJobs = jobs.filter((job) => job.jobType === "resolve");
    const needsEvidence: JobRow[] = [];
    for (const job of resolveJobs) {
      const security = await this.security(job.securityId);
      if (
        !security.selectionLocked &&
        !(await this.reusableMappings(security)).length
      )
        needsEvidence.push(job);
    }
    let evidence = new Map<string, OpenFigiEvidence[]>();
    if (needsEvidence.length)
      try {
        const securities = await Promise.all(
          needsEvidence.map((job) => this.security(job.securityId)),
        );
        evidence = await this.openFigi.mapIsins(
          securities.map((security) => security.isin),
        );
      } catch (error) {
        if (!(error instanceof MarketProviderError)) {
          if (leaseOwner)
            await this.eodhdGate.releaseDiscoveryLease?.(leaseOwner);
          throw error;
        }
      }
    for (let index = 0; index < resolveJobs.length; index++) {
      const job = resolveJobs[index]!;
      const security = await this.security(job.securityId);
      const failure = await this.run(job, evidence.get(security.isin));
      if (failure?.failure === "quota_exhausted") {
        const remaining = jobs.filter(
          (candidate) =>
            candidate.id !== job.id &&
            !resolveJobs
              .slice(0, index)
              .some((done) => done.id === candidate.id),
        );
        if (remaining.length)
          await this.database.sql`
            UPDATE market_data_jobs SET status='queued',lease_until=NULL,
              next_attempt_at=greatest(next_attempt_at,${failure.retryAt!}),updated_at=now()
            WHERE id IN ${this.database.sql(remaining.map((item) => item.id))}`;
        if (leaseOwner)
          await this.eodhdGate.releaseDiscoveryLease?.(leaseOwner);
        return jobs.length;
      }
    }
    await Promise.all(
      jobs
        .filter((job) => job.jobType !== "resolve")
        .map((job) => this.run(job)),
    );
    if (leaseOwner) await this.eodhdGate.releaseDiscoveryLease?.(leaseOwner);
    return jobs.length;
  }

  async list(needsReview = false) {
    return this.database.sql`
      SELECT s.id,s.isin,s.name,s.asset_type,s.identity_status,s.selection_locked,s.revision,
        coalesce(selection.status,'selection_pending') AS selection_status,
        coalesce(price.status,'price_pending') AS price_status,
        coalesce(history.status,'history_pending') AS history_status,
        coalesce(selection.message,price.message,history.message) AS message,
        selection.metadata->>'resolutionReason' AS resolution_reason,
        selection.next_retry_at,
        latest.market_date,latest.close,latest.currency,
        count(DISTINCT a.id)::integer AS asset_count
      FROM securities s
      LEFT JOIN assets a ON a.security_id=s.id
      LEFT JOIN market_data_state selection ON selection.security_id=s.id AND selection.stage='selection'
      LEFT JOIN market_data_state price ON price.security_id=s.id AND price.stage='latest_price'
      LEFT JOIN market_data_state history ON history.security_id=s.id AND history.stage='history'
      LEFT JOIN LATERAL (
        SELECT p.market_date,p.close,p.currency FROM market_prices p
        JOIN provider_mappings m ON m.id=p.mapping_id
        WHERE m.id=s.preferred_mapping_id ORDER BY p.market_date DESC LIMIT 1
      ) latest ON true
      WHERE EXISTS(
        SELECT 1 FROM assets held WHERE held.security_id=s.id AND (
          EXISTS(SELECT 1 FROM transactions t WHERE t.asset_id=held.id AND NOT t.is_voided)
          OR EXISTS(SELECT 1 FROM holding_observations h WHERE h.asset_id=held.id)
        )
      )
      ${needsReview ? this.database.sql`AND (s.identity_status<>'identity_resolved' OR s.preferred_mapping_id IS NULL OR coalesce(price.status,'price_pending') IN ('price_missing','price_stale'))` : this.database.sql``}
      GROUP BY s.id,selection.status,price.status,history.status,selection.message,price.message,history.message,
        selection.metadata,selection.next_retry_at,
        latest.market_date,latest.close,latest.currency
      ORDER BY s.name,s.isin`;
  }

  async detail(id: string) {
    const security = await this.security(id);
    const [states, mappings, latest] = await Promise.all([
      this.database
        .sql`SELECT * FROM market_data_state WHERE security_id=${id} ORDER BY stage`,
      this.database.sql`
        SELECT m.id,m.provider,m.provider_symbol,m.provider_exchange,m.verification_status,m.evidence,m.revision,
          m.verification_revision,
          l.ticker,l.mic,l.name,l.quote_currency,l.quote_unit,l.unit_multiplier,l.timezone,l.active,
          (m.id=${security.preferredMappingId}) AS selected,
          (m.verification_status='verified' AND l.active
            AND m.verification_revision=${security.verificationRevision}) AS selectable
        FROM provider_mappings m JOIN security_listings l ON l.id=m.listing_id
        WHERE l.security_id=${id} ORDER BY selected DESC,(m.evidence->>'isPrimary')::boolean DESC,m.provider_symbol`,
      this.database.sql`
        SELECT p.* FROM market_prices p
        WHERE p.mapping_id=${security.preferredMappingId}
        ORDER BY p.market_date DESC LIMIT 1`,
    ]);
    const selection = states.find(
      (state) => (state as { stage?: unknown }).stage === "selection",
    ) as
      | { metadata?: { resolutionReason?: string }; nextRetryAt?: Date }
      | undefined;
    return {
      ...security,
      resolutionReason: selection?.metadata?.resolutionReason ?? null,
      nextRetryAt: selection?.nextRetryAt ?? null,
      states,
      mappings,
      latestPrice: latest[0] ?? null,
    };
  }

  async select(id: string, mappingId: string | null, expectedRevision: number) {
    await this.database.sql.begin(async (tx) => {
      const [security] = await tx<SecurityRow[]>`
        SELECT * FROM securities WHERE id=${id} FOR UPDATE`;
      if (!security) throw new NotFoundError("Security not found");
      if (security.revision !== expectedRevision)
        throw new ConflictError(
          "The market-data selection changed. Reload it.",
        );
      if (mappingId) {
        const [mapping] = await tx`
          SELECT m.id FROM provider_mappings m JOIN security_listings l ON l.id=m.listing_id
          WHERE m.id=${mappingId} AND l.security_id=${id} AND l.active
            AND m.verification_status='verified'
            AND m.verification_revision=${security.verificationRevision}`;
        if (!mapping)
          throw new ConflictError("Choose a verified listing for this ISIN.");
      }
      let selectedId = mappingId;
      if (!mappingId) {
        const mappings = await tx<MappingRow[]>`
          SELECT m.*,l.security_id,l.quote_currency,l.unit_multiplier,l.ticker,l.mic,l.name,l.active
          FROM provider_mappings m JOIN security_listings l ON l.id=m.listing_id
          WHERE l.security_id=${id} AND l.active
            AND m.verification_status='verified'
            AND m.verification_revision=${security.verificationRevision}
          ORDER BY (m.evidence->>'isPrimary')::boolean DESC,m.provider_symbol`;
        selectedId =
          this.automaticMapping(mappings, security.preferredMappingId)?.id ??
          null;
      }
      await tx`
        UPDATE securities SET preferred_mapping_id=${selectedId},selection_locked=${!!mappingId},
          revision=revision+1,updated_at=now() WHERE id=${id}`;
      const status = selectedId ? "selected" : "selection_required";
      const message = selectedId ? null : "Listing selection required";
      await tx`
        INSERT INTO market_data_state(
          security_id,stage,status,message,last_attempt_at,last_success_at,metadata
        ) VALUES(
          ${id},'selection',${status},${message},now(),
          ${selectedId ? new Date() : null},
          ${tx.json(json({ resolutionReason: selectedId ? null : "listing_selection_required" }))}
        )
        ON CONFLICT(security_id,stage) DO UPDATE SET
          status=excluded.status,error_class=NULL,provider_code=NULL,message=excluded.message,
          last_attempt_at=now(),last_success_at=excluded.last_success_at,
          next_retry_at=NULL,metadata=excluded.metadata,updated_at=now()`;
      await tx`DELETE FROM market_data_jobs WHERE security_id=${id} AND status IN ('queued','running')`;
      if (selectedId && selectedId !== security.preferredMappingId) {
        await enqueueMarketDataJob(
          tx,
          id,
          "backfill_history",
          expectedRevision + 1,
        );
      } else if (selectedId) {
        await enqueueMarketDataJob(
          tx,
          id,
          "refresh_latest",
          expectedRevision + 1,
          this.nextDailyRefresh(),
        );
      }
    });
    return this.detail(id);
  }

  async refresh(id: string) {
    const security = await this.security(id);
    await this.selected(id, security.revision);
    const queued = await enqueueMarketDataJob(
      this.database.sql,
      id,
      "refresh_latest",
      security.revision,
    );
    return { queued, securityId: id };
  }

  async reResolve(id: string, expectedRevision: number) {
    await this.database.sql.begin(async (tx) => {
      const [security] = await tx<SecurityRow[]>`
        SELECT * FROM securities WHERE id=${id} FOR UPDATE`;
      if (!security) throw new NotFoundError("Security not found");
      if (security.revision !== expectedRevision)
        throw new ConflictError(
          "The market-data selection changed. Reload it.",
        );
      if (security.selectionLocked)
        throw new ConflictError(
          "Return the listing to automatic selection before re-resolving it.",
        );
      await tx`
        UPDATE securities SET identity_status='identity_pending',
          verification_revision=verification_revision+1,revision=revision+1,updated_at=now()
        WHERE id=${id}`;
      await tx`
        INSERT INTO market_data_state(security_id,stage,status,message,last_attempt_at,metadata)
        VALUES(${id},'selection','selection_pending','Listing verification is queued.',now(),'{}')
        ON CONFLICT(security_id,stage) DO UPDATE SET
          status='selection_pending',error_class=NULL,provider=NULL,provider_code=NULL,
          message='Listing verification is queued.',last_attempt_at=now(),next_retry_at=NULL,
          metadata='{}',updated_at=now()`;
      await tx`DELETE FROM market_data_jobs WHERE security_id=${id} AND status IN ('queued','running')`;
      await enqueueMarketDataJob(tx, id, "resolve", expectedRevision + 1);
    });
    return this.detail(id);
  }

  async diagnostics() {
    const [row] = await this.database.sql<
      { queued: number; running: number; failed: number }[]
    >`
      SELECT count(*) FILTER(WHERE status='queued')::integer AS queued,
        count(*) FILTER(WHERE status='running')::integer AS running,
        count(*) FILTER(WHERE status='failed')::integer AS failed
      FROM market_data_jobs`;
    return row ?? { queued: 0, running: 0, failed: 0 };
  }
}
