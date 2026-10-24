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
  printf '%s\n' 'EASI Store needs Node.js 24. Install it from https://nodejs.org/ or use a portable package with its runtime included.'
  printf '%s' 'Press Return to close. '
  read -r _easi_reply
  exit 1
fi
if ! "$EASI_NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) === 24 ? 0 : 1)'; then
  printf '%s\n' 'This EASI Store preview requires Node.js 24. Select Node 24 or use the portable runtime package.'
  exit 1
fi
if [ ! -d node_modules ] || [ ! -f dist/public/index.html ]; then
  printf '%s\n' 'Preparing EASI Store for the first launch. Internet access is needed to install the locked dependencies.'
  npm ci --no-audit --no-fund
  npm run build
fi
EASI_DATA_DIR=${EASI_STORE_DATA_DIR:-"$HOME/Library/Application Support/EASI Store"}
printf '%s\n' "Archive: $EASI_DATA_DIR" 'Opening http://127.0.0.1:8048. Keep this window open; Control-C stops the service.'
exec "$EASI_NODE" src/cli.js start --data-dir "$EASI_DATA_DIR" --host 127.0.0.1 --port "${EASI_STORE_PORT:-8048}" --open
