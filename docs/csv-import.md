# Manual CSV imports

Add account → Manual import opens the native Files picker, uploads one CSV, and presents a review before any financial records are created. Account details offers Import CSV and paginated import history. The feature does not use AI, broker credentials, or trading endpoints.

The first adapter supports the supplied Trade Republic UTF-8, comma-delimited export. Its 23-column header includes datetime, date, account_type, category, type, asset_class, name, symbol, shares, price, amount, fee, tax, currency, original_amount, original_currency, fx_rate and transaction_id. Header case/whitespace and BOM are normalized. Quoting, embedded newlines, CRLF/LF and empty optional fields are supported. Numbers use decimal points and timestamps use UTC ISO format with up to six fractional digits. Locale-specific numbers/dates and other export layouts are rejected with issues rather than inferred.

DEFAULT and PEA map to separate manual accounts. Preview automatically selects an unambiguous account identified by provider and account-group key. Users can select another compatible manual account or create one. Multiple possible matches are excluded until explicitly selected. The export has no customer account number, so account groups alone cannot distinguish different people's Trade Republic exports: verify destinations when importing another person's file.

## Accounting

BUY and SELL use positive canonical quantities. The supplied export uses negative sale shares, signed gross consideration and separate negative charges. Net cash movement equals signed amount plus signed fee and tax. Dividends and interest create cash income, not security quantities. Cash deposits, transfers, card withdrawals and promotional credits use existing ledger event types with provider event provenance. Original-currency and FX fields are evidence only; no second cash movement is fabricated.

TAX_OPTIMIZATION events and zero/reversed cash income are skipped because their cash effect is not established. The supplied 162-row file parses to 159 valid transactions and three warnings: two tax adjustments and one ambiguous cash event. A partial import is not evidence of complete account history. Supply missing history separately; no opening balances or acquisition costs are invented.

Securities resolve by ISIN, BTC by explicit provider identity, and cash by currency. Ambiguous existing asset records skip affected rows with an issue; resolve duplicate assets before re-importing. Securities with a conflicting accounting currency are also skipped instead of mixing cost bases across currencies. ISIN-identified derivatives without contract details are ordinary `other` instruments with unknown live value, not invented option/perpetual contracts. Existing market observations/quotes continue to value positions; execution prices never become current quotes.

PortfolioService and reconciliation share one settlement function. They apply explicit net cash settlements once and retain the existing gross/fee calculation for older transactions. Trade-only histories also produce cash positions. Positions remain projections of authoritative transactions, not another persisted holdings ledger.

## API and persistence

All endpoints are authenticated under `/api/v1`:

- `POST /imports/csv/preview?provider=auto&accountId=...`: one multipart `file`; optional target account.
- `GET /imports/csv/:id`: saved preview/result.
- `PATCH /imports/csv/:id`: revision and complete destinations array (`group`, `accountId`, `name`, `included`).
- `POST /imports/csv/:id/confirm`: reviewed `revision` only; no client transaction payload.
- `DELETE /imports/csv/:id`: cancel uncommitted preview.
- `GET /accounts/:id/imports?offset=0`: 20 history entries per page.

Migration 0012 adds independent provider/connection/account-group identity, last-import timestamps, CSV batches/account history links, and transaction provenance, financial content hash, net cash and tax columns. Existing source types remain unchanged. Authentication now exposes the device-token identity while preserving the boolean authentication method. This remains a single-owner application with trusted devices; preview access/confirmation is restricted to the creating device token.

Identity uniqueness is `(account_id, provider, external_id)`, separate from ingestion source so future API synchronization can share it. Missing IDs use a deterministic financial fingerprint. Cosmetic names and row order do not affect identity; microsecond timestamps do. Indistinguishable rows without IDs are conservatively ignored with a warning. Voided transactions reserve their identities. Conflicting financial hashes are never overwritten.

Confirmation takes the existing financial advisory lock, rechecks preview revision and current data, then commits account/asset creation, bulk transaction insertion, projection validation, audit counts and batch completion atomically. New conflicts return a revised preview for explicit review. Concurrent identical imports converge on one account and one set of transactions. Retrying a completed confirmation returns its saved result. A critical failure rolls back and leaves the preview retryable.

## Privacy and limits

