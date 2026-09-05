import { createHash } from "node:crypto";
import { z } from "zod";
import type { Asset } from "./service.js";

const DAY = 86_400_000;
const coinSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  is_active: z.boolean(),
});
type Coin = z.infer<typeof coinSchema>;
// Canonical underlying identities for the standard perpetual markets we support.
// This is an identity map, not a popularity-based choice among duplicate tickers.
const perpetualCoinIDs: Record<string, string> = {
  btc: "btc-bitcoin",
  eth: "eth-ethereum",
  sol: "sol-solana",
  hype: "hype-hyperliquid",
};
const normalize = (value: string) => value.trim().toLowerCase();

// Identity metadata only: image bytes are fetched and cached by the device.
export class AssetLogoService {
  private cache = new Map<
    string,
    { expires: number; value: unknown; failed?: boolean }
  >();
  private pending = new Map<string, Promise<unknown>>();

  constructor(
    private publishableKey = "",
    private request: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  async resolveAll(assets: Asset[]): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    const queue = [...new Map(assets.map((a) => [a.id, a])).values()];
    const signal = AbortSignal.timeout(2500);
    // Bound both upstream concurrency and total cold-lookup time for the list.
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (let asset = queue.shift(); asset; asset = queue.shift()) {
          result.set(asset.id, await this.resolve(asset, signal));
        }
      }),
    );
    return result;
  }

  async resolve(
    asset: Asset,
    signal = AbortSignal.timeout(2500),
  ): Promise<string | null> {
    const key = createHash("sha256")
      .update(JSON.stringify([asset, this.publishableKey]))
      .digest("hex");
    try {
      return await this.memo<string | null>(key, async () => {
        if (["equity", "etf"].includes(asset.assetType)) {
          return this.securityLogo(asset);
        }
        if (!["crypto", "perp"].includes(asset.assetType)) return null;
        signal.throwIfAborted();
        const coins = await this.memo<Coin[]>("coinpaprika:coins", async () =>
          z.array(coinSchema).parse(await this.json("coins", signal)),
        );
        const symbol = normalize(
          asset.assetType === "perp"
            ? asset.symbol.replace(/-(USD|USDC|USDT)(-PERP)?$|-PERP$/i, "")
            : asset.symbol,
        );
        const explicitID =
          asset.externalIds.coinpaprika ??
          (asset.assetType === "perp" ? perpetualCoinIDs[symbol] : undefined);
        const candidates = coins.filter(
          (coin) => coin.is_active && normalize(coin.symbol) === symbol,
        );
        let coin: Coin | undefined;
        if (explicitID) {
          coin = candidates.find((candidate) => candidate.id === explicitID);
        } else {
          // Contract-backed tokens need an explicit provider ID: tickers and names
          // alone cannot distinguish a token from an impersonating contract.
          if (asset.contractAddress) return null;
          const named = candidates.filter(
            (candidate) => normalize(candidate.name) === normalize(asset.name),
          );
          if (named.length === 1) coin = named[0];
          else if (candidates.length === 1) {
            const generatedName = normalize(asset.name).replace(
              / perpetual$/,
              "",
            );
            if ([symbol, normalize(asset.symbol)].includes(generatedName)) {
              coin = candidates[0];
            }
          }
        }
        if (!coin) return null;
        return this.memo<string | null>(`coinpaprika:${coin.id}`, async () => {
          const detail = z
            .object({
              id: z.string(),
              logo: z.string().nullable().optional(),
            })
            .parse(
              await this.json(`coins/${encodeURIComponent(coin.id)}`, signal),
            );
          if (detail.id !== coin.id || !detail.logo) return null;
          const url = new URL(detail.logo);
          return url.protocol === "https:" &&
            url.hostname === "static.coinpaprika.com"
            ? url.href
            : null;
        });
      });
    } catch {
      // Enrichment must never turn a valid portfolio into an error response.
      return null;
    }
  }

  private securityLogo(asset: Asset): string | null {
    if (!this.publishableKey) return null;
    const isin = asset.externalIds.isin?.trim().toUpperCase();
    const ticker = (asset.externalIds.ticker ?? asset.symbol)
      .trim()
      .toUpperCase();
    const exchange = asset.externalIds.exchange?.trim().toUpperCase();
    let path: string;
    if (isin && /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin)) {
      path = `isin/${isin}`;
    } else if (
      /^[A-Z0-9-]+\.[A-Z]{1,3}$/.test(ticker) ||
      (["NASDAQ", "NYSE", "NYSEARCA", "AMEX", "XNAS", "XNYS", "ARCX"].includes(
        exchange ?? "",
      ) &&
        /^[A-Z0-9-]+$/.test(ticker))
    ) {
      path = `ticker/${encodeURIComponent(ticker)}`;
    } else {
      // An unqualified ticker otherwise defaults to US exchanges at Logo.dev.
      return null;
    }
    const url = new URL(`https://img.logo.dev/${path}`);
    url.search = new URLSearchParams({
      token: this.publishableKey,
      size: "108",
      format: "png",
      theme: "light",
      fallback: "404",
    }).toString();
    return url.href;
  }

  private async json(path: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const response = await this.request(
      `https://api.coinpaprika.com/v1/${path}`,
      {
        signal,
        headers: { Accept: "application/json" },
      },
    );
    if (!response.ok) throw new Error("Logo metadata unavailable");
    return response.json();
  }

  private async memo<T>(key: string, load: () => Promise<T>): Promise<T> {
    const saved = this.cache.get(key);
    if (saved && saved.expires > this.now()) {
      if (saved.failed) throw new Error("Logo provider is cooling down");
      return saved.value as T;
    }
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const work = load().then((value) => {
      if (this.cache.size >= 2000)
        this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { value, expires: this.now() + DAY });
      return value;
    });
    this.pending.set(key, work);
    try {
      return await work;
    } catch (error) {
      if (this.cache.size >= 2000)
        this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, {
        value: null,
        failed: true,
        expires: this.now() + 60_000,
      });
      throw error;
    } finally {
      this.pending.delete(key);
    }
  }
}
