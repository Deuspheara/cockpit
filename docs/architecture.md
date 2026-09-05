# Architecture

One private SwiftUI client talks to a Fastify API. PostgreSQL is the authority; Redis is disposable cache. The API and scheduled worker share explicit domain services and a single database. Caddy terminates TLS. No services hold trading credentials.

Financial quantities use PostgreSQL numeric(38,18), decimal.js, decimal strings over JSON, and Swift Decimal. Ledger events determine manual positions; observations represent evidence without invented history. Provider observations are authoritative for connected positions. Unknown costs and missing exchange rates remain unknown.

Financial proposals are typed, validated change sets. Apply and undo execute atomically with audit records and conflict checks. Recurrences use dated versions with stable series identities. Valuations are aligned batches, never synthetic reconstruction at request time.

The API and worker use the same domain services. Handwritten SQL migrations own constraints and indexes; Drizzle table definitions support typed access. Separate small SQL/Drizzle pools avoid implicit serializer changes. See blueprint.md for the full accepted specification. External models are untrusted interpreters with allowlisted tools; they cannot apply proposals, fetch arbitrary URLs, access secrets, or trade.
