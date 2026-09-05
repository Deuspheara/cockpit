# Screenshot imports and background wallet synchronization

The iOS Portfolio menu and Assistant attachment action open the same full-screen five-stage import: Upload & Analysis, Account & Date, Holdings, Confirm, Complete. Holdings are edited individually in sheets; warnings do not prevent Continue, whereas unresolved financial facts and missing destinations do. Confirm shows the account and reviewed holdings. Apply and Undo remain explicit financial mutations.

An Assistant import has one `import_result` message linked by session ID. It opens the separate result, and is excluded from both streaming and legacy model history. Creating an empty import session creates no chat message. Portfolio imports have no conversation and never create chat messages.

## Deployment

Apply migration `0009_background_jobs.sql` before starting the updated API or worker. Run the API and worker together; the worker claims queued wallet runs every scheduling cycle. Keep one API process for screenshot jobs: image ownership is deliberately process-local, and API startup expires unfinished import jobs as `REUPLOAD_REQUIRED`. Horizontal API replication would require instance ownership and routing before it can safely be enabled.

No screenshot bytes are stored in PostgreSQL, Redis, application logs, or chat metadata. Multipart chunks and owned image buffers are overwritten after use, validation failure, cancellation, or shutdown. Encoded request strings are released after the vision request; JavaScript cannot overwrite immutable strings or guarantee erasure of copies held by the HTTP runtime. A process crash destroys its transient ownership; jobs remaining in the database require re-upload after restart.

## Import job API

- `POST /api/v1/imports`: optional `accountId`, `conversationId`, `requestId`.
- `POST /api/v1/imports/:id/jobs?requestId=<UUID>&revision=<integer>`: multipart PNG/JPEG files, at most five. Returns a durable queued job with HTTP 202 before vision or EODHD work begins. The same request ID returns the same job.
- `GET /api/v1/imports/:id/jobs/:jobId`: status, phase, grouped progress, revision, sanitized failure, and timestamps.
- `POST /api/v1/imports/:id/jobs/:jobId/cancel`: cancels queued/running work, aborts vision, and clears owned buffers. Completed jobs remain completed.
- `GET /api/v1/imports/:id`: includes the latest `processing` job and editable `destination`.
- `PATCH /api/v1/imports/:id`: revision-checked `accountId` (existing manual account or null), `likelyAccountName`, observation date, and candidate edits.

All selected screenshots are sent in one vision request. Instrument searches are normalized and deduplicated, with at most four concurrent EODHD requests. Unavailable/quota-limited market data retains visible values and reports warnings. The API verifies the job and session revision in the transaction that commits extraction and the compact chat link. Closing an iOS screen stops polling, not the server job; opening it again loads the latest durable state.

The synchronous `/screenshots`, import clarification, review, and change-set endpoints remain available.

## Wallet sync API

Creating an EVM account atomically saves it and queues its first synchronization. Provider calls never run in account creation. The app can close setup or open the saved account immediately.

- `POST /api/v1/accounts/:id/sync-runs`: enqueue, or return an already queued/running job, with HTTP 202.
- `GET /api/v1/accounts/:id/sync-runs/:runId`: structured run details.
- `GET /api/v1/accounts/:id/sync-runs`: latest run or null.

Statuses are `queued`, `running`, `success`, `partial`, `failed`. EVM DTOs identify the provider as `alchemy`, retain per-network warnings, and return sanitized retryable failures. An absent `ALCHEMY_API_KEY` disables new wallet setup in iOS and is reported explicitly for existing wallets. Failed synchronization never deletes the account. The synchronous `/sync` endpoint remains supported and can execute an already queued run for older clients.

## Validation

`npm run typecheck` and `npm test` in `server` run local checks. Database cases require `TEST_DATABASE_URL` ending in `/finance_test`; `docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from test` supplies isolated PostgreSQL and Redis. New tests cover immediate HTTP acceptance while vision is blocked, multiple images, bounded deduplicated lookup, cancellation, stale revisions, restart expiry, chunk cleanup, durable Alchemy failures and retry.

