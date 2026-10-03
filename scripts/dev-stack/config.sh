# Shared settings and helpers of scripts/dev-stack (sourced by up.sh and down.sh). DEVELOPMENT ONLY: every listener is
# loopback, the chain is a local anvil fork, the only keys are anvil's public dev accounts.
# shellcheck shell=bash disable=SC2034

DEV_STACK_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$DEV_STACK_DIR/../.." && pwd)
STATE_DIR=$DEV_STACK_DIR/.state
LOG_DIR=$STATE_DIR/logs
PID_DIR=$STATE_DIR/pids

PG_CONTAINER=pine-dev-pg
PG_IMAGE=postgres:16-alpine
PG_PORT=55432
PG_DB=pine
ANVIL_PORT=8545
API_PORT=3000
USER_CONTENT_PORT=3001
API_METRICS_PORT=9464
INDEXER_METRICS_PORT=9465
CONTROL_PORT=3999
PUBLIC_ORIGIN=http://localhost:3004
USER_CONTENT_ORIGIN=http://127.0.0.1:$USER_CONTENT_PORT
RPC_PRIMARY=http://127.0.0.1:$ANVIL_PORT
# A second spelling of the same node: the indexer requires two RPC URLs on different hosts.
RPC_SECONDARY=http://localhost:$ANVIL_PORT
# Archive RPCs to fork from (read-only). Override with PINE_DEV_FORK_URL / PINE_DEV_FORK_BLOCK.
FORK_URLS=${PINE_DEV_FORK_URL:-https://rpc.gnosischain.com https://rpc.gnosis.gateway.fm}
FORK_BLOCK=${PINE_DEV_FORK_BLOCK:-48570000}
# anvil dev account #0 (public test mnemonic "test test ... junk"; exists only on the local fork): the deployer.
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

log() { printf '[dev-stack] %s\n' "$*"; }
die() {
  printf '[dev-stack] ERROR: %s\n' "$*" >&2
  exit 1
}

# pid of a service started by up.sh when it is still running, else nothing.
service_pid() {
  local file=$PID_DIR/$1.pid pid
  [ -f "$file" ] || return 1
  pid=$(tr -cd '0-9' <"$file")
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "$pid"
}

# Stops a service started by up.sh (its whole process group: it runs in its own session), SIGTERM then SIGKILL.
stop_service() {
  local name=$1 pid
  if pid=$(service_pid "$name"); then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    fi
    log "$name: stopped (pid $pid)"
  fi
  rm -f "$PID_DIR/$name.pid"
}

# JSON-RPC call to the local anvil; prints the raw JSON response.
rpc_call() {
  curl -s -m 5 -X POST -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}" "$RPC_PRIMARY"
}

# True when something listens on 127.0.0.1:<port>.
port_busy() { nc -z 127.0.0.1 "$1" >/dev/null 2>&1; }
