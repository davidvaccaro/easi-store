#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR/.."
if [ -x "runtime/bin/node" ]; then
  EASI_NODE="$PWD/runtime/bin/node"
else
  EASI_NODE=$(command -v node || true)
fi
if [ -z "$EASI_NODE" ]; then
  printf '%s\n' 'Install Node.js 24 from https://nodejs.org/ or use a portable EASI Store package with its runtime included.'
  exit 1
fi
if ! "$EASI_NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) === 24 ? 0 : 1)'; then
  printf '%s\n' 'This EASI Store preview requires Node.js 24.'
  exit 1
fi
if [ ! -d node_modules ] || [ ! -f dist/public/index.html ]; then
  printf '%s\n' 'Preparing EASI Store. Internet access is needed for the first source launch.'
  npm ci --no-audit --no-fund
  npm run build
fi
EASI_DATA_DIR=${EASI_STORE_DATA_DIR:-"${XDG_DATA_HOME:-$HOME/.local/share}/easi-store"}
printf '%s\n' "Archive: $EASI_DATA_DIR" 'Keep this terminal open. Control-C stops the service.'
exec "$EASI_NODE" src/cli.js start --data-dir "$EASI_DATA_DIR" --host 127.0.0.1 --port "${EASI_STORE_PORT:-8048}" --open
