#!/bin/sh
# Start cloudflared if cert files exist, otherwise skip
if [ -f /root/.cloudflared/cert.pem ] && [ -f /root/.cloudflared/6125a727-b977-4809-9470-bcc6b21dc4b0.json ]; then
  /usr/local/bin/cloudflared tunnel --config /etc/cloudflared/config.yml run 6125a727-b977-4809-9470-bcc6b21dc4b0 &
else
  echo "Warning: Cloudflared certificate files not found. Skipping cloudflared startup."
fi
