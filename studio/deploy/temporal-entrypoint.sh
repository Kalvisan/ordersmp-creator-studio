#!/bin/sh
set -eu
umask 077
: "${SQL_PASSWORD:?The Temporal database credential is required}"
export SQL_USER=temporal
# Official versioned schema tools are idempotent, with no overwrite/reset flag.
# A create failure is followed by a required authenticated schema check.
for database in temporal temporal_visibility; do
  temporal-sql-tool --ep 127.0.0.1 --port 15433 --user temporal --plugin postgres12 --db "$database" create-database >/dev/null 2>&1 || true
  temporal-sql-tool --ep 127.0.0.1 --port 15433 --user temporal --plugin postgres12 --db "$database" setup-schema -v 0.0 >/dev/null 2>&1 || {
    echo 'Temporal database setup failed; existing data was retained.' >&2; exit 1;
  }
  schema=temporal
  [ "$database" != temporal_visibility ] || schema=visibility
  temporal-sql-tool --ep 127.0.0.1 --port 15433 --user temporal --plugin postgres12 --db "$database" update-schema -d "/etc/temporal/schema/postgresql/v12/$schema/versioned" >/dev/null 2>&1 || {
    echo 'Temporal schema update failed; inspect the database before retrying.' >&2; exit 1;
  }
done
temporal-server --config-file /etc/temporal/studio.yaml --allow-no-auth start &
server=$!
trap 'kill -TERM "$server" 2>/dev/null || true; wait "$server"; exit' TERM INT
attempt=0
until temporal --address 127.0.0.1:17233 operator cluster health >/dev/null 2>&1; do
  kill -0 "$server" 2>/dev/null || { wait "$server"; exit 1; }
  attempt=$((attempt + 1))
  [ "$attempt" -lt 90 ] || { kill -TERM "$server"; wait "$server"; exit 1; }
  sleep 1
done
if ! temporal --address 127.0.0.1:17233 operator namespace describe --namespace ordersmp >/dev/null 2>&1; then
  temporal --address 127.0.0.1:17233 operator namespace create --namespace ordersmp --retention 7d >/dev/null 2>&1 || {
    kill -TERM "$server"; wait "$server"; exit 1;
  }
fi
touch /tmp/creator-temporal-ready
wait "$server"
