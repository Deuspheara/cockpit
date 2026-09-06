# Base wallet valuation and history

The EVM sync keeps quantities when Alchemy cannot price a token. Missing current prices are retried through Alchemy Prices by exact network/contract identity; native ETH uses the ETH symbol endpoint. Quotes older than 24 hours or more than a minute in the future are not accepted. Positive fallback results are cached for five minutes, unsuccessful lookups for fifteen minutes, in a bounded process-local cache. Unknown tokens are never assigned a stablecoin peg or zero price.

The dashboard now exposes `valuationIssues`, `historyStatus`, and `historyJobs`. Account rows also include `balanceComplete`, `hasKnownValue`, and `coverage`. A pricing-only partial sync does not make fresh balances stale. Missing quotes, unavailable balances, provider failures, and missing FX have separate diagnostics.

## Chart semantics

Snapshots retain known subtotals and explicit asset coverage. Existing snapshots remain complete after migration. Historical values are grouped into UTC display buckets, taking the latest actual value per account, with recorded snapshots winning timestamp ties. Missing accounts are disclosed rather than silently valued at zero. No values are carried forward into empty buckets.

Chart points add `complete`, `coverage`, `coverageKey`, `segmentId`, and `sourceAt`. A line segment ends when its coverage changes or time buckets are missing. Value-change figures are suppressed when the history contains incomplete or disconnected segments. This is portfolio value change, not investment return.

Historical USD values use the latest ECB conversion at or before the observation, less than seven days old. Missing conversions remain coverage gaps. An entirely unvalued bucket produces no point.

## Base reconstruction

The worker automatically creates one durable job per non-demo, enabled EVM wallet when Alchemy and `base-mainnet` are configured. It discovers incoming and outgoing historical transfers through the end date, including tokens sold before connection. Reconstruction then proceeds from the newest day to the oldest, over 90 daily points; the newest month is processed first.

Dates resolve to finalized Base blocks. ETH uses `eth_getBalance`; ERC-20 tokens use `balanceOf` and `decimals` calls at the historical block. Empty calls count as zero only after `eth_getCode` proves no contract existed at that block. Historical prices use network/contract identity, or ETH for the native asset, and must be dated no later than the balance sample and less than one day earlier.

Coverage is limited to native ETH and discovered ERC-20 tokens on Base. Other configured networks remain explicit historical gaps. This does not reconstruct NFTs, DeFi protocol positions, cost basis, PnL, or tax records. Tokens with unusual balance interfaces or unavailable archive state remain unvalued.

`evm_balance_history` stores dated quantities and quote provenance. `evm_account_history` stores reconstructed subtotals and coverage. Neither writes trading PnL or financial transactions. `evm_history_jobs` stores cursors, progress, leases, retry state, and request usage. `evm_history_cache` caches immutable blocks and balances and short-lived historical price responses; the worker removes expired cache entries in bounded batches.

Each account has a hard limit of 1,000 backfill HTTP attempts per UTC day, persisted before requests are sent. HTTP failures count. Historical state lookup uses at most two requests concurrently per worker. Normal sync runs independently; the backfill never blocks the worker's regular scheduling loop. Paused jobs resume after the quota reset or provider backoff. Crashed jobs are reclaimed after fifteen minutes without progress. Completed token/day records survive restarts; retries preserve successful records and retry missing ones.

The request cap limits requests, not monetary charges or Alchemy compute units. No subscription or additional provider is purchased. Alchemy access and the existing account's pricing still apply. Highly active wallets can take multiple days to discover before values appear.

## API and iOS

All routes use existing device authentication:

- `POST /api/v1/accounts/:id/history-jobs`: HTTP 202; create or resume a failed/partial reconstruction. Active, paused, and complete jobs are reused. Retrying cannot reset the daily budget.
- `GET /api/v1/accounts/:id/history-jobs`: latest job summary or null.
- `GET /api/v1/accounts/:id/detail`: adds optional `historyJob` with phase, status, processed days, request usage, next attempt, and sanitized error.

The chart's coverage button opens missing-holding details with network, contract, quote date when known, and refresh controls. Selecting a historical point inspects its coverage. Account detail displays reconstruction progress and retry controls. New Swift fields are optional so the app can still decode older server responses and cached dashboards.

## Production release (owner-operated)

Run in the production checkout, preserving its private `.env`. Back up before applying the additive migration. The updated API and worker require schema `0011_evm_history.sql`.

```sh
make backup
docker compose build api worker migrate
docker compose stop api worker
docker compose run --rm migrate
docker compose up -d api worker caddy
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
docker compose ps
```

If migration fails, correct the error before starting the new API or worker. Then publish/install the updated iOS build. No changes were deployed to `finance.tavren.app` during development.

After release, open Base Eth, synchronize it, and inspect valuation coverage. Each of the three previously unvalued positions should either have an exact-identity quote or an actionable missing-price explanation. Verify the global chart displays known values, inspect historical coverage, and confirm the history job advances or reports a clear pause/access error. Actual recovery depends on Alchemy coverage and permissions; the production token identities were not accessible during development.

## Validation

Use the isolated Node 24/PostgreSQL suite:

```sh
docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from test
```

It covers pricing identity and caching, partial chart coverage, snapshot capture, dated FX, authenticated endpoints, quota enforcement, failure/restart behavior, pagination, unavailable archive state, and upgrading populated schema 0010. Swift tests cover backward-compatible DTO decoding; the fixture UI test covers missing-token inspection and history retry without using a production account.

Validation completed on 2026-09-06: 145 server tests passed across 28 suites using Node 24 and isolated PostgreSQL; TypeScript checking passed. The iPhone 17 Pro (iOS 26.2, Xcode 27 beta) build succeeded; 38 Swift Testing cases and two existing XCTest unit cases passed, and the partial-history fixture UI test passed. Screenshots are in `docs/screenshots/base-history/` (ignored by Git). The retry control's accessibility identifier was corrected after the first UI run detected that the parent container overrode it.

Formatting checks pass for every changed server file. The repository-wide formatting check still flags six untouched import-related files; no unrelated formatting changes were made. Production deployment and live Alchemy account coverage remain owner verification steps.
