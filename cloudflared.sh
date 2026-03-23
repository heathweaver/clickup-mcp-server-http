#!/bin/sh
# Start cloudflared if cert files exist, otherwise skip
if [ -f /root/.cloudflared/cert.pem ] && [ -f /root/.cloudflared/*.json ]; then
  TUNNEL_ID=$(ls /root/.cloudflared/*.json | head -1 | xargs basename | sed 's/.json//')
  /usr/local/bin/cloudflared tunnel --config /etc/cloudflared/config.yml run "$TUNNEL_ID" &
else
  echo "Warning: Cloudflared certificate files not found. Skipping cloudflared startup."
fi