The iOS unit suite covers job restoration and distinct provider errors. `ScreenshotWizardTests` exercises the five-stage flow, individual editing, return from Confirm, Apply/Undo, large text, and dismissal during analysis using in-memory HTTP fixtures.

Validation completed after Docker recovery (2026-09-05): backend TypeScript check passed; all 116 tests across 24 suites passed with PostgreSQL and Redis, including a populated schema-0008 upgrade regression. The running application's HTTP health endpoint, database/Redis readiness, and worker heartbeat were healthy. The earlier iOS simulator pass completed 37 unit tests and two wizard UI tests. These checks do not deploy the workspace changes to the running application.

## Alchemy configuration and HTTP 200 responses

Set `ALCHEMY_API_KEY` in the VPS `.env`; both `api` and `worker` load that file. Set `ALCHEMY_NETWORKS=eth-mainnet,base-mainnet,arb-mainnet` (or a subset). Recreate both services after configuration changes. The adapter uses the documented Portfolio API `POST https://api.g.alchemy.com/data/v1/{apiKey}/assets/tokens/by-address`, with metadata, prices, native tokens and ERC-20 tokens enabled, one independently paginated request per network. Keys and upstream response bodies must never be logged.

HTTP 200 is transport success, not proof of a complete portfolio. Top-level `error.partialErrors` marks incomplete networks; per-token errors describe metadata/pricing failures. Balance parsing is independent of enrichment: zero balances need no metadata, native ETH uses 18 decimals on the supported networks, and missing prices preserve quantities without inventing values. Unknown ERC-20 decimals or malformed rows prevent full coverage, retaining older observations for missing tokens. A later page failure preserves earlier pages. No failed or incomplete network may zero out unseen holdings.

Failures distinguish rejected credentials, rate limiting, unreadable responses, incomplete data, and local persistence errors. In particular, a database failure is `SYNC_SAVE_FAILED`, not `ALCHEMY_UNAVAILABLE`. Retry uses the existing saved wallet.

References checked 2026-09-05: [Tokens By Wallet](https://www.alchemy.com/docs/data/portfolio-apis/portfolio-api-endpoints/portfolio-api-endpoints/get-tokens-by-address), [partial-failure handling](https://www.alchemy.com/docs/reference/portfolio-apis#handling-partial-failures).

## Guided holding review

Continue reviews unresolved holdings one at a time. Ordinary holdings have separate investment-selection and value-review steps, with a persistent action and an explicit close action. Saving a resolved row advances to the next unresolved item; closing without saving returns to the holdings list. Financial changes still require Apply.

`GET /api/v1/imports/:id/positions/:candidateId/matches?query=...` supports name, ticker, or ISIN searches for existing import rows, including rows with no stored candidates. It deduplicates listings by ISIN, ranks matches, and highlights a suggestion only above the matching threshold with a sufficient lead over alternatives. Suggestions are never silently selected or applied. Empty results offer search refinement and manual ticker entry instead of repeating an unresolvable Save loop. This feature requires both the backend and iOS update.

## Remembered instruments and search availability

Migration `0010_import_instrument_memory.sql` stores explicit user-confirmed label-to-instrument mappings and recovers earlier confirmations from import edit history. Later screenshots reuse these exact normalized labels and valuation currencies; share-class words remain significant. Only identifiers are retained, never quantities, prices, or image bytes. Revision conflicts do not update memory.

EODHD search keeps fresh quotes for five minutes and identifier-only fallback results for seven days. Partial malformed provider rows do not erase valid choices, failed searches do not poison the cache with empty results, and missing configuration, permission errors, and quota limits return explicit search messages. The interactive search can retry a shorter label when the exact phrase returns no results. `EODHD_API_TOKEN` is required for new market search; `ALCHEMY_API_KEY` does not enable fund search.

Deploy this backend change with the migration before restarting API and worker. No additional iOS change is needed when the guided search UI is already installed.
