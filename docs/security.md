# Security

Device tokens contain 32 random bytes; only SHA-256 hashes are stored. All application routes require bearer authentication. /health exposes availability only. Logs exclude authorization, bodies, financial model context and secrets. Production uses HTTPS through Caddy; PostgreSQL and Redis have no published ports.

Public address adapters must only use provider read APIs. Private keys, seeds, trading credentials, wallet signing and live execution are outside this application. Future live bots require a separate worker and credentials security boundary.

Backups contain private financial records and token hashes; protect and copy them off-host. Raw device tokens and .env are not database records. Keep server keys in the deployment environment. Rotate a device by creating a new token, pairing the device, then revoking the old token ID.
