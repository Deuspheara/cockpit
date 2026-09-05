# Implementation and verification

Verified September 5, 2026. All seven blueprint phases have a running V1 implementation. Product boundaries and remaining environment validation are explicit in README.md; this is not a claim of production deployment or complete provider history.

## Implemented phases

1. Foundation: Node 24 / Fastify API, PostgreSQL 18 migrations, Redis cache, token creation/revocation, worker, Caddy, Compose and backup command.
2. Manual finance: explicit assets/ledger/observations, decimal valuation, cash settlement, known weighted-average costs, aligned valuation snapshots, recurring versions and occurrences, atomic change previews/apply/undo and reconciliation.
3. Native iOS: pairing/Keychain, disposable cache, portfolio scopes/chart/ranges, Accounts/Assets views, account detail, manual entry/corrections, recurring editing, Activity, Settings and diagnostics.
4. Read-only integrations: Hyperliquid Info, dYdX Indexer, Alchemy public token balances, ECB FX and scheduled sync. Failed sections preserve previous positions. dYdX incremental history continues beyond two pages while checking recent fills each time.
5. Screenshot import: transient images, strict structured extraction, multi-image merge, questions, reviewed operations, audit provenance and automatic reconciliation.
6. Assistant: bounded persisted conversations, model tool allowlist, deterministic proposals and native review cards. Models cannot apply changes or use arbitrary SQL/HTTP/tools.
7. Activity and paper bots: unified account/category/source filters, correction navigation, disabled-by-default paper heartbeat schedules, run history and no trading endpoints.

## Evidence

- Final Docker suite: **40 tests passed across 10 files**, running the pinned Node 24 image with isolated PostgreSQL and Redis. Includes auth, numerical projection, retrospective recurrence/undo, stale previews, provider failures/deduplication, 350-fill pagination, import clarification/apply/undo, agent authorization and bot scheduling.
- TypeScript strict checking and Prettier checking pass. Dependency installation audit reported zero vulnerabilities.
- Xcode 27 beta built the app targeting iOS 26.0; **6 Swift tests and 1 native UI navigation test passed** on iOS 26.5, iPhone 17 Pro simulator. UI test traversed Portfolio → Activity → Bots → Settings → Diagnostics → Recurring investments → Portfolio.
- Authenticated final local HTTP check: Global EUR **62,871**, Crypto EUR **31,001**, Equities EUR **31,870**, all complete. Assets and Activity endpoints responded. Database/cache reachable and worker heartbeat current.
- Compose migrations/API/worker/Caddy started successfully. Health checked through Caddy at localhost:8080.
- Backup restored successfully to a temporary database: 5 demo accounts, 5 applied migrations, 90 valuation batches. The temporary database was removed after verification; original data was untouched.
- Simulator screenshots were visually inspected and retained locally outside version control.
- Credential scan found no configured secrets/device token in deliverable source or documentation. `.env`, generated projects, build artifacts and backups remain ignored.
- Hyperliquid public Info live smoke test succeeded earlier. Alchemy and OpenRouter behavior uses HTTP fixtures because no live keys were provided.

## Environment validation still needed

- Stable Xcode release build and a signed physical-iPhone run. Xcode 27 beta was used as discussed with the user; iOS 26 remains the minimum deployment target.
- Real OpenRouter/Alchemy keys and the user's actual public accounts for live provider acceptance.
- User-provided VPS/domain for actual HTTPS deployment. Local Docker Compose verifies the service topology, not external DNS/TLS/firewall configuration.

See README.md for V1 limits: observed snapshots are not fabricated historical prices; provider history remains constrained by public endpoints; tax lots, live trading and full DeFi are absent; paper jobs currently execute heartbeat runs without orders.

## Real-account chart correction

After connecting a real dYdX account, screenshots exposed empty Global/Crypto charts: historical batches lacked the new account, while stale demo accounts blocked all new snapshots. Corrected demo isolation, per-account snapshot eligibility, immediate first-sync capture, cache invalidation and first-point rendering. Real-account Global and Crypto endpoints now return recorded points; the rebuilt simulator chart was visually verified. Backend regression suite: 42 tests passed across 11 files. Existing history is preserved; missing pre-connection values are not invented.

## Historical analytics and chart sampling

Added dYdX reported daily/hourly equity and cumulative trading-PnL history, dated ECB conversion, market candle charts, effective leverage/exposure/free-collateral details, and entry/valuation prices. Equity, PnL and market prices remain distinct views. Period-sensitive UTC buckets remove the dense recent cluster; each bucket retains its last real observation and original source timestamp. Smooth lines use monotone interpolation. Added 3W. The 1W live query was verified to use six-hour buckets after hourly pagination. Fixed account-row hit targets and uppercase iOS UUID normalization that previously hid positions. Native UI tests pass through equity → PnL → leverage → market prices, with screenshots visually reviewed.

Final analytics validation: **51 backend tests across 13 files, 6 Swift tests and 2 native UI tests passed**. TypeScript checking passed. Private live-account screenshots and runtime credentials are excluded from version control.
