#!/bin/sh
set -eu
mkdir -p /app/data/uploads /app/data/family-documents /app/backups
chown -R node:node /app/data /app/backups
exec su-exec node "$@"
