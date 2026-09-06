# Shared security and market-data pipeline

Migration `0014_market_data_pipeline.sql` adds a shared security identity above legacy assets. Assets and their transaction/audit history are not rewritten: every valid normalized ISIN is linked to one `securities` row, duplicate assets share it, and the oldest asset remains the canonical legacy reference.

## Provider boundary

EODHD is the only price source. A selectable route must be an EODHD mapping verified against the exact security ISIN. OpenFIGI supplies supporting identity/ticker evidence when direct EODHD search is insufficient; an OpenFIGI result alone is never selectable and its exchange code is never manufactured into an EODHD symbol. Name and CSV currency similarity do not establish identity.

Daily bars retain their market date and `date` precision. Raw OHLC/close and adjusted close are stored separately; valuation uses raw close. A greater-than-10% discontinuity in the raw/adjusted ratio creates a corporate-action review state instead of rewriting ledger quantities. The last good observation remains available through provider failures.

## Durable work

`market_data_jobs` stores `resolve`, `refresh_latest`, and `backfill_history` work. Imports and change sets only link securities and enqueue work in their own database transaction; they never call a provider. Workers claim due rows with leases and `FOR UPDATE SKIP LOCKED`, reclaim expired leases, deduplicate active work, and retry transient failures with bounded backoff. Redis is used only for disposable provider call-unit throttles.

The EODHD daily limit defaults to 20 and may be configured through 100,000. Its per-minute limit is independent. OpenFIGI mapping requests use the documented keyed/unkeyed request windows and batch sizes. Provider errors are stored as sanitized classifications rather than raw response bodies or credentials.

## Valuation behavior

Within each manual account, legacy asset rows sharing a security are grouped. Current value is quantity × raw close × listing unit multiplier, converted with the latest valid ECB FX observation. Trade cost and charges use dated FX; missing dated FX leaves cost basis and P&L unavailable without hiding a valid current value. Execution price, zero, and an FX rate of one are never substitutes.

Manual-account charts are rebuilt from dated ledger quantities, cash settlements, raw daily closes and dated FX. Prices and FX carry across weekends/holidays for at most seven days. Longer gaps, missing inputs, or a possible quantity-changing corporate action make the affected period partial.

## API and review

Authenticated endpoints under `/api/v1/market-data/securities` expose the held-security review queue, details/evidence, revision-checked selection locks, unlocking, and idempotent refresh. Position payloads add security and price-state metadata without changing the meaning of `currency`: it remains the market-value currency, while `priceCurrency` describes the listing quote.

The iOS Market data screen is available from Settings → Tools and from incomplete accounts/holdings. Only verified same-ISIN EODHD candidates can be selected. A manual selection is revision checked and locked until explicitly changed or returned to automatic resolution.
