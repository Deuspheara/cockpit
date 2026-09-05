import { describe, expect, it, vi } from "vitest";
import { AssetLogoService } from "../src/modules/assets/logos.js";
import type { Asset } from "../src/modules/assets/service.js";
import { readConfig } from "../src/config.js";

const asset = (overrides: Partial<Asset> = {}): Asset => ({
  id: "a",
  assetType: "crypto",
  symbol: "BTC",
  name: "Bitcoin",
  quoteCurrency: "USD",
  chain: null,
  contractAddress: null,
  externalIds: {},
  ...overrides,
});
const btc = {
  id: "btc-bitcoin",
  symbol: "BTC",
  name: "Bitcoin",
  is_active: true,
};
const logo = "https://static.coinpaprika.com/coin/btc-bitcoin/logo.png";
function upstream(coins = [btc]) {
  return vi.fn<typeof fetch>(async (url) =>
    Response.json(
      String(url).endsWith("/coins") ? coins : { id: "btc-bitcoin", logo },
    ),
  );
}

describe("asset logos", () => {
  it("resolves crypto and shares 24-hour metadata across accounts", async () => {
    const request = upstream();
    let now = 0;
    const service = new AssetLogoService("", request, () => now);
    const results = await service.resolveAll([
      asset(),
      asset({ id: "b" }),
      asset(),
    ]);
    expect([...results.values()]).toEqual([logo, logo]);
    expect(request).toHaveBeenCalledTimes(2);
    now = 86_399_000;
    expect(await service.resolve(asset())).toBe(logo);
    expect(request).toHaveBeenCalledTimes(2);
    now = 86_400_001;
    expect(await service.resolve(asset())).toBe(logo);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("does not pick the most popular coin for an ambiguous ticker", async () => {
    const request = upstream([
      btc,
      { ...btc, id: "btc-another", name: "Another" },
    ]);
    const service = new AssetLogoService("", request);
    expect(await service.resolve(asset({ name: "BTC" }))).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(await service.resolve(asset())).toBe(logo);
  });

  it("uses an explicit coin ID and refuses conflicting identity or contract guesses", async () => {
    const request = upstream();
    const service = new AssetLogoService("", request);
    expect(
      await service.resolve(
        asset({ name: "Unknown", externalIds: { coinpaprika: btc.id } }),
      ),
    ).toBe(logo);
    expect(
      await service.resolve(asset({ externalIds: { coinpaprika: "not-btc" } })),
    ).toBeNull();
    expect(
      await service.resolve(asset({ contractAddress: "0x123" })),
    ).toBeNull();
    expect(await service.resolve(asset({ name: "Bitcoin Cash" }))).toBeNull();
  });

  it("recognizes provider perpetual symbols without changing the asset", async () => {
    const service = new AssetLogoService(
      "",
      upstream([btc, { ...btc, id: "btc-another", name: "Another" }]),
    );
    expect(
      await service.resolve(
        asset({
          assetType: "perp",
          symbol: "BTC-USD",
          name: "BTC-USD perpetual",
        }),
      ),
    ).toBe(logo);
    expect(
      await service.resolve(
        asset({ assetType: "perp", symbol: "BTC", name: "BTC perpetual" }),
      ),
    ).toBe(logo);
  });

  it.each(["equity", "etf"])(
    "prefers ISIN for %s and requests real images only",
    async (assetType) => {
      const request = upstream();
      const service = new AssetLogoService("pk_example", request);
      const result = new URL(
        (await service.resolve(
          asset({
            assetType,
            symbol: "WRONG.PA",
            externalIds: { isin: "FR0013412285" },
          }),
        ))!,
      );
      expect(result.pathname).toBe("/isin/FR0013412285");
      expect(result.searchParams.get("token")).toBe("pk_example");
      expect(result.searchParams.get("fallback")).toBe("404");
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("uses exchange-qualified tickers and explicit US exchanges, never currency as identity", async () => {
    const service = new AssetLogoService("pk_example", upstream());
    const stock = asset({ assetType: "equity", symbol: "AIR.PA" });
    expect(new URL((await service.resolve(stock))!).pathname).toBe(
      "/ticker/AIR.PA",
    );
    expect(await service.resolve({ ...stock, symbol: "AIR" })).toBeNull();
    expect(
      new URL(
        (await service.resolve({
          ...stock,
          symbol: "AAPL",
          externalIds: { exchange: "NASDAQ" },
        }))!,
      ).pathname,
    ).toBe("/ticker/AAPL");
  });

  it("keeps unsupported and missing-key assets usable without requests", async () => {
    const request = upstream();
    const service = new AssetLogoService("", request);
    for (const assetType of ["equity", "etf", "cash", "other"]) {
      expect(await service.resolve(asset({ assetType }))).toBeNull();
    }
    expect(request).not.toHaveBeenCalled();
    expect(
      readConfig({
        DATABASE_URL: "postgres://localhost/test",
        REDIS_URL: "redis://localhost",
      }).LOGO_DEV_PUBLISHABLE_KEY,
    ).toBe("");
  });

  it.each([404, 429, 500])(
    "returns a fallback on provider HTTP %s",
    async (status) => {
      const request = vi.fn<typeof fetch>(
        async () => new Response(null, { status }),
      );
      expect(
        await new AssetLogoService("", request).resolve(asset()),
      ).toBeNull();
    },
  );

  it("handles network failure, bad metadata, and untrusted image URLs", async () => {
    const offline = vi.fn<typeof fetch>(async () => {
      throw new Error("offline");
    });
    expect(await new AssetLogoService("", offline).resolve(asset())).toBeNull();
    const badJSON = vi.fn<typeof fetch>(async () =>
      Response.json({ unexpected: true }),
    );
    expect(await new AssetLogoService("", badJSON).resolve(asset())).toBeNull();
    const request = vi.fn<typeof fetch>(async (url) =>
      Response.json(
        String(url).endsWith("/coins")
          ? [btc]
          : { id: btc.id, logo: "http://localhost/private" },
      ),
    );
    expect(await new AssetLogoService("", request).resolve(asset())).toBeNull();
  });

  it("cools down provider failures and retries after a minute", async () => {
    let now = 0;
    const request = upstream();
    request.mockRejectedValueOnce(new Error("offline"));
    const service = new AssetLogoService("", request, () => now);
    expect(await service.resolve(asset())).toBeNull();
    expect(await service.resolve(asset({ id: "another-account" }))).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    now = 60_001;
    expect(await service.resolve(asset())).toBe(logo);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("aborts cold lookups without losing rows", async () => {
    const request = vi.fn<typeof fetch>(
      async (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("timeout")),
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const result = new AssetLogoService("", request).resolve(
      asset(),
      controller.signal,
    );
    controller.abort();
    expect(await result).toBeNull();
  });
});
