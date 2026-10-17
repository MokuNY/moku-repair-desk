# Zebra Label Printer for Shopify

Print price labels (logo, price, product, variant, SKU, barcode) on a Zebra ZD411 straight from the Shopify app on an iPad. Nothing is installed on the iPad and nothing is paired.

```
iPad: Shopify app ── More actions → Print labels
        │  (admin action extension, authenticated with Shopify's ID token)
        ▼
Print server (this repo, /server) ──── ZPL ────►  ZD411 on store Wi-Fi
        ▲                                             │
        └───── WebSocket the printer opens to us ◄────┘   (Zebra "Weblink")
```

**Why it works this way.** iOS won't let a Shopify page talk to a device on your local network. So the printer dials out to the server, and the server pushes labels down that open connection. This works from any iPad on any network.

## What's in here

| Path | What it is |
|---|---|
| `extensions/print-labels/` | Admin actions: product page, variant page, and bulk selection in the product list. Each one has a quantity per variant, plus **1 each** / **Match stock** / **Clear** buttons. |
| `server/` | Zero-dependency Node server: Weblink endpoint, `/api/print`, app home page with printer status and a test print. |
| `server/assets/logo.png` | **Replace with your logo.** Use a PNG, black on white or transparent, and wider than tall. |
| `scripts/printer-config.js` | Generates the commands that point the printer at your server. |

## Setup (about an hour, one time)

### 1. Create the app
1. Run `npm install` in this folder, then `npx shopify app config link` and create a new app. This fills in `client_id`.
2. Distribution: choose **Custom distribution** for your store only.

### 2. Deploy the print server
It must be always on, reachable over HTTPS, and support WebSockets. Fly.io config is included (`server/fly.toml`); any Docker host works.

```bash
cd server
fly launch --copy-config --no-deploy
node ../scripts/printer-config.js --new-token        # copy the token
fly secrets set SHOPIFY_API_KEY=<client id> SHOPIFY_API_SECRET=<client secret> \
  ALLOWED_SHOPS=<your-store>.myshopify.com PUBLIC_URL=https://<app>.fly.dev \
  PRINTERS="Front counter=<token>"
fly deploy
```

Then set `application_url` and `redirect_urls` in `shopify.app.toml` to that URL, run `npm run deploy` from the root, and install the app on your store.

### 3. Put the printer on Wi-Fi
Use the **Zebra Printer Setup Utility** app on the iPad. It connects over Bluetooth; there, set up Wi-Fi. Note the printer's IP address.

### 4. Point the printer at the server
From a Mac or PC on the store Wi-Fi:

```bash
node scripts/printer-config.js --host <app>.fly.dev --token <token> --name "Front counter"
nc <printer-ip> 9100 < weblink-front-counter.txt
```

