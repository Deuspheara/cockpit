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
// Balances are independent of optional metadata and pricing enrichment.
const tokenSchema = z.object({
  network: networkSchema,
  tokenAddress: z.string().nullable(),
  tokenBalance: z.string().regex(/^0x[0-9a-fA-F]+$/),
  tokenMetadata: z.unknown().optional(),
  tokenPrices: z.unknown().optional(),
  error: z.unknown().optional(),
});
const metadataSchema = z.object({
  decimals: z.number().int().min(0).max(36).nullish(),
  name: z.string().nullish(),
  symbol: z.string().nullish(),
});
const priceSchema = z.object({
  currency: z.string(),
  value: providerDecimal.refine((value) => new Decimal(value).gte(0)),
  lastUpdatedAt: z.iso.datetime({ offset: true }),
});
const responseSchema = z.object({
  data: z.object({
    tokens: z.array(z.unknown()),
    pageKey: z.string().nullable().optional(),
  }),
  error: z
    .object({ partialErrors: z.array(z.object({ network: z.string() })) })
    .nullish(),
});
function failureFor(error: unknown) {
  const message = error instanceof AppError ? error.message : "";
  if (/HTTP 40[13]/.test(message))
    return {
      code: "ALCHEMY_AUTH_FAILED",
      message: "Alchemy rejected the API key. Check its access permissions.",
      retryable: false,
    };
  if (/HTTP 429/.test(message))
    return {
      code: "ALCHEMY_RATE_LIMITED",
      message: "Alchemy rate limit reached. Retry synchronization shortly.",
      retryable: true,
    };
  if (error instanceof z.ZodError)
    return {
      code: "ALCHEMY_INVALID_RESPONSE",
      message: "Alchemy returned an unreadable response.",
      retryable: true,
    };
  return {
    code: "ALCHEMY_UNAVAILABLE",
    message: "Alchemy unavailable; last known positions retained",
    retryable: true,
  };
}
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
        "ALCHEMY_NOT_CONFIGURED",
        "Alchemy not configured. Configure ALCHEMY_API_KEY on the server.",
        503,
        { retryable: false },
      );
    const configured = z
      .array(networkSchema)
      .min(1)
      .max(3)
      .safeParse([
        ...new Set(
          this.networks.map((network) => network.trim()).filter(Boolean),
        ),
      ]);
    if (!configured.success)
      throw new AppError(
        "ALCHEMY_CONFIGURATION_ERROR",
        "Alchemy network configuration is invalid. Use eth-mainnet, base-mainnet, or arb-mainnet in ALCHEMY_NETWORKS.",
        503,
        { retryable: false },
      );
    const networks = configured.data;
    const results = await Promise.allSettled(
      networks.map(async (network) => {
        const positions: ProviderPosition[] = [];
        let pageKey: string | undefined;
        let complete = true;
        const warnings = new Set<string>();
        let failure: ReturnType<typeof failureFor> | undefined;
        try {
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
            if (response.error?.partialErrors.length) {
              complete = false;
              warnings.add(
                "Alchemy reported incomplete network data; last known positions retained",
              );
            }
            for (const raw of response.data.tokens) {
              const parsed = tokenSchema.safeParse(raw);
              if (!parsed.success || parsed.data.network !== network) {
                complete = false;
                warnings.add(
                  "Alchemy returned an unreadable token balance; last known positions retained",
                );
                continue;
              }
              const token = parsed.data;
              const balance = BigInt(token.tokenBalance);
              // Zero balances need no decimals or price and prove no current holding.
              if (balance === 0n) continue;
              const metadata = metadataSchema.safeParse(token.tokenMetadata);
              const native = token.tokenAddress === null;
              // All three supported networks use ETH with 18 decimals natively.
              const decimals = native
                ? 18
                : metadata.success
                  ? metadata.data.decimals
                  : null;
              if (decimals == null) {
                complete = false;
                warnings.add(
                  "Some token decimals are unavailable; last known positions retained",
                );
                continue;
              }
              const quantity = money(
                new Decimal(balance.toString()).div(
                  new Decimal(10).pow(decimals),
                ),
              );
              const price = (
                Array.isArray(token.tokenPrices) ? token.tokenPrices : []
              )
                .map((value) => priceSchema.safeParse(value))
                .find(
                  (value) =>
                    value.success &&
                    value.data.currency.toLowerCase() === "usd",
                );
              const quote = price?.success ? price.data : undefined;
              if (!quote)
                warnings.add(
                  "Some token prices are unavailable; balances synchronized without valuation",
                );
              if (token.error)
                warnings.add(
                  "Alchemy reported a token metadata or pricing issue; available balances retained",
                );
              const contract = token.tokenAddress?.toLowerCase();
              positions.push({
                asset: {
                  key: `evm:${network}:${contract ?? "native"}`,
                  symbol: native
                    ? "ETH"
                    : (metadata.success ? metadata.data.symbol : null) ||
                      contract!,
                  name: native
                    ? "Ethereum"
                    : (metadata.success ? metadata.data.name : null) ||
                      "Unknown token",
                  assetType: "crypto",
                  chain: network,
                  contractAddress: contract,
                },
                scope: network,
                quantity,
                currency: "USD",
                unitPrice: quote?.value,
                marketValue: quote
                  ? money(new Decimal(quantity).mul(quote.value))
                  : undefined,
                metadata: quote
                  ? { priceQuotedAt: quote.lastUpdatedAt }
                  : undefined,
              });
            }
            pageKey = response.data.pageKey ?? undefined;
            if (!pageKey)
              return { positions, complete, warnings: [...warnings], failure };
          }
          complete = false;
          warnings.add(
            "Alchemy pagination limit reached; last known positions retained",
          );
        } catch (error) {
          complete = false;
          failure = failureFor(error);
          warnings.add(failure.message);
        }
        return { positions, complete, warnings: [...warnings], failure };
      }),
    );
    const result = emptySync();
    results.forEach((response, index) => {
      const network = networks[index]!;
      if (response.status === "fulfilled") {
        result.positions.push(...response.value.positions);
        if (response.value.complete) result.coveredScopes.push(network);
        result.warnings.push(
          ...response.value.warnings.map((message) => `${network}: ${message}`),
        );
        if (response.value.failure) result.failure ??= response.value.failure;
      } else {
        const failure = failureFor(response.reason);
        result.failure ??= failure;
        result.warnings.push(`${network}: ${failure.message}`);
      }
    });
    if (!result.coveredScopes.length && !result.positions.length)
      result.failure ??= {
        code: "ALCHEMY_INCOMPLETE_DATA",
        message:
          "Alchemy responded, but no usable balances were available. Retry synchronization.",
        retryable: true,
      };
    return result;
  }
}
