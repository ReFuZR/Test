# Loomline: a drop shipping clothing shop

A storefront for everyday basics (tees, fleece, bottoms, accessories). Customers pay through **Stripe Checkout**. Each paid order becomes a supplier order with the right SKUs, and you send it to your supplier from a small **Orders** page. You don't hold any stock.

```
Customer ──> shop (GitHub Pages) ──> Worker /checkout ──> Stripe Checkout (card, Apple Pay, address, phone)
                                                               │ paid
Your supplier <── CSV / Zapier / Make <── Orders page <── Worker /webhook (stores order with supplier SKUs)
```

It costs nothing to run except Stripe's fee (2.9% + 30¢ per US card payment). GitHub Pages and Cloudflare Workers' free tier cover the rest.

## What's here

| File | What it is |
|---|---|
| `index.html`, `shop.css`, `shop.js` | The store: product grid, filters, product sheet with colour and size, cart drawer, checkout |
| `cart.js` | Cart rules (quantity cap, free-shipping progress, cleaning up a stale cart) |
| `art.js` | Garment illustrations, used until you add real photos |
| `catalog.json` | **Your products, prices, colours, sizes and shipping rates.** Public. |
| `config.js` | Your Worker's address and your contact email |
| `admin.html`, `admin.js` | **Orders page**: paid orders, supplier CSV, mark ordered or shipped with tracking |
| `worker/` | The Cloudflare Worker: creates Stripe Checkout sessions, receives Stripe's webhook, stores orders |
| `worker/supplier.json` | **Private**: your cost, shipping cost and supplier SKU for each product. Bundled into the Worker and never published. |

Run `node scripts/shop-margins.mjs` from the repo root to see the profit on each product after supplier cost, supplier shipping and Stripe fees.

## Launch checklist

### 1. Pick a supplier and fix your prices

1. Sign up with a supplier that ships blank or private-label apparel to your customers (for example CJ Dropshipping, Printful, Printify or Spocket). Order samples of everything you plan to sell, so you can check the quality and the real delivery time.
2. In `worker/supplier.json`, put each product's real `cost`, `shipCost` (in cents) and `sku`. SKU patterns can use `{color}` and `{size}`: `"LL-HTEE-{color}-{size}"` becomes `LL-HTEE-HEATHERGREY-2XL`. If a product's SKUs don't follow a pattern, list it as one product per colour. The Orders page flags any item it can't map to a SKU.
3. Edit `catalog.json`: names, prices, colours, sizes and the shipping rates and delivery days you'll show customers. Make the days honest: add the supplier's processing time to the carrier's time.
4. Run `node scripts/shop-margins.mjs`. Aim for at least 40% before advertising costs.
5. Product photos: add `"image": "images/heavy-tee.jpg"` to a product, or `"images": { "Black": "images/tee-black.jpg", "Bone": "..." }` for one per colour, and put the files in `shop/images/`. (Then add `shop/images` to the `cp` line in `.github/workflows/site.yml`.) Most suppliers let you use their photos; check before you do.

### 2. Stripe

1. Create an account at stripe.com and complete the business details. Start in **test mode**.
2. **Developers → API keys**: copy the **Secret key** (`sk_test_...`).

### 3. Deploy the Worker (Cloudflare, free)

You need Node 18 or later and a free Cloudflare account.

```bash
cd shop/worker
npx wrangler login
npx wrangler kv namespace create ORDERS          # paste the id it prints into wrangler.toml
# edit wrangler.toml: SHOP_URL, ALLOWED_ORIGIN, ALLOWED_COUNTRIES
npx wrangler secret put STRIPE_SECRET_KEY        # sk_test_...
npx wrangler secret put ADMIN_TOKEN              # a long random password for the Orders page
npx wrangler deploy                              # prints https://loomline-shop.<you>.workers.dev
```

### 4. Connect Stripe's webhook

1. Stripe → **Developers → Webhooks → Add endpoint**: `https://loomline-shop.<you>.workers.dev/webhook`
2. Events: `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
3. Copy the **Signing secret** and run `npx wrangler secret put STRIPE_WEBHOOK_SECRET`.

### 5. Point the shop at the Worker and publish

1. In `config.js`, set `apiBase` to your Worker's address and `contactEmail` to an inbox you check.
2. Commit and push. The **Build and publish** workflow puts the shop at `https://<you>.github.io/Test/shop/`.

### 6. Test the whole thing, then go live

1. Buy something using Stripe's test card `4242 4242 4242 4242`, any future date, any CVC.
2. Open `https://<you>.github.io/Test/shop/admin.html`, enter the Worker address and your admin token. The order should be there with its SKUs.
3. When it all works: switch Stripe to live mode, `wrangler secret put` the live secret key and the live webhook's signing secret, and redeploy.

## Fulfilling orders

On the Orders page:

1. **To order** lists paid orders you haven't sent to the supplier yet. **Download CSV** gives one row per item with the customer's address, phone and SKU. Most suppliers accept this for a bulk order, or you can copy it into their order form.
2. After you've placed it with the supplier, tap **Mark ordered from supplier**.
3. When the supplier gives you tracking, enter the carrier and number and tap **Mark shipped**. Email the customer their tracking number. Stripe already sent them a receipt (turn on **Settings → Emails → Successful payments**).

**Automatic hand-off (optional).** Set `npx wrangler secret put SUPPLIER_WEBHOOK_URL` to a Zapier or Make "catch hook" URL. Every paid order is POSTed there as JSON, and from there you can create the order in your supplier's app, add a row to a Google Sheet, or email yourself. If the hand-off fails, the order is still saved and the Orders page shows the error.

Refunds and cancellations are done in the Stripe dashboard. **Cancel** on the Orders page only marks the order.

## Before you take real money

- **Taxes.** You may have to collect sales tax or VAT. Turn on Stripe Tax and set `AUTOMATIC_TAX = "true"` in `wrangler.toml`, or ask an accountant.
- **Policies.** The Shipping, Returns, Privacy and Contact pages in the footer are written in `shop.js` (`policyHtml`). Make them match what you and your supplier actually do, especially the return address and delivery times.
- **Business details.** Stripe needs a business name and a statement descriptor customers will recognise on their card statement.
- **Brand.** "Loomline" is a placeholder. Check that whatever name you use isn't someone else's trademark, and change it in `catalog.json` (`store`), `index.html`, `admin.html` and `icon.svg`.
- **Delivery times.** The most common drop shipping complaint is slow, surprise delivery. The shop shows "6–12 business days" in three places. Keep that number honest.

## Security

- Prices come only from the `catalog.json` bundled into the Worker. Whatever the browser sends, a customer can't change what they pay.
- Webhooks are checked against Stripe's signature, and Stripe's retries never create a duplicate order.
- The Orders API needs `ADMIN_TOKEN`. If that secret isn't set, the API stays locked.
- `supplier.json` is bundled into the Worker and never published to the shop.
- Customer-typed fields are neutralised in the CSV so a spreadsheet can't run them as formulas.

## Tests

From the repo root: `node --test test/shop.test.js test/e2e-shop.test.js` (the browser tests need Playwright).
