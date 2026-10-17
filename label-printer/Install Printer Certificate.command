#!/bin/bash
# Makes the printer trust the print server's HTTPS certificate.
# Follows Zebra's documented method: the server's CA chain as PEM, stored as
# E:WEBLINK1_CA.NRD via a multi-part file sent to port 9100. Then restarts the
# printer and saves its connection log to diag.txt for Claude to read.
cd "$(dirname "$0")" || exit 1
HOST=moku-labels-b228fd.fly.dev
read -r -p "Printer IP address: " IP

echo "Getting the server's certificate chain..."
openssl s_client -connect $HOST:443 -servername $HOST -showcerts </dev/null 2>/dev/null > /tmp/moku-sclient.txt
# keep every certificate except the first (the server's own); those are the CA chain
awk '/-----BEGIN CERTIFICATE-----/{n++} n>=2' /tmp/moku-sclient.txt \
  | awk '/-----BEGIN CERTIFICATE-----/{p=1} p{print} /-----END CERTIFICATE-----/{p=0}' > printer-certs/server-chain.pem
COUNT=$(grep -c "BEGIN CERTIFICATE" printer-certs/server-chain.pem)
[ "$COUNT" -ge 1 ] || { echo "Couldn't read the server's certificates."; read -r _; exit 1; }
echo "  ✓ $COUNT CA certificates"

B="moku$(date +%s)boundary"
{
  printf '! U1 do "file.delete" "E:WEBLINK1_CA.NRD"\r\n'
  printf '{}--%s\r\n' "$B"
  printf 'Content-Disposition: form-data; name="files"; filename="E:WEBLINK1_CA.NRD"\r\n'
  printf 'Content-Type: application/octet-stream\r\n'
  printf 'Content-Transfer-Encoding: binary\r\n\r\n'
  cat printer-certs/server-chain.pem
  printf '\r\n--%s--\r\n' "$B"
} > /tmp/moku-ca.txt

echo "Sending them to the printer..."
nc -G 5 -w 6 "$IP" 9100 < /tmp/moku-ca.txt || { echo "Couldn't reach the printer at $IP"; read -r _; exit 1; }
sleep 3
printf '! U1 getvar "file.dir"\r\n' | nc -G 5 -w 4 "$IP" 9100 > /tmp/moku-dir.txt
grep -i "WEBLINK1_CA" /tmp/moku-dir.txt || echo "  ✗ Didn't see the certificate file (continuing anyway)"

echo "Restarting the printer..."
printf '! U1 do "device.reset" ""\r\n' | nc -G 5 -w 3 "$IP" 9100
echo "Waiting 90 seconds for it to restart and connect..."
sleep 90
{
  echo "=== chain sent ==="; grep -E "^ *[0-9] s:|^ *i:" /tmp/moku-sclient.txt
  echo "=== files ==="; grep -i weblink /tmp/moku-dir.txt
  echo; echo "=== weblink log ($(date)) ==="
  printf '! U1 getvar "weblink.ip.conn1.num_connections"\r\n! U1 getvar "weblink.logging.entries"\r\n' | nc -G 5 -w 6 "$IP" 9100
} > diag.txt 2>&1
echo "Done. Reload the Zebra Label Printer page in Shopify, and tell Claude it's finished."
read -r -p "Press Return to close." _
