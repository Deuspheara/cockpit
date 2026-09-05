# Financial semantics

Money/quantities are numeric(38,18), represented by decimal strings in JSON. Currency is explicit. No ticker-only identity and no account balance field exists. Account inputs reject unknown fields including total balances and credentials.

Manual trades carry positive quantities and a semantic direction. An explicit cash ledger also includes BUY/SELL settlement (gross plus/minus fees). An incomplete settlement price makes the cash valuation unavailable. With no ledger, the latest observation may represent a holding without inventing history. If a ledger exists for that asset it remains the expectation; observations are reconciliation evidence. Cost basis uses known weighted-average purchase costs only, and becomes unavailable when acquisition history is incomplete.

A dashboard reports `complete=false` when any position cannot be valued in the selected currency. Its value is then a known subtotal, and clients must label it accordingly. Missing FX is never treated as parity; snapshots skip incomplete totals. Selected-period deltas are changes in value, not cash-flow-adjusted investment returns.

Change sets contain deterministic before/after records. Apply locks financial job execution, checks each current row against the preview, commits all records with audit history, and stores exact inverses. A stale preview/undo fails with conflict. Retrospective recurrence edits also check for occurrences generated after the preview. Dated rule versions retain their series identity. Cash-amount rules remain planned; explicitly enabled quantity rules can auto-post with unknown cost basis.

Production starts empty. The dev-only seed requires an empty account registry and tags synthetic holdings. Demo crypto connections have synchronization disabled.