Files are limited to 10 MiB, one part, 50,000 records and bounded record/column sizes. Extension, MIME, UTF-8 and text structure are checked. Uploaded bytes live only in memory, are cleared after parsing, and have no public URL. Counterparty names, IBANs, merchant codes and free-form descriptions are not retained. Formula-looking text stays plain text; monetary fields require strict decimal syntax.

Normalized staging expires after 24 hours and is deleted on completion, cancellation or expiry. The existing worker and preview retrieval clean expired stages. Compact preview issues, final counts, filenames, timestamps and transaction provenance remain for history. Logs contain only operational counts, IDs and durations. Private exports belong outside git or under ignored `private-samples/`; tests use sanitized fixtures.

## Verification

The committed fixture contains 18 completely invented rows, using only the real export’s headers and representative row structures. It does not preserve the original trade history or amounts.

Parser tests cover the supported format, all implemented event families, quoting, BOM, signs, dates, identifiers, missing IDs and malformed inputs. PostgreSQL/HTTP tests cover exact repeats, overlapping exports, conflicts, ownership, cancellation, expiry, concurrency, rollback, portfolio reconstruction and upload validation. Swift tests cover file reading, preview/confirmation and recovery gating; UI tests exercise the native picker, successful/duplicate-only imports and network errors.

Apply the migration through the normal deployment migration step before shipping the updated mobile app. No production database is changed by the test suite.

## Implementation map

- Backend importer: `server/src/modules/imports/csv/parser.ts`, `service.ts`, and `routes.ts`; registered alongside the existing screenshot routes.
- Persistence: `server/migrations/0012_csv_imports.sql`, `server/src/db/schema.ts`, and worker expiry cleanup.
- Domain integration: shared `server/src/modules/ledger/settlement.ts`, transaction types, portfolio projection and cash reconciliation; existing change-set allowlists preserve migration compatibility.
- Authorization: `server/src/modules/auth/service.ts` and `server/src/app.ts` expose authenticated device identity.
- iOS: `CSVImportModel.swift`, `CSVImportView.swift`, API multipart upload, account setup/detail entry points, and optional account provenance DTO fields.
- Tests: CSV parser/HTTP integration suites, invented CSV fixture, Swift model tests and five CSV UI scenarios. Two existing UI assumptions were repaired: selecting the dYdX account for its derivatives test and matching the current empty-history label.
- Repository formatting checks also required formatting pre-existing screenshot-import code/tests. Those changes do not alter screenshot behavior.

## Verified on 6 September 2026

- `make check`: TypeScript and repository-wide Prettier checks passed. No separate linter is configured.
- `make test`: all **175 server tests in 30 files passed**, using the isolated Docker Node 24/PostgreSQL/Redis environment. The 5,000-row import and duplicate-check scenario completed in under one second in that environment; this is test-machine evidence, not a production SLA.
- `npm test -- --run test/csv-import.test.ts`: all **17 parser tests passed**.
- `xcodegen generate` and `xcodebuild ... test` compiled the application for the installed iOS Simulator with Xcode 27 beta.
- All **44 iOS unit tests** passed (42 Swift Testing cases plus two XCTest cases). All **24 UI tests** passed across the focused CSV run and regression/retest runs. The first full run exposed the off-screen CSV confirmation action and stale existing UI assertions; those were fixed and the affected tests passed on rerun. Overlapping intermediate UI runners were stopped and final verification ran sequentially.
- The native picker presentation, real file reading through the model, preview/confirmation, duplicate-only result, network recovery, existing-account entry and import history were exercised. Cloud-provider availability and physical-device signing remain environment-dependent checks.
- `git diff --check`: passed. Raw financial exports were not copied into the repository or imported into the development/production database. Production deployment was not performed.

The Simulator destination used was `36FE8E59-8E75-4BC3-BB2F-92DBEE863612`; build/test artifacts are under `/private/tmp/compte-csv-build`. Final test logs are `/private/tmp/compte-csv-server-tests.log`, `/private/tmp/compte-csv-ios-focused.log`, `/private/tmp/compte-csv-ios-regression.log`, and `/private/tmp/compte-csv-ios-wallet.log` (the regression log includes the two subsequently corrected wallet assertions).
