# Finance Cockpit

Private investment portfolio with a native SwiftUI iOS app and a self-hosted TypeScript API. PostgreSQL owns financial records; Redis and the iPhone cache are disposable. Connected crypto accounts use public addresses and read-only APIs. AI produces typed proposals that require an explicit review/apply action.

## Implemented

- Global/category/account dashboards, provider-backed dYdX equity and trading-PnL history, market-price charts, effective leverage and collateral, valuation history, explicit positions, allocations, source timestamps, stale/partial states, Accounts/Assets views and account activity.
- Manual accounts, canonical assets, transactions, fees, holding observations, recurring investments, dated series corrections, occurrence confirmation/skip/detach, atomic change reviews and undo.
- Hyperliquid public spot/perpetual positions and fills; dYdX subaccount positions and fills; Alchemy balances/prices for configured EVM networks; dated ECB FX conversion.
- Multi-screenshot import with structured extraction, clarification, review, provenance and reconciliation. Images remain in request memory; extracted evidence persists.
- Secondary global assistant with persisted conversations and an allowlist of finance read/proposal tools.
- Unified Activity filters, service diagnostics and disabled-by-default paper heartbeat bots with schedules and run history.

Architecture and constraints: [architecture](docs/architecture.md), [data model](docs/data-model.md), [security](docs/security.md), [provider sources](docs/provider-sources.md), [full blueprint](docs/blueprint.md).

## Run locally

Prerequisites: Docker with Compose 2.24.4+, Xcode with an iOS 26+ simulator, and XcodeGen (`brew install xcodegen`). The backend runs Node 24 in Docker; host development also requires Node 24.

1. Copy `.env.example` to `.env`. Replace `POSTGRES_PASSWORD` and the password in `DATABASE_URL` with the same strong value. URL-encode reserved characters in the URL password. Keep `.env` private.
2. Run `make dev`. This builds the API/worker, applies SQL migrations and starts PostgreSQL, Redis and Caddy. Development HTTP binds only to `127.0.0.1:8080`.
3. Verify `curl http://localhost:8080/health` and `docker compose ps`.
4. Optional, on an empty development database: `make seed`. Demo accounts are explicitly marked and provider sync is disabled for them. Demo totals are EUR 62,871 globally, EUR 31,001 crypto and EUR 31,870 equities. Never seed a real portfolio. When a real account exists, seed accounts are excluded from portfolio totals, account lists and Activity; their records remain intact.
5. Run `make token`; save the printed device ID and token.
6. Run `make ios-generate`, open `ios/FinanceCockpit.xcodeproj`, choose a simulator and run. Enter `http://localhost:8080` and the token. HTTP loopback is allowed only in Debug. A physical iPhone requires an accessible HTTPS server and your development signing team in Xcode.

`make logs` follows logs. `make down` stops services without removing financial volumes. `make migrate` explicitly runs pending migrations. `make check` checks host TypeScript and formatting after `cd server && npm ci`.

## Deploy to a VPS

1. Install Docker Engine and Compose, clone the project and configure a private `.env` as above.
2. Set `APP_DOMAIN` to your domain and `APP_BASE_URL` to its HTTPS origin. Point DNS at the VPS; permit TCP 80/443 and optionally UDP 443.
3. Run `make up`. Caddy obtains TLS certificates. PostgreSQL, Redis and the API have no public host ports; Caddy is the entry point. Migrations must succeed before API/worker startup.
4. Check `https://YOUR_DOMAIN/health`, create a device token and pair the iPhone using the HTTPS origin.

