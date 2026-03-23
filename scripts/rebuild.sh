#!/bin/bash
set -e

cd "$(dirname "$0")/.."

docker compose rm -sf clickup-mcp-server-http
docker compose build --no-cache clickup-mcp-server-http
docker compose up -d clickup-mcp-server-http

echo "Done. Logs:"
docker compose logs --tail=20 clickup-mcp-server-http
