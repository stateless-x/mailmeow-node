#!/usr/bin/env bash
# Regenerates src/generated/api.d.ts from mailmeow-be's OpenAPI document.
# No database or network needed: cmd/openapi builds the spec from the routes.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
SPEC="$(mktemp -t mailmeow-openapi.XXXXXX.json)"
trap 'rm -f "$SPEC"' EXIT
(cd ../mailmeow-be && go run ./cmd/openapi) > "$SPEC"
bunx openapi-typescript "$SPEC" -o src/generated/api.d.ts
