#!/usr/bin/env bash
# Stops the local dev stack started by up.sh: the API dev server, the native indexer, anvil (the fork's state is lost)
# and the Postgres container (removed with its data). Logs and the generated dev-only secrets stay in .state/ unless
# --purge is given. The next up.sh starts a fresh chain, deployment and database.
# Usage: scripts/dev-stack/down.sh [--purge]
set -euo pipefail

# shellcheck source=config.sh
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

PURGE=0
for arg in "$@"; do
  case $arg in
    --purge) PURGE=1 ;;
    -h | --help)
      sed -n '2,5p' "$0"
      exit 0
      ;;
    *) die "unknown argument: $arg" ;;
  esac
done

stop_service api
stop_service indexer
stop_service anvil

if docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
  if [ "$(docker inspect -f '{{index .Config.Labels "pine.dev-stack"}}' "$PG_CONTAINER")" = "1" ]; then
    docker rm -f "$PG_CONTAINER" >/dev/null
    log "postgres: container $PG_CONTAINER removed"
  else
    log "postgres: container $PG_CONTAINER was not created by up.sh (no pine.dev-stack label); left alone"
  fi
fi

# The chain is gone: its deployment record and the env files derived from it are stale.
rm -f "$STATE_DIR/deployment.json" "$STATE_DIR/api.env" "$STATE_DIR/indexer.env" "$STATE_DIR/frontend.env"
if [ "$PURGE" = 1 ]; then
  rm -rf "$STATE_DIR"
  log "removed $STATE_DIR"
fi

for port in "$API_PORT" "$USER_CONTENT_PORT" "$API_METRICS_PORT" "$INDEXER_METRICS_PORT" "$CONTROL_PORT" "$ANVIL_PORT"; do
  port_busy "$port" && log "warning: port $port is still in use by a process up.sh did not start"
done
log "stopped"
