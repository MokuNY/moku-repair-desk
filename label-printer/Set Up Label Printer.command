#!/bin/bash
# Moku label printer: one-time setup. Double-click this file to run it.
# Safe to run again: it remembers what's done and picks up where it left off.

cd "$(dirname "$0")" || exit 1
APP_DIR="$(pwd)"
SHOP="moku-surf-shop-ny.myshopify.com"
STATE="$APP_DIR/.setup-state"
[ -f "$STATE" ] && . "$STATE"

say()  { printf "\n\033[1;36m==> %s\033[0m\n" "$1"; }
ok()   { printf "\033[1;32m    ✓ %s\033[0m\n" "$1"; }
fail() { printf "\n\033[1;31m    ✗ %s\033[0m\n" "$1"; printf "\nSend a screenshot of this window to Claude.\n"; read -r -p "Press Return to close." _; exit 1; }
save() { echo "$1=\"$2\"" >> "$STATE"; eval "$1=\"$2\""; }

clear
echo "Moku label printer setup"
echo "------------------------"
echo "This takes about 15 minutes. A browser will open a few times for you to log in."

# 1. Node.js ---------------------------------------------------------------
say "Step 1 of 6: Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo "    Node.js isn't installed yet. Opening the download page."
  echo "    Download the macOS installer (LTS), install it, then double-click this file again."
  open "https://nodejs.org/en/download"
  read -r -p "Press Return to close." _; exit 0
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || { open "https://nodejs.org/en/download"; fail "Node.js $NODE_MAJOR is too old. Install the current LTS version, then run this again."; }
ok "Node.js $(node -v)"

# 2. Packages --------------------------------------------------------------
say "Step 2 of 6: Installing the Shopify tools (a minute or two)"
npm install --no-fund --no-audit >/tmp/moku-npm.log 2>&1 || { tail -20 /tmp/moku-npm.log; fail "npm install failed."; }
ok "Installed"

# 3. Shopify app -----------------------------------------------------------
say "Step 3 of 6: Creating the app in Shopify"
if [ -z "$SHOPIFY_TOML" ]; then
  echo "    Log in with your Shopify account when the browser opens."
  echo "    When asked, choose to CREATE A NEW APP and name it: Moku Label Printer"
  npx shopify app config link || fail "Couldn't link the Shopify app."
  TOML=$(grep -l '^client_id' shopify.app*.toml | xargs grep -L 'REPLACE_WITH_CLIENT_ID' | head -1)
  [ -n "$TOML" ] || fail "Couldn't find the new app's settings file."
  npx shopify app config use "$TOML" >/dev/null 2>&1
  save SHOPIFY_TOML "$TOML"
fi
ENV_OUT=$(npx shopify app env show 2>/dev/null)
API_KEY=$(echo "$ENV_OUT" | grep 'SHOPIFY_API_KEY=' | sed 's/.*SHOPIFY_API_KEY=//' | tr -d '[:space:]')
API_SECRET=$(echo "$ENV_OUT" | grep 'SHOPIFY_API_SECRET=' | sed 's/.*SHOPIFY_API_SECRET=//' | tr -d '[:space:]')
[ -n "$API_KEY" ] && [ -n "$API_SECRET" ] || fail "Couldn't read the app's keys from Shopify."
ok "Shopify app ready ($SHOPIFY_TOML)"

# 4. Fly.io print server ---------------------------------------------------
say "Step 4 of 6: Putting the print server online (Fly.io)"
FLY="$HOME/.fly/bin/flyctl"
command -v flyctl >/dev/null 2>&1 && FLY="$(command -v flyctl)"
if [ ! -x "$FLY" ]; then
  curl -fsSL https://fly.io/install.sh | sh >/tmp/moku-fly.log 2>&1 || fail "Couldn't install the Fly.io tool."
fi
if ! "$FLY" auth whoami >/dev/null 2>&1; then
  echo "    Log in or sign up with Fly.io in the browser. They'll ask for a card (about \$2-5/month for this)."
  "$FLY" auth login || fail "Fly.io login didn't finish."
