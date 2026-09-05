#!/bin/sh
set -eu
umask 077
mkdir -p backups
archive="backups/finance-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$archive"
printf '%s\n' "$archive"
