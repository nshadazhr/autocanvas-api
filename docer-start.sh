#!/bin/sh
set -eu


npx --no-install prisma migrate deploy --config prisma7.config.ts
exec node dist/main.js