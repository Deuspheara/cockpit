# Shared security and market-data pipeline

Migration `0014_market_data_pipeline.sql` adds a shared security identity above legacy assets. Assets and their transaction/audit history are not rewritten: every valid normalized ISIN is linked to one `securities` row, duplicate assets share it, and the oldest asset remains the canonical legacy reference.

## Provider boundary

EODHD is the only price source. A selectable route must be an EODHD mapping verified against the exact security ISIN. OpenFIGI is queried first in batches and supplies supporting identity/ticker evidence only; an OpenFIGI result alone is never selectable and its exchange code is never manufactured into an EODHD symbol. Name and CSV currency similarity do not establish identity.

Resolution first reuses active verified mappings at the security's current verification revision. An unresolved ISIN normally uses one exact-ISIN EODHD Search request, whose complete exact-ISIN rows become the permanent candidate set. ID Mapping runs only after a completed empty Search response. Because ID Mapping lacks listing name and currency, the resolver deterministically chooses at most one returned EODHD symbol for one enrichment Search; it never fans out across every mapped symbol.

Daily bars retain their market date and `date` precision. Raw OHLC/close and adjusted close are stored separately; valuation uses raw close. A greater-than-10% discontinuity in the raw/adjusted ratio creates a corporate-action review state instead of rewriting ledger quantities. The last good observation remains available through provider failures.

## Durable work

`market_data_jobs` stores `resolve`, `refresh_latest`, and `backfill_history` work. Imports and change sets only link securities and enqueue work in their own database transaction; they never call a provider. Workers claim due rows with leases and `FOR UPDATE SKIP LOCKED`, reclaim expired leases, deduplicate active work, and retry transient failures with bounded backoff. Resolve jobs are ordered deterministically by ISIN and globally leased so concurrent workers cannot create a discovery burst after quota reset.

The EODHD daily limit defaults to 20 and may be configured through 100,000. Every EODHD caller, including screenshot investment search, reserves from the same PostgreSQL UTC-day budget before transport. Configured exhaustion and upstream daily-quota responses block new requests and defer affected work until 00:00:05 GMT after the next reset. Redis is used only for the independent disposable per-minute throttle. OpenFIGI mapping requests use the documented keyed/unkeyed request windows and batch sizes. Provider errors are stored as sanitized classifications rather than raw response bodies or credentials.

## Expected EODHD call budget

- New security resolution: one Search call on the normal path; at most three calls on the rare Search → ID Mapping → one enrichment Search fallback.
- Initial history backfill: one EOD range call. Its last completed bar also becomes the latest observation.
- Daily or user-requested price refresh: one EOD range call and no identity resolution.
- Repeated import of an ISIN with active current-revision mappings: zero calls.
- Manual listing change: zero discovery calls and at most one EOD history call. Selecting the already active mapping uses cached history and schedules the normal refresh without an immediate call.

OpenFIGI calls do not consume the EODHD budget.

## Valuation behavior

Within each manual account, legacy asset rows sharing a security are grouped. Current value is quantity × raw close × listing unit multiplier, converted with the latest valid ECB FX observation. Trade cost and charges use dated FX; missing dated FX leaves cost basis and P&L unavailable without hiding a valid current value. Execution price, zero, and an FX rate of one are never substitutes.

Manual-account charts are rebuilt from dated ledger quantities, cash settlements, raw daily closes and dated FX. Prices and FX carry across weekends/holidays for at most seven days. Longer gaps, missing inputs, or a possible quantity-changing corporate action make the affected period partial.

## API and review

Authenticated endpoints under `/api/v1/market-data/securities` expose the held-security review queue, details/evidence, revision-checked selection locks, unlocking, and idempotent refresh. Position payloads add security and price-state metadata without changing the meaning of `currency`: it remains the market-value currency, while `priceCurrency` describes the listing quote.

The iOS Market data screen is available from Settings → Tools and from incomplete accounts/holdings. Only active, current-revision, exact-ISIN EODHD candidates can be selected. A manual selection is revision checked and locked until explicitly returned to automatic selection. Unlocking reuses durable verification; the separate revision-checked Re-resolve action deliberately invalidates it. The screen distinguishes listing selection, quota delay with its next retry time, and a completed exact-ISIN miss.