The file sets the printer clock (it's needed for the TLS check) and the Weblink URL, then restarts the printer. Within a minute, the app's home page shows the printer as **Connected**. Tap **Test print**.

On Windows, use Zebra Setup Utilities → *Open Communication with Printer* and paste the file contents.

### 5. Calibrate the labels once
Load the label roll and hold the pause and feed buttons for about 2 seconds (Zebra's media calibration). Then do a test print.

## Using it
* **One product:** open it → **⋯ More actions → Print labels** → set quantities → **Print**.
* **One variant:** same, from the variant page.
* **Many products:** in Products, select them → **⋯** in the bulk bar → **Print labels**.
* **Receiving stock:** tap **Match stock** to print one label per unit on hand.

## Barcodes
Each label gets a barcode that Shopify POS can scan:

1. **Vendor UPC/EAN.** If the variant's **Barcode** field in Shopify holds a valid UPC-A, EAN-13 or EAN-8, that is what prints. The check digit is verified first.
2. **Private label.** If the Barcode field is empty, the **SKU** prints as Code 128. The SKU also appears in text under the bars.
3. **Your own numeric codes.** Anything else in the Barcode field prints exactly as entered, as Code 128. All-digit codes use Code 128's compact numeric mode.

Whatever prints scans back as the exact text stored in Shopify, so POS finds the variant.

**SKU length on 2" labels.** At 203 dpi, SKUs up to about 14 characters fit as a barcode; longer SKUs print as text only. A 300 dpi printer fits about 20. If you'd rather keep long SKUs, put a short numeric code in the Barcode field instead.

**Selling private label through other retailers.** Most retailers require real GS1 UPCs, bought from GS1 US. Enter them in the Barcode field and they print as UPC-A automatically.

**Layout.** On 2" × 1" labels the product name is dropped to give the barcode room. On 2" × 1.5" labels, everything fits.

## Label settings (`server/.env` or host secrets)
| Setting | Default | |
|---|---|---|
| `LABEL_WIDTH_IN` / `LABEL_HEIGHT_IN` | `2` / `1` | Must match your roll. A ZD411 prints at most about 2.2" wide. |
| `BARCODES` | `true` | Set it to `false` for text-only labels with a big price. |
| `SHOW_PRODUCT_TITLE` | `auto` | Prints the product name when there's room. Set it to `false` to never print it. |
| `LOGO_PATH` | `assets/logo.png` | Leave it empty for no logo. |
| `LOGO_ALIGN` | `left` | Or `center`. |
| `LOGO_DITHER` | `false` | Set it to `true` for logos with gradients or photos. |

DPI (203 or 300) is read from the printer automatically. You can add more printers as extra `Name=token` entries in `PRINTERS`; a printer picker appears automatically.

## Troubleshooting
**Printer never shows Connected.** Read its Weblink log (send `! U1 getvar "weblink"` followed by Enter over `nc`).
* *SSL certificate problem / unable to get local issuer certificate:* the printer doesn't trust your host's certificate authority. Either upload that root CA to the printer (Zebra PrintSecure guide → certificates), or terminate TLS in this server: set `TLS_CERT_FILE` and `TLS_KEY_FILE`, and route raw TCP 443 to it.
* *Handshake failure:* older Link-OS firmware only speaks `AES128-SHA`/`AES256-SHA`. Either update the printer firmware (Zebra Printer Setup Utility → Firmware), or use the in-process TLS option above, which offers those ciphers.
* *Certificate not yet valid / expired:* the printer clock is wrong. Re-send the config file.

**"Printer reports: paper out / head open."** The server tracks these alerts from the printer and blocks jobs until they clear. Fix the printer and print again.

**Labels print shifted or skip.** Recalibrate (step 5) and confirm the label size settings match the roll.

## Repair Desk labels (`/api/repair-label`)
The Repair Desk prints a QR intake label for each repair through `POST /api/repair-label`. The label has the job number, the customer's first name and last initial, the board, the intake date, the last 4 digits of the phone, and a QR code that opens the ticket. It uses the same printer and roll as price labels.

* **Off by default.** The route exists only when the `REPAIR_DESK_TOKEN` secret is set. Without it the server behaves exactly as before.
* **Auth:** `Authorization: Bearer <REPAIR_DESK_TOKEN>`, separate from Shopify tokens.
* **Prints once:** each request carries an `idempotencyKey`. The same key within 24 hours returns the first result without printing again. A failed print is forgotten, so it can be retried with the same key.
* The Repair Desk sends plain fields (job number, name, board…); the layout and ZPL are built here, so no raw printer commands cross between the services.

## Security notes
* Every API call needs a valid Shopify ID token for your app; `ALLOWED_SHOPS` limits it to your store.
* A printer's token is its password. Anyone holding it could connect a device and receive label data (SKUs and prices only). To rotate it, change `PRINTERS` and re-run step 4.

## Tests
`npm test` runs end-to-end tests against a simulated ZD411 that speaks the Weblink protocol. The tests check auth, channel setup, DPI detection, binary-only frames, alert handling, and the generated ZPL.
