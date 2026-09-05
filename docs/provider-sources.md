# Provider mapping references

Checked during implementation against official documentation:

- [Hyperliquid public Info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) and [perpetual state](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals): use only the fixed /info endpoint. Raw USD ledger balance plus signed marked perpetual exposure must reconcile to reported account equity. Do not add the reported equity to notional exposures.
- [dYdX Indexer HTTP API](https://docs.dydx.xyz/indexer-client/http): use public address/subaccount and fills GET endpoints. Signed entry notional plus provider unrealized PnL yields signed marked exposure; combining it with quote asset positions must reconcile to equity.
- [Alchemy tokens by wallet](https://www.alchemy.com/docs/data/portfolio-apis/portfolio-api-endpoints/portfolio-api-endpoints/get-tokens-by-address): token balances are hex base units; convert using integer/decimal arithmetic. Check top-level partialErrors even on HTTP 200. A failed network never proves balances are zero.
- [ECB reference rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html): informational portfolio conversion only, with quote date/source. No execution-price claims.
- [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs) and [tool calling](https://openrouter.ai/docs/guides/features/tool-calling): validate returned content independently. The server, not the model, owns tool authorization and final persistence.

- dYdX `/v4/pnl` supplies historical equity, cumulative PnL and cumulative net transfers. Each accepted record must satisfy equity = PnL + net transfers within cent rounding. `/v4/candles/perpetualMarkets/{ticker}` supplies market candle closes independently of portfolio holdings. Both are fixed-host GET-only calls. Effective leverage is derived from gross absolute exposure / current reported equity, never presented as an original order setting.
- Historical EUR conversion uses the ECB full USD/EUR reference history, selecting the most recent reference dated at or before the equity sample (up to seven days old). Missing FX omits that converted historical point.