fi
if [ -z "$FLY_APP" ]; then
  NAME="moku-labels-$(node -e 'console.log(require("crypto").randomBytes(3).toString("hex"))')"
  "$FLY" apps create "$NAME" || fail "Couldn't create the Fly.io app. If it mentions billing, add a card at fly.io/dashboard, then run this again."
  save FLY_APP "$NAME"
fi
if [ -z "$PRINTER_TOKEN" ]; then
  save PRINTER_TOKEN "$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
fi
APP_URL="https://$FLY_APP.fly.dev"
cd "$APP_DIR/server" || exit 1
sed -i '' "s/^app = .*/app = \"$FLY_APP\"/" fly.toml
"$FLY" secrets set --app "$FLY_APP" --stage \
  SHOPIFY_API_KEY="$API_KEY" SHOPIFY_API_SECRET="$API_SECRET" \
  PUBLIC_URL="$APP_URL" PRINTERS="Front counter=$PRINTER_TOKEN" >/dev/null || fail "Couldn't save the server settings."
"$FLY" deploy --app "$FLY_APP" --remote-only --ha=false || fail "The server didn't deploy."
cd "$APP_DIR" || exit 1
curl -fsS "$APP_URL/health" >/dev/null 2>&1 || sleep 10
curl -fsS "$APP_URL/health" >/dev/null || fail "The server is deployed but not answering at $APP_URL"
ok "Print server live at $APP_URL"

# 5. Shopify extension -----------------------------------------------------
say "Step 5 of 6: Sending the Print labels button to Shopify"
APP_URL="$APP_URL" TOML="$SHOPIFY_TOML" node -e '
  const fs = require("fs"); const f = process.env.TOML; const u = process.env.APP_URL;
  let t = fs.readFileSync(f, "utf8");
  t = t.replace(/^application_url\s*=.*$/m, `application_url = "${u}"`);
  t = /redirect_urls\s*=/.test(t)
    ? t.replace(/redirect_urls\s*=\s*\[[^\]]*\]/s, `redirect_urls = [ "${u}/auth/callback" ]`)
    : t + `\n[auth]\nredirect_urls = [ "${u}/auth/callback" ]\n`;
  if (!/^\[access_scopes\]/m.test(t)) t += `\n[access_scopes]\nscopes = "read_products"\n`;
  else if (!/^scopes\s*=/m.test(t)) t = t.replace(/^\[access_scopes\]\s*$/m, `[access_scopes]\nscopes = "read_products"`);
  else t = t.replace(/^scopes\s*=.*$/m, `scopes = "read_products"`);
  fs.writeFileSync(f, t);
' || fail "Couldn't update the Shopify app settings."
npx shopify app deploy --allow-updates || fail "Shopify deploy failed."
ok "Released to Shopify"

# 6. Printer -----------------------------------------------------------------
say "Step 6 of 6: Pointing the printer at the server"
node scripts/printer-config.js --host "$FLY_APP.fly.dev" --token "$PRINTER_TOKEN" --name "Front counter" >/dev/null
echo "    The printer must already be on your Wi-Fi (Zebra Printer Setup Utility app on the iPad)."
echo "    Its IP address is in that app, or on the printout from holding the Feed button ~5 seconds."
read -r -p "    Printer IP address (or press Return to skip for now): " PRINTER_IP
if [ -n "$PRINTER_IP" ]; then
  if nc -z -G 5 "$PRINTER_IP" 9100 2>/dev/null; then
    nc -G 5 "$PRINTER_IP" 9100 < weblink-front-counter.txt && ok "Settings sent. The printer restarts and connects within a minute."
  else
    echo "    Couldn't reach a printer at $PRINTER_IP. Check that this Mac is on the same Wi-Fi, then run this again."
  fi
fi

echo
echo "------------------------------------------------------------"
echo "Almost done. Last step, in the browser:"
echo "  1. Go to dev.shopify.com and open the app 'Zebra Label Printer'."
echo "  2. Choose Distribution > Custom distribution, enter: $SHOP"
echo "  3. Open the install link it gives you and click Install."
echo "Then in Shopify: Apps > Zebra Label Printer shows the printer status and a Test print button."
echo "------------------------------------------------------------"
read -r -p "Press Return to close." _
