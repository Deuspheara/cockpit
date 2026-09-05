import { z } from "zod";
import { Decimal, money } from "../../../shared/decimal.js";
import { AppError } from "../../../shared/errors.js";
import type { Account } from "../../accounts/schemas.js";
import { providerJSON, type Fetch } from "../http.js";
import {
  providerDecimal,
  emptySync,
  type ProviderSyncResult,
  type ProviderPosition,
} from "../types.js";
const networkSchema = z.enum(["eth-mainnet", "base-mainnet", "arb-mainnet"]);
const tokenSchema = z.object({
  network: networkSchema,
  tokenAddress: z.string().nullable(),
  tokenBalance: z.string().regex(/^0x[0-9a-fA-F]+$/),
  tokenMetadata: z
    .object({
      decimals: z.number().int().min(0).max(36),
      name: z.string().nullable(),
      symbol: z.string().nullable(),
    })
    .nullable(),
  tokenPrices: z
    .array(
      z.object({
        currency: z.string(),
        value: providerDecimal,
        lastUpdatedAt: z.string(),
      }),
    )
    .default([]),
  error: z.unknown().optional(),
});
const responseSchema = z.object({
  data: z.object({
    tokens: z.array(tokenSchema),
    pageKey: z.string().nullable().optional(),
  }),
  error: z
    .object({ partialErrors: z.array(z.object({ network: z.string() })) })
    .optional(),
});
export class AlchemyPortfolioAdapter {
  readonly kind = "evm_wallet";
  constructor(
    private apiKey: string,
    private networks: string[],
    private transport: Fetch = fetch,
  ) {}
  async syncAccount(account: Account): Promise<ProviderSyncResult> {
    if (!this.apiKey)
      throw new AppError(
        "NOT_CONFIGURED",
        "Configure ALCHEMY_API_KEY on the server to connect public wallets",
        503,
      );
    const networks = z.array(networkSchema).min(1).max(3).parse(this.networks);
    const results = await Promise.allSettled(
      networks.map(async (network) => {
        const positions: ProviderPosition[] = [];
        let pageKey: string | undefined;
        let complete = true;
        for (let page = 0; page < 20; page++) {
          const body = {
            addresses: [
              { address: account.externalAddress, networks: [network] },
            ],
            withMetadata: true,
            withPrices: true,
            includeNativeTokens: true,
            includeErc20Tokens: true,
            ...(pageKey ? { pageKey } : {}),
          };
          const response = responseSchema.parse(
            await providerJSON(
              `https://api.g.alchemy.com/data/v1/${encodeURIComponent(this.apiKey)}/assets/tokens/by-address`,
              body,
              this.transport,
            ),
          );
          if (response.error?.partialErrors.length)
            throw new Error("Network partially failed");
          for (const token of response.data.tokens) {
            if (token.network !== network)
              throw new Error("Unexpected network");
            if (!token.tokenMetadata || token.error) {
              complete = false;
              continue;
            }
            const quantity = money(
              new Decimal(BigInt(token.tokenBalance).toString()).div(
                new Decimal(10).pow(token.tokenMetadata.decimals),
              ),
            );
            const price = token.tokenPrices.find(
              (p) => p.currency.toLowerCase() === "usd",
            );
            const contract = token.tokenAddress?.toLowerCase();
            positions.push({
              asset: {
                key: `evm:${network}:${contract ?? "native"}`,
                symbol: token.tokenMetadata.symbol ?? contract ?? "Native",
                name: token.tokenMetadata.name ?? "Unknown token",
                assetType: "crypto",
                chain: network,
                contractAddress: contract,
              },
              scope: network,
              quantity,
              currency: "USD",
              unitPrice: price?.value,
              marketValue: price
                ? money(new Decimal(quantity).mul(price.value))
                : undefined,
              metadata: price
                ? { priceQuotedAt: price.lastUpdatedAt }
                : undefined,
            });
          }
          pageKey = response.data.pageKey ?? undefined;
          if (!pageKey) return { positions, complete };
        }
        throw new Error("Wallet pagination limit reached");
      }),
    );
    const result = emptySync();
    results.forEach((response, index) => {
      const network = networks[index]!;
      if (response.status === "fulfilled") {
        result.positions.push(...response.value.positions);
        if (response.value.complete) result.coveredScopes.push(network);
        else
          result.warnings.push(
            `${network}: some token metadata unavailable; incomplete network snapshot`,
          );
      } else
        result.warnings.push(
          `${network}: balance retrieval failed; last known positions retained`,
        );
    });
    return result;
  }
}
