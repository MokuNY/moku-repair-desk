#!/bin/bash
cd "$(dirname "$0")" || exit 1
read -r -p "Printer IP address: " IP
OUT="$(pwd)/diag.txt"
{
  echo "=== printer $IP ($(date)) ==="
  printf '! U1 getvar "appl.name"\r\n! U1 getvar "device.product_name"\r\n! U1 getvar "ip.addr"\r\n! U1 getvar "rtc.date"\r\n! U1 getvar "rtc.time"\r\n! U1 getvar "weblink.ip.conn1.location"\r\n! U1 getvar "weblink.ip.conn1.num_connections"\r\n! U1 getvar "weblink.ip.conn1.error"\r\n! U1 getvar "weblink.logging.entries"\r\n' \
    | nc -G 5 -w 6 "$IP" 9100
  echo; echo "=== server log ==="
  "$HOME/.fly/bin/flyctl" logs --app moku-labels-b228fd --no-tail 2>&1 | tail -80
  echo "=== health ==="; curl -sS https://moku-labels-b228fd.fly.dev/health
} > "$OUT" 2>&1
echo "Saved. Tell Claude it's done."
read -r -p "Press Return to close." _