For updates, follow the exact rebuild, migration, Caddy reload, and streaming checks in [Streaming assistant deployment](docs/chat-streaming.md#vps-rebuild-using-the-existing-tunnel). Do not downgrade across incompatible migrations without restoring the matching database. An actual VPS/domain was not supplied; deployment was verified locally through the same Compose services.

## Device tokens

Create: `docker compose exec api node dist/modules/auth/cli.js create --name "My iPhone"`.

Revoke: `docker compose exec api node dist/modules/auth/cli.js revoke DEVICE_UUID`.

Rotation: create a replacement, update the device, then revoke the old ID. Tokens are printed once; only hashes persist on the server. The app stores credentials in Keychain. Removing credentials in Settings clears the device's cache and local pairing; revoke the token on the server to invalidate it.

## Configure connections

In Portfolio → Add → Add manually or connect account, choose Account, its category and source:

- `hyperliquid`: public `0x…` address. Public spot/perpetual positions and fill history are queried through the Info endpoint. Subaccount discovery is retained as account metadata; connect a discovered public address separately for its own dashboard row.
- `dydx`: public `dydx1…` address and subaccount number. Indexer GET endpoints provide positions and fills. No exchange signing credentials are accepted.
- `evm_wallet`: public EVM address. Set `ALCHEMY_API_KEY` on the server and select supported networks through `ALCHEMY_NETWORKS` (default Ethereum, Base, Arbitrum). Restart API/worker after environment changes: `make up`.

The first successful connection records an initial valuation immediately. Later snapshots are recorded every 15 minutes; healthy accounts can record history even when another account is unavailable. The worker syncs every 120 seconds by default. Account detail provides a manual refresh. Errors preserve the last successful positions; failed provider sections cannot assert zero balances. Settings → Integration diagnostics lists connections and service reachability. See `.env.example` for sync/cache/snapshot intervals.

## Configure OpenRouter

Set `OPENROUTER_API_KEY`, `OPENROUTER_MODEL_PRIMARY` and `OPENROUTER_MODEL_VISION` in the server `.env`; run `make up`. Choose a primary model supporting function tools and a vision model supporting images plus strict JSON-schema output. Keys never go to the app. Settings reports configuration and model IDs.

Portfolio's assistant button immediately left of + opens full-screen chat; Add → Import screenshot opens the same import flow available from chat. Screenshots accept PNG/JPEG, up to five per session and 12 MB each. Provide missing dates/currencies/quantities explicitly, then inspect the change review. Sending a screenshot or a chat message transmits its relevant financial context to OpenRouter and the configured model provider. Original images are not stored by this application; upstream retention depends on your provider configuration.

Chat streams text and actual tool activity, preserves interrupted replies and drafts, and supports explicit Stop and retry. Backgrounded/disconnected clients recover server progress without rerunning tools. See [the streaming protocol and operational guide](docs/chat-streaming.md).

## Manual CSV import

Add account → Manual import accepts Trade Republic CSV exports with a review before confirmation, separate DEFAULT/PEA accounts, duplicate-safe updates, and import history. See [CSV format, accounting, API and limitations](docs/csv-import.md).

## Asset logos

Portfolio → Assets displays online logos, with a neutral symbol badge for loading, missing images, ambiguous identities, and offline assets without cached images. The bottom bar contains Home, Activity, and Settings; closing the toolbar assistant preserves the Portfolio filters and Accounts/Assets selection.

Crypto metadata comes from [CoinPaprika](https://docs.coinpaprika.com/api-reference/coins/get-coin-by-id), without a new API key. Resolution uses active coins with an exact symbol and name, or a unique symbol when the stored name is the symbol/provider-generated perpetual name. BTC, ETH, SOL, and HYPE perpetuals use canonical underlying coin IDs to distinguish duplicate tickers. Existing `externalIds.coinpaprika` can explicitly identify a coin. Contract-backed tokens require that explicit ID; symbols alone must not assign them another token's logo.

To enable stocks and ETFs, set `LOGO_DEV_PUBLISHABLE_KEY` in the server `.env` to the **publishable** key from your [Logo.dev dashboard](https://www.logo.dev/dashboard), then restart the API (`make up`). Never put a secret Logo.dev key in this variable: the publishable key is included in image URLs sent to the app. No subscription is purchased by this integration. Without a key, securities keep the fallback badge.

Securities prefer `externalIds.isin`. Otherwise use an exchange-qualified symbol (for example `AIR.PA` or `VWCE.DE`) in `externalIds.ticker` or `symbol`; unsuffixed US tickers require an explicit `externalIds.exchange` of `NASDAQ`, `NYSE`, `NYSEARCA`, `AMEX`, `XNAS`, `XNYS`, or `ARCX`. Quote currency does not establish listing identity. These fields already exist in the asset API; no migration is needed. Logo.dev maps securities to company/issuer logos, and coverage varies by ETF.

Successful and unmatched lookup results are cached in the API process for 24 hours (bounded to 2,000 entries); restarting the API clears this metadata cache. Transient failures have a 60-second retry cooldown to avoid hammering an unavailable provider. Cold lookup batches have a 2.5-second deadline and at most four concurrent lookups. Provider failures return holdings without logos. Images load directly from the provider CDN through a separate on-device HTTP cache (8 MB memory / 50 MB disk), respect provider cache headers, and use previously cached images when offline. The providers receive asset identifiers and normal request metadata, never account names, quantities, balances, or finance API credentials.

The Assets list includes provider credit links. [Logo.dev attribution rules](https://www.logo.dev/docs/platform/attribution) currently exempt personal projects and paid plans. For commercial use on its free plan, also put “Logos provided by Logo.dev” linking to `https://logo.dev` on the app's public website or App Store listing and complete the provider's verification. The in-app link alone does not fulfill that public attribution requirement. CoinPaprika is credited beneath crypto logos.

## Tests and builds

- `make test`: isolated Docker PostgreSQL/Redis integration suite and unit tests. It uses a dedicated `finance_test` database with disposable storage; it does not touch the development/production DB.
- `make check`: TypeScript and formatting validation.
- `cd server && npm test`: unit tests; integration suites skip unless `TEST_DATABASE_URL` names a dedicated `finance_test` database.
- `xcodebuild -project ios/FinanceCockpit.xcodeproj -scheme FinanceCockpit -destination 'platform=iOS Simulator,name=YOUR_SIMULATOR' CODE_SIGN_IDENTITY=- test`: iOS build/tests.

The native UI test requires an already paired simulator and skips with an explicit message on a fresh install. Verification evidence and remaining environment checks are recorded in [progress](docs/progress.md).

## Backup and restore

`make backup` writes a private compressed PostgreSQL dump under `backups/`. Copy it off the VPS. Redis is disposable. Keep deployment configuration separately; `.env` and raw device tokens are not included in the dump.

Restore only into the intended stopped deployment and an empty database: `docker compose stop api worker`, then `cat backups/FILE.dump | docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner'`. Restart with `make up` after verifying success. Restore replaces financial records and should first be rehearsed in an isolated deployment.

## V1 limits

- Observed holdings do not invent historical purchases. A manual asset with ledger entries is projected from that ledger; missing acquisition history must be supplied explicitly before treating it as complete. Weighted-average cost is available only for fully known buys/sells. Tax-lot accounting, tax reporting and investment-return calculations are outside this implementation; charts label changes as portfolio value changes.
- Valuation history combines captured snapshots with dYdX reported daily/hourly equity. Historical USD equity converts with dated ECB USD/EUR references. Charts use last-observation UTC buckets: 1D hourly, 1W six-hourly, 3W/1M/3M daily, 1Y weekly; ALL adapts to coverage. Monotone interpolation smooths the line while keeping recorded values. Initial dYdX fetches are bounded to 400 daily and 300 hourly records; previously imported records remain stored. Historical corrections change the current projection and remain audited; they do not fabricate past market quotes or rewrite previously captured observations. Missing prices/FX are shown as partial/unavailable. Manual market prices require explicit new observations.
- Public-wallet V1 covers supported fungible-token balances, not transfers, NFTs or DeFi. Provider history is bounded by public endpoint limits; dYdX backfills incrementally, and pagination/partial failures remain visible. Hyperliquid funding/deposits/withdrawals and unsupported provider collateral are not synthesized from fills.
- Paper bots run a scheduled heartbeat with no orders and unknown PnL. No trading strategy, exchange trading endpoint, private key storage or live execution is implemented.
- No live OpenRouter/Alchemy call was verified because keys were not supplied. Their request/validation flows are tested with deterministic HTTP fixtures.
- This Mac has Xcode 27 beta. Builds/tests use that compiler with iOS 26 deployment and an installed iOS 26.5 runtime. Stable Xcode release validation, physical-device signing and actual VPS/TLS deployment remain environment checks.

Base wallet pricing recovery, partial charts, historical backfill limits, and the production release procedure are documented in [Base wallet history](docs/base-wallet-history.md).

### Simple and Advanced interface

The iOS app starts in **Simple**. Change **Settings → Interface** to Advanced to
show trading analytics, leverage, collateral, provider history, and server
configuration. The choice is saved on the device. Both modes use the same balances
and historical data; chart smoothing does not fill coverage gaps.

Account actions live in the account’s **…** menu. **Remove account** archives it,
removes it from portfolio/activity, and stops background updates while retaining
its records. There is no permanent-delete or restoration interface. Migration
`0013_account_archive_guards.sql` must be applied with the normal server migration
step before using account removal.

Manual transactions (including Trade Republic CSV imports) can be deleted from
their detail screen or with activity swipe/context actions. One confirmation
applies an audited void and recalculates holdings; imported transaction identifiers
are retained to prevent reimport. Connected-provider transactions remain read-only.
