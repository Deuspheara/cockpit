import { z } from "zod";
import type { Database } from "../../../db/index.js";
import { Decimal, money } from "../../../shared/decimal.js";
import { AppError } from "../../../shared/errors.js";
import type { Coverage, ValuationIssue } from "../../portfolio/coverage.js";
import { providerDecimal } from "../types.js";
import type { Fetch } from "../http.js";
const DAY = 86400000;
const NETWORK = "base-mainnet";
const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v.toLowerCase());
const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);
const blockSchema = z.object({ number: hex, timestamp: hex });
interface Cursor {
  direction?: number;
  pageKey?: string;
  tokens?: string[];
  endBlock?: string;
  nextDay?: number;
  partial?: boolean;
}
export interface HistoryJob {
  id: string;
  accountId: string;
  status: string;
  phase: string;
  cursor: Cursor;
  endAt: Date;
  daysDone: number;
  requestsUsed: number;
  nextAttemptAt: Date;
  error: string | null;
}
class Pause extends Error {
  constructor(
    readonly reason: string,
    readonly delay: number,
  ) {
    super(reason);
  }
}
export class EVMHistoryService {
  constructor(
    private db: Database,
    private key: string,
    private transport: Fetch = fetch,
    private networks: string[] = [NETWORK],
  ) {}
  async status(accountId: string) {
    const [job] = await this.db.sql<
      HistoryJob[]
    >`SELECT *, CASE WHEN request_day=CURRENT_DATE THEN requests_used ELSE 0 END AS requests_used FROM evm_history_jobs WHERE account_id=${accountId}`;
    if (!job) return null;
    return {
      id: job.id,
      accountId: job.accountId,
      status: job.status,
      phase: job.phase,
      daysDone: job.daysDone,
      totalDays: 90,
      requestsUsed: job.requestsUsed,
      dailyRequestLimit: 1000,
      nextAttemptAt: job.nextAttemptAt,
      error: job.error,
    };
  }
  async enqueue(accountId: string, retry = false) {
    const [a] = await this.db
      .sql`SELECT source_type FROM accounts WHERE id=${accountId} AND NOT is_archived`;
    if (!a) throw new AppError("NOT_FOUND", "Account not found", 404);
    if (a.sourceType !== "evm_wallet")
      throw new AppError(
        "NOT_AVAILABLE",
        "Historical reconstruction is available for Base wallets",
        400,
      );
    if (!this.networks.includes(NETWORK))
      throw new AppError(
        "NOT_AVAILABLE",
        "Enable base-mainnet in ALCHEMY_NETWORKS to recover Base history",
        400,
      );
    if (!this.key)
      throw new AppError(
        "ALCHEMY_NOT_CONFIGURED",
        "Configure Alchemy on the server",
        503,
      );
    await this.db
      .sql`INSERT INTO evm_history_jobs(account_id) VALUES(${accountId}) ON CONFLICT(account_id) DO NOTHING`;
    if (retry)
      await this.db.sql.begin(async (tx) => {
        const [job] =
          await tx`SELECT status,phase FROM evm_history_jobs WHERE account_id=${accountId} FOR UPDATE`;
        if (!job || !["partial", "failed"].includes(String(job.status))) return;
        await tx`DELETE FROM evm_balance_history WHERE account_id=${accountId} AND issue IS NOT NULL`;
        await tx`UPDATE evm_history_jobs SET status='queued',error=NULL,next_attempt_at=now(),updated_at=now(),
        cursor=CASE WHEN phase='balances' THEN cursor || '{"nextDay":0,"partial":false}'::jsonb ELSE cursor END,
        days_done=CASE WHEN phase='balances' THEN 0 ELSE days_done END WHERE account_id=${accountId}`;
      });
    return this.status(accountId);
  }
  // Every HTTP attempt is charged durably, independent of the job's eventual success.
  private async request(job: HistoryJob, url: string, body: unknown) {
    const [budget] = await this.db.sql`UPDATE evm_history_jobs SET
      requests_used=CASE WHEN request_day=CURRENT_DATE THEN requests_used+1 ELSE 1 END,
      request_day=CURRENT_DATE,updated_at=now()
      WHERE id=${job.id} AND (request_day<>CURRENT_DATE OR requests_used<1000) RETURNING requests_used`;
    if (!budget)
      throw new Pause(
        "Daily request limit reached; resumes tomorrow",
        DAY - (Date.now() % DAY),
      );
    let response: Response;
    try {
      response = await this.transport(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Pause("Historical provider timed out; retry scheduled", 300000);
    }
    if (response.status === 429)
      throw new Pause(
        "Alchemy rate limit reached; retry scheduled",
        Math.max(
          300000,
          Math.min(
            3600000,
            Number(response.headers.get("retry-after") ?? 0) * 1000 || 0,
          ),
        ),
      );
    if (response.status === 401 || response.status === 403)
      throw new AppError(
        "ALCHEMY_AUTH_FAILED",
        "Alchemy denied historical access. Check server key permissions.",
        503,
      );
    if (response.status === 400 || response.status === 404)
      throw new AppError(
        "ALCHEMY_UNSUPPORTED",
        "Historical data is unavailable for this token",
        502,
      );
    if (!response.ok)
      throw new Pause(
        "Historical provider unavailable; retry scheduled",
        300000,
      );
    return (await response.json()) as unknown;
  }
  private async cached<T>(
    key: string,
    parse: (raw: unknown) => T,
    fetcher: () => Promise<unknown>,
    ttl = 180 * DAY,
  ): Promise<T> {
    const [row] = await this.db
      .sql`SELECT value FROM evm_history_cache WHERE key=${key} AND expires_at>now()`;
    if (row) return parse(row.value);
    const value = await fetcher();
    const parsed = parse(value);
    await this.db
      .sql`INSERT INTO evm_history_cache(key,value,expires_at) VALUES(${key},${this.db.sql.json(value as never)},${new Date(Date.now() + ttl)})
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at`;
    return parsed;
  }
  private async rpc(job: HistoryJob, method: string, params: unknown[]) {
    const data = z
      .object({ result: z.unknown().optional(), error: z.unknown().optional() })
      .parse(
        await this.request(
          job,
          `https://${NETWORK}.g.alchemy.com/v2/${encodeURIComponent(this.key)}`,
          { jsonrpc: "2.0", id: 1, method, params },
        ),
      );
    if (
      data.error &&
      typeof data.error === "object" &&
      "code" in data.error &&
      [429, -32005].includes(Number(data.error.code))
    )
      throw new Pause(
        "Alchemy RPC rate limit reached; retry scheduled",
        300000,
      );
    if (data.error || data.result === undefined)
      throw new AppError(
        "ALCHEMY_RPC_ERROR",
        "Historical chain state is unavailable",
        502,
      );
    return data.result;
  }
  private async block(job: HistoryJob, tag: string) {
    return this.cached(
      `block:${NETWORK}:${tag}`,
      (v) => blockSchema.parse(v),
      () => this.rpc(job, "eth_getBlockByNumber", [tag, false]),
      tag === "finalized" ? 60000 : 180 * DAY,
    );
  }
  private async blockAt(job: HistoryJob, at: Date) {
    return this.cached(
      `date-block:${NETWORK}:${at.toISOString()}`,
      (v) => hex.parse(v),
      async () => {
        const end = await this.block(job, "finalized");
        if (Number(BigInt(end.timestamp)) * 1000 < at.getTime())
          throw new Pause("Waiting for finalized chain state", 300000);
        let low = 0,
          high = Number(BigInt(end.number));
        while (low < high) {
          const mid = Math.ceil((low + high) / 2),
            b = await this.block(job, `0x${mid.toString(16)}`);
          if (Number(BigInt(b.timestamp)) * 1000 <= at.getTime()) low = mid;
          else high = mid - 1;
        }
        return `0x${low.toString(16)}`;
      },
    );
  }
  private async discover(job: HistoryJob, wallet: string) {
    const cursor = job.cursor;
    cursor.tokens ??= ["native"];
    cursor.direction ??= 0;
    cursor.endBlock ??= await this.blockAt(job, job.endAt);
    const response = z
      .object({
        transfers: z.array(
          z.object({
            rawContract: z
              .object({ address: z.string().nullable().optional() })
              .optional(),
            category: z.string(),
          }),
        ),
        pageKey: z.string().optional(),
      })
      .parse(
        await this.rpc(job, "alchemy_getAssetTransfers", [
          {
            fromBlock: "0x0",
            toBlock: cursor.endBlock,
            [cursor.direction === 0 ? "toAddress" : "fromAddress"]: wallet,
            category: ["external", "internal", "erc20"],
            excludeZeroValue: true,
            maxCount: "0x3e8",
            order: "desc",
            ...(cursor.pageKey ? { pageKey: cursor.pageKey } : {}),
          },
        ]),
      );
    const tokens = new Set(cursor.tokens);
    for (const t of response.transfers)
      if (t.category === "erc20")
        tokens.add(addressSchema.parse(t.rawContract?.address));
    if (response.pageKey && response.pageKey === cursor.pageKey)
      throw new AppError(
        "ALCHEMY_INVALID_RESPONSE",
        "Historical token discovery did not advance; retry available",
        502,
      );
    cursor.tokens = [...tokens].sort();
    cursor.pageKey = response.pageKey;
    if (!cursor.pageKey) cursor.direction++;
    await this.db
      .sql`UPDATE evm_history_jobs SET cursor=${this.db.sql.json(cursor as never)},phase=${cursor.direction >= 2 ? "balances" : "discovery"},status='queued',updated_at=now() WHERE id=${job.id}`;
  }
  private async quantity(
    job: HistoryJob,
    wallet: string,
    token: string,
    block: string,
  ) {
    return this.cached(
      `balance:${NETWORK}:${wallet}:${token}:${block}`,
      (v) => providerDecimal.parse(v),
      async () => {
        if (token === "native")
          return money(
            BigInt(
              hex.parse(await this.rpc(job, "eth_getBalance", [wallet, block])),
            ).toString() + "e-18",
          );
        const results = await Promise.allSettled([
          this.rpc(job, "eth_call", [
            {
              to: token,
              data: "0x70a08231" + wallet.slice(2).padStart(64, "0"),
            },
            block,
          ]),
          this.rpc(job, "eth_call", [{ to: token, data: "0x313ce567" }, block]),
        ]);
        for (const r of results) if (r.status === "rejected") throw r.reason;
        const [balance, decimals] = results.map((r) =>
          r.status === "fulfilled" ? r.value : undefined,
        );
        if (balance === "0x" && decimals === "0x") {
          const code = await this.rpc(job, "eth_getCode", [token, block]);
          if (code === "0x") return money(0);
        }
        const precision = Number(BigInt(hex.parse(decimals)));
        if (precision > 36) throw new Error("Invalid token decimals");
        return money(
          new Decimal(BigInt(hex.parse(balance)).toString()).div(
            new Decimal(10).pow(precision),
          ),
        );
      },
    );
  }
  private async price(job: HistoryJob, token: string, at: Date) {
    const day = at.toISOString().slice(0, 10);
    const schema = z.object({
      currency: z.literal("usd"),
      symbol: z.string().optional(),
      network: z.string().optional(),
      address: z.string().optional(),
      data: z.array(
        z.object({
          value: providerDecimal.refine((v) => new Decimal(v).gte(0)),
          timestamp: z.iso.datetime({ offset: true }),
        }),
      ),
    });
    const result = await this.cached(
      `history-price:${NETWORK}:${token}:${day}`,
      (v) => schema.parse(v),
      () =>
        this.request(
          job,
          `https://api.g.alchemy.com/prices/v1/${encodeURIComponent(this.key)}/tokens/historical`,
          {
            ...(token === "native"
              ? { symbol: "ETH" }
              : { network: NETWORK, address: token }),
            startTime: new Date(at.getTime() - DAY).toISOString(),
            endTime: at.toISOString(),
            interval: "1d",
          },
        ),
      6 * 3600000,
    );
    if (
      token === "native"
        ? result.symbol !== "ETH"
        : result.network !== NETWORK || result.address?.toLowerCase() !== token
    )
      throw new Error("Mismatched price identity");
    return result.data
      .filter(
        (p) =>
          Date.parse(p.timestamp) <= at.getTime() &&
          Date.parse(p.timestamp) > at.getTime() - DAY,
      )
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  }
  private async day(job: HistoryJob, wallet: string, otherNetworks: string[]) {
    const index = job.cursor.nextDay ?? 0,
      at = new Date(job.endAt.getTime() - index * DAY);
    const block = await this.blockAt(job, at),
      coverage: Coverage = { valued: [], missing: [] };
    let value = new Decimal(0),
      known = 0;
    // Process one token at a time: its two state calls are the concurrency ceiling.
    for (const token of job.cursor.tokens ?? ["native"]) {
      const [asset] = await this.db
        .sql`SELECT name FROM assets WHERE chain=${NETWORK} AND (${token}='native' AND contract_address IS NULL OR contract_address=${token}) LIMIT 1`;
      const name = String(
        asset?.name ?? (token === "native" ? "Ethereum" : token),
      );
      const issue = (code: string, message: string): ValuationIssue => ({
        code,
        accountId: job.accountId,
        name,
        network: NETWORK,
        contractAddress: token === "native" ? undefined : token,
        message,
        retryable: true,
      });
      let quantity: string | null = null,
        price: string | null = null,
        priceAt: string | null = null,
        error: string | null = null;
      const [saved] = await this.db.sql<
        {
          quantity: string | null;
          price: string | null;
          priceAt: Date | null;
          issue: string | null;
        }[]
      >`SELECT quantity,price,price_at,issue FROM evm_balance_history WHERE account_id=${job.accountId} AND network=${NETWORK} AND token=${token} AND at=${at}`;
      if (saved) {
        if (saved.quantity !== null && new Decimal(saved.quantity).isZero())
          known++;
        else if (saved.quantity !== null && saved.price !== null) {
          known++;
          value = value.plus(new Decimal(saved.quantity).mul(saved.price));
          coverage.valued.push(`${NETWORK}:${token}`);
        }
        if (saved.issue)
          coverage.missing.push(
            issue(
              saved.issue,
              saved.issue === "missing_balance"
                ? "Historical balance or token decimals unavailable"
                : "Historical token price unavailable",
            ),
          );
        continue;
      }
      try {
        quantity = await this.quantity(job, wallet, token, block);
      } catch (e) {
        if (
          e instanceof Pause ||
          (e instanceof AppError && e.code === "ALCHEMY_AUTH_FAILED")
        )
          throw e;
        error = "missing_balance";
        coverage.missing.push(
          issue(error, "Historical balance or token decimals unavailable"),
        );
      }
      if (quantity !== null) {
        if (new Decimal(quantity).isZero()) {
          known++;
        } else {
          try {
            const quote = await this.price(job, token, at);
            if (quote) {
              price = quote.value;
              priceAt = quote.timestamp;
            }
          } catch (e) {
            if (
              e instanceof Pause ||
              (e instanceof AppError && e.code === "ALCHEMY_AUTH_FAILED")
            )
              throw e;
          }
          if (price !== null) {
            value = value.plus(new Decimal(quantity).mul(price));
            known++;
            coverage.valued.push(`${NETWORK}:${token}`);
          } else {
            error = "missing_price";
            coverage.missing.push(
              issue(error, "Historical token price unavailable"),
            );
          }
        }
      }
      await this.db
        .sql`INSERT INTO evm_balance_history(account_id,network,token,at,block_number,quantity,price,price_at,issue)
        VALUES(${job.accountId},${NETWORK},${token},${at},${block},${quantity},${price},${priceAt},${error})
        ON CONFLICT(account_id,network,token,at) DO UPDATE SET quantity=excluded.quantity,price=excluded.price,price_at=excluded.price_at,issue=excluded.issue`;
    }
    for (const network of otherNetworks)
      coverage.missing.push({
        code: "missing_history",
        accountId: job.accountId,
        name: network,
        network,
        message: "Historical reconstruction currently covers Base only",
        retryable: false,
      });
    if (known === 0)
      coverage.missing.push({
        code: "missing_history",
        accountId: job.accountId,
        name: "Base wallet",
        network: NETWORK,
        message: "No historical balances could be valued",
        retryable: true,
      });
    if (known > 0)
      await this.db
        .sql`INSERT INTO evm_account_history(account_id,at,value,complete,coverage) VALUES(${job.accountId},${at},${money(value)},${coverage.missing.length === 0},${this.db.sql.json(coverage as never)})
      ON CONFLICT(account_id,at) DO UPDATE SET value=excluded.value,complete=excluded.complete,coverage=excluded.coverage`;
    const cursor = {
      ...job.cursor,
      nextDay: index + 1,
      partial: job.cursor.partial || coverage.missing.length > 0,
    };
    await this.db
      .sql`UPDATE evm_history_jobs SET cursor=${this.db.sql.json(cursor as never)},days_done=${index + 1},status=${index === 89 ? (cursor.partial ? "partial" : "complete") : "queued"},
      error=${index === 89 && cursor.partial ? "Some historical values remain unavailable; inspect coverage details" : null},updated_at=now() WHERE id=${job.id}`;
  }
  async runDue() {
    if (!this.key || !this.networks.includes(NETWORK)) return false;
    await this.db
      .sql`DELETE FROM evm_history_cache WHERE key IN (SELECT key FROM evm_history_cache WHERE expires_at<now() LIMIT 1000)`;
    // Seed existing wallets once. Jobs are never reset by normal synchronization.
    await this.db
      .sql`INSERT INTO evm_history_jobs(account_id) SELECT id FROM accounts WHERE source_type='evm_wallet' AND NOT is_archived AND metadata->>'demo' IS DISTINCT FROM 'true' AND metadata->>'syncDisabled' IS DISTINCT FROM 'true' ON CONFLICT(account_id) DO NOTHING`;
    const [job] = await this.db.sql<
      HistoryJob[]
    >`UPDATE evm_history_jobs SET status='running',updated_at=now() WHERE id=(
      SELECT j.id FROM evm_history_jobs j JOIN accounts a ON a.id=j.account_id WHERE NOT a.is_archived AND a.metadata->>'syncDisabled' IS DISTINCT FROM 'true' AND
      ((j.status IN ('queued','paused') AND j.next_attempt_at<=now()) OR (j.status='running' AND j.updated_at<now()-interval '15 minutes'))
      ORDER BY j.updated_at FOR UPDATE OF j SKIP LOCKED LIMIT 1) RETURNING *`;
    if (!job) return false;
    try {
      const [a] = await this.db
        .sql`SELECT external_address,metadata FROM accounts WHERE id=${job.accountId}`;
      const wallet = addressSchema.parse(a!.externalAddress);
      if (job.phase === "discovery") await this.discover(job, wallet);
      else
        await this.day(
          job,
          wallet,
          (
            (a!.metadata as { configuredNetworks?: string[] })
              .configuredNetworks ?? this.networks
          ).filter((n) => n !== NETWORK),
        );
    } catch (e) {
      const pause = e instanceof Pause;
      await this.db
        .sql`UPDATE evm_history_jobs SET status=${pause ? "paused" : "failed"},error=${pause ? e.reason : e instanceof AppError ? e.message : "Historical response could not be validated; retry reconstruction"},
        next_attempt_at=${new Date(Date.now() + (pause ? e.delay : 300000))},updated_at=now() WHERE id=${job.id}`;
    }
    return true;
  }
}
