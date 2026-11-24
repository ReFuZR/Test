// Shop backend and cart: pricing can't be tampered with, webhooks are verified and idempotent,
// orders map to supplier SKUs, admin routes are locked, and the catalog stays consistent.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { createHandler, formEncode, priceCart, checkoutParams, verifyStripeSignature, orderFromSession, ordersToCsv, skuFor } from "../shop/worker/src/app.js";
import { sanitizeCart, addToCart, setQty, subtotal, count, freeShipping, money } from "../shop/cart.js";
import { margins } from "../scripts/shop-margins.mjs";

const catalog = JSON.parse(readFileSync(new URL("../shop/catalog.json", import.meta.url)));
const supplier = JSON.parse(readFileSync(new URL("../shop/worker/supplier.json", import.meta.url)));
const ENV_BASE = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", SHOP_URL: "https://me.github.io/Test/shop/", ALLOWED_ORIGIN: "https://me.github.io", ALLOWED_COUNTRIES: "us, ca", ADMIN_TOKEN: "admintoken123" };

function memoryKV() {
  const m = new Map();
  return {
    m,
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => { m.set(k, v); },
    list: async ({ prefix }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  };
}

function setup({ stripe = {}, supplierHook } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const u = new URL(url);
    if (u.host === "api.stripe.com") {
      if (opts.method === "POST" && u.pathname === "/v1/checkout/sessions") {
        return stripe.create ? stripe.create(opts) : Response.json({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" });
      }
      if (u.pathname.startsWith("/v1/checkout/sessions/")) return Response.json(stripe.session || paidSession());
    }
    if (supplierHook) return supplierHook(url, opts);
    return new Response("not mocked", { status: 500 });
  };
  const env = { ...ENV_BASE, ORDERS: memoryKV() };
  return { handle: createHandler({ catalog, supplier, fetchImpl }), env, calls };
}

const req = (path, { method = "GET", body, headers = {} } = {}) =>
  new Request(`https://api.test${path}`, { method, headers, body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body) });

function paidSession(over = {}) {
  return {
    id: "cs_paid_1", created: 1764000000, payment_status: "paid", currency: "usd", amount_total: 6395,
    customer_details: { email: "a@b.co", phone: "+15555550100", name: "Ana B", address: { country: "US" } },
    collected_information: { shipping_details: { name: "Ana B", address: { line1: "1 Main St", line2: "", city: "Austin", state: "TX", postal_code: "78701", country: "US" } } },
    shipping_cost: { shipping_rate: { display_name: "Standard shipping" } },
    line_items: { data: [
      { description: "Heavyweight Tee (Black / M)", quantity: 2, amount_total: 5600, price: { product: { metadata: { product_id: "heavy-tee", color: "Black", size: "M" } } } },
      { description: "Crew Socks (3 pairs) (White / L/XL)", quantity: 1, amount_total: 1800, price: { product: { metadata: { product_id: "crew-socks", color: "White", size: "L/XL" } } } },
    ] },
    ...over,
  };
}

function signed(event, secret = "whsec_test", t = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(event);
  const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return { body, headers: { "stripe-signature": `t=${t},v1=${sig}` } };
}
const completed = (over = {}) => ({ type: "checkout.session.completed", data: { object: { id: "cs_paid_1", payment_status: "paid", ...over } } });

describe("catalog", () => {
  test("every product is complete and has a supplier entry with a healthy margin", () => {
    const ids = new Set();
    const cats = new Set(catalog.categories.map((c) => c.id));
    for (const p of catalog.products) {
      assert.ok(!ids.has(p.id), `duplicate id ${p.id}`); ids.add(p.id);
      assert.match(p.id, /^[\w-]+$/);
      assert.ok(cats.has(p.category), `${p.id} category`);
      assert.ok(Number.isInteger(p.price) && p.price > 0, `${p.id} price`);
      assert.ok(p.colors.length && p.colors.every((c) => /^#[0-9a-f]{6}$/i.test(c.hex)), `${p.id} colours`);
      assert.ok(p.sizes.length, `${p.id} sizes`);
      assert.ok(supplier.products[p.id], `${p.id} missing from supplier.json`);
    }
    for (const m of margins(catalog, supplier)) assert.ok(m.margin > 0.3, `${m.name} margin ${m.margin}`);
  });
  test("supplier costs are not in the public catalog", () => {
    const pub = JSON.stringify(catalog);
    assert.doesNotMatch(pub, /cost|sku|supplier/i);
  });
  test("SKU patterns produce clean codes", () => {
    assert.equal(skuFor("LL-HTEE-{color}-{size}", "Heather Grey", "2XL"), "LL-HTEE-HEATHERGREY-2XL");
    assert.equal(skuFor("LL-SOCK3-{color}-{size}", "White", "L/XL"), "LL-SOCK3-WHITE-LXL");
    assert.equal(skuFor("LL-CAP-{color}", "Black", "One Size"), "LL-CAP-BLACK");
  });
});

describe("pricing a cart", () => {
  test("uses catalog prices, ignores any price the browser sends, merges duplicates", () => {
    const { lines, subtotal } = priceCart(catalog, [
      { id: "heavy-tee", color: "Black", size: "M", qty: 1, price: 1 },
      { id: "heavy-tee", color: "Black", size: "M", qty: 2, unitAmount: 1 },
    ]);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].qty, 3);
    assert.equal(lines[0].unitAmount, 2800);
    assert.equal(subtotal, 8400);
  });
  for (const [why, items, msg] of [
    ["empty", [], /empty/],
    ["not an array", "x", /empty/],
    ["unknown product", [{ id: "nope", color: "Black", size: "M", qty: 1 }], /no longer available/],
    ["bad colour", [{ id: "heavy-tee", color: "Pink", size: "M", qty: 1 }], /colour/],
    ["bad size", [{ id: "heavy-tee", color: "Black", size: "5XL", qty: 1 }], /size/],
    ["zero qty", [{ id: "heavy-tee", color: "Black", size: "M", qty: 0 }], /whole numbers/],
    ["fractional qty", [{ id: "heavy-tee", color: "Black", size: "M", qty: 1.5 }], /whole numbers/],
    ["negative qty", [{ id: "heavy-tee", color: "Black", size: "M", qty: -3 }], /whole numbers/],
    ["over the cap", [{ id: "heavy-tee", color: "Black", size: "M", qty: 6 }, { id: "heavy-tee", color: "Black", size: "M", qty: 5 }], /up to 10/],
    ["null item", [null], /no longer available/],
  ]) test(`rejects ${why}`, () => assert.throws(() => priceCart(catalog, items), (e) => e.status === 400 && msg.test(e.message)));
  test("too many lines", () => {
    const items = Array.from({ length: 31 }, () => ({ id: "heavy-tee", color: "Black", size: "M", qty: 1 }));
    assert.throws(() => priceCart(catalog, items), /Too many/);
  });
});

describe("checkout session", () => {
  test("free standard shipping only at or over the threshold; express always offered", () => {
    const under = checkoutParams(catalog, priceCart(catalog, [{ id: "heavy-tee", color: "Black", size: "M", qty: 2 }]), ENV_BASE);
    assert.equal(under.shipping_options[0].shipping_rate_data.fixed_amount.amount, 595);
    assert.equal(under.shipping_options[1].shipping_rate_data.fixed_amount.amount, 1495);
    const at = checkoutParams(catalog, priceCart(catalog, [{ id: "heavy-tee", color: "Black", size: "M", qty: 2 }, { id: "crew-socks", color: "White", size: "S/M", qty: 1 }]), ENV_BASE);
    assert.equal(at.shipping_options[0].shipping_rate_data.fixed_amount.amount, 595);   // 5600 + 1800 = 7400, just under 7500
    const exact = checkoutParams(catalog, { lines: [], subtotal: 7500 }, ENV_BASE);
    assert.equal(exact.shipping_options[0].shipping_rate_data.fixed_amount.amount, 0);
    const over = checkoutParams(catalog, priceCart(catalog, [{ id: "heavy-tee", color: "Black", size: "M", qty: 3 }]), ENV_BASE);
    assert.equal(over.shipping_options[0].shipping_rate_data.fixed_amount.amount, 0);
    assert.match(over.shipping_options[0].shipping_rate_data.display_name, /^Free/);
  });
  test("return URLs, countries and per-item metadata", () => {
    const p = checkoutParams(catalog, priceCart(catalog, [{ id: "dad-cap", color: "Bone", size: "One Size", qty: 1 }]), ENV_BASE);
    assert.equal(p.success_url, "https://me.github.io/Test/shop/?checkout=success&session_id={CHECKOUT_SESSION_ID}");
    assert.equal(p.cancel_url, "https://me.github.io/Test/shop/?checkout=cancel");
    assert.deepEqual(p.shipping_address_collection.allowed_countries, ["US", "CA"]);
    assert.equal(p.line_items[0].price_data.product_data.name, "Washed Dad Cap (Bone)");
    assert.deepEqual(p.line_items[0].price_data.product_data.metadata, { product_id: "dad-cap", color: "Bone", size: "One Size" });
    assert.equal(p.automatic_tax, undefined);
    assert.deepEqual(checkoutParams(catalog, priceCart(catalog, [{ id: "dad-cap", color: "Bone", size: "One Size", qty: 1 }]), { ...ENV_BASE, AUTOMATIC_TAX: "true" }).automatic_tax, { enabled: true });
  });
  test("form encoding matches Stripe's nested format", () => {
    const s = formEncode({ a: 1, line_items: [{ price_data: { x: "y z" } }], allowed: ["US", "CA"], skip: undefined }).toString();
    assert.equal(decodeURIComponent(s), "a=1&line_items[0][price_data][x]=y+z&allowed[0]=US&allowed[1]=CA");
  });
  test("POST /checkout returns the Stripe URL and sends catalog prices", async () => {
    const { handle, env, calls } = setup();
    const r = await handle(req("/checkout", { method: "POST", body: { items: [{ id: "heavy-tee", color: "Sage", size: "L", qty: 1, price: 1 }] }, headers: { origin: "https://me.github.io" } }), env);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).url, "https://checkout.stripe.com/c/pay/cs_1");
    assert.equal(r.headers.get("access-control-allow-origin"), "https://me.github.io");
    const sent = new URLSearchParams(calls[0].opts.body);
    assert.equal(sent.get("line_items[0][price_data][unit_amount]"), "2800");
    assert.equal(calls[0].opts.headers.authorization, "Bearer sk_test_x");
  });
  test("other origins get no CORS header", async () => {
    const { handle, env } = setup();
    const r = await handle(req("/checkout", { method: "POST", body: { items: [{ id: "heavy-tee", color: "Sage", size: "L", qty: 1 }] }, headers: { origin: "https://evil.example" } }), env);
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  });
  test("bad cart, bad JSON, missing config and Stripe errors give clear messages", async () => {
    const { handle, env } = setup();
    let r = await handle(req("/checkout", { method: "POST", body: { items: [{ id: "x" }] } }), env);
    assert.equal(r.status, 400); assert.match((await r.json()).error, /no longer available/);
    r = await handle(req("/checkout", { method: "POST", body: "{not json" }), env);
    assert.equal(r.status, 400);
    r = await handle(req("/checkout", { method: "POST", body: { items: [] } }), { ...env, STRIPE_SECRET_KEY: "" });
    assert.equal(r.status, 503);
    const s2 = setup({ stripe: { create: () => Response.json({ error: { message: "Invalid API Key provided" } }, { status: 401 }) } });
    r = await s2.handle(req("/checkout", { method: "POST", body: { items: [{ id: "heavy-tee", color: "Sage", size: "L", qty: 1 }] } }), s2.env);
    assert.equal(r.status, 502); assert.match((await r.json()).error, /Invalid API Key/);
    const s3 = setup({ stripe: { create: () => { throw new TypeError("network down"); } } });
    r = await s3.handle(req("/checkout", { method: "POST", body: { items: [{ id: "heavy-tee", color: "Sage", size: "L", qty: 1 }] } }), s3.env);
    assert.equal(r.status, 500); assert.doesNotMatch((await r.json()).error, /network down/);   // no internals leaked
  });
  test("preflight and unknown routes", async () => {
    const { handle, env } = setup();
    const r = await handle(req("/checkout", { method: "OPTIONS", headers: { origin: "https://me.github.io" } }), env);
    assert.equal(r.status, 204); assert.match(r.headers.get("access-control-allow-methods"), /POST/);
    assert.equal((await handle(req("/nope"), env)).status, 404);
    assert.equal((await handle(req("/"), env)).status, 200);
  });
});

describe("webhook", () => {
  test("signature check: good, wrong secret, tampered body, stale, missing", async () => {
    const now = 1764000000;
    const body = '{"a":1}';
    const sig = (s, t = now, b = body) => `t=${t},v1=${createHmac("sha256", s).update(`${t}.${b}`).digest("hex")}`;
    assert.equal(await verifyStripeSignature(body, sig("whsec_test"), "whsec_test", 300, now), true);
    assert.equal(await verifyStripeSignature(body, `t=${now},v1=deadbeef,${sig("whsec_test").split(",")[1]}`, "whsec_test", 300, now), true);   // rolled secrets
    assert.equal(await verifyStripeSignature(body, sig("other"), "whsec_test", 300, now), false);
    assert.equal(await verifyStripeSignature('{"a":2}', sig("whsec_test"), "whsec_test", 300, now), false);
    assert.equal(await verifyStripeSignature(body, sig("whsec_test", now - 1000), "whsec_test", 300, now), false);
    assert.equal(await verifyStripeSignature(body, null, "whsec_test", 300, now), false);
    assert.equal(await verifyStripeSignature(body, sig("whsec_test"), "", 300, now), false);
    assert.equal(await verifyStripeSignature(body, "garbage", "whsec_test", 300, now), false);
  });
  test("paid session becomes a stored supplier order, once", async () => {
    const { handle, env, calls } = setup();
    const ev = signed(completed());
    let r = await handle(req("/webhook", { method: "POST", ...ev }), env);
    assert.equal(r.status, 200);
    const order = JSON.parse(env.ORDERS.m.get("order:cs_paid_1"));
    assert.equal(order.status, "new");
    assert.equal(order.name, "Ana B");
    assert.equal(order.address.postalCode, "78701");
    assert.equal(order.phone, "+15555550100");
    assert.deepEqual(order.items.map((i) => [i.sku, i.qty]), [["LL-HTEE-BLACK-M", 2], ["LL-SOCK3-WHITE-LXL", 1]]);
    assert.match(calls.find((c) => c.url.includes("/v1/checkout/sessions/")).url, /expand/);
    r = await handle(req("/webhook", { method: "POST", ...signed(completed()) }), env);
    assert.equal((await r.json()).duplicate, true);
    assert.equal(calls.filter((c) => c.url.includes("/v1/checkout/sessions/")).length, 1);
  });
  test("unpaid (delayed payment) sessions are ignored until async_payment_succeeded", async () => {
    const { handle, env } = setup();
    await handle(req("/webhook", { method: "POST", ...signed(completed({ payment_status: "unpaid" })) }), env);
    assert.equal(env.ORDERS.m.size, 0);
    await handle(req("/webhook", { method: "POST", ...signed({ type: "checkout.session.async_payment_succeeded", data: { object: { id: "cs_paid_1" } } }) }), env);
    assert.equal(env.ORDERS.m.size, 1);
  });
  test("forged webhook is rejected and stores nothing", async () => {
    const { handle, env } = setup();
    const r = await handle(req("/webhook", { method: "POST", ...signed(completed(), "whsec_wrong") }), env);
    assert.equal(r.status, 400); assert.equal(env.ORDERS.m.size, 0);
  });
  test("forwards to the supplier hook; a failed hand-off still keeps the order", async () => {
    let got = null;
    const ok = setup({ supplierHook: async (url, o) => { got = JSON.parse(o.body); return new Response("ok"); } });
    await ok.handle(req("/webhook", { method: "POST", ...signed(completed()) }), { ...ok.env, SUPPLIER_WEBHOOK_URL: "https://hooks.zapier.test/x" });
    assert.equal(got.items[0].sku, "LL-HTEE-BLACK-M");
    const bad = setup({ supplierHook: async () => new Response("down", { status: 503 }) });
    const r = await bad.handle(req("/webhook", { method: "POST", ...signed(completed()) }), { ...bad.env, SUPPLIER_WEBHOOK_URL: "https://hooks.zapier.test/x" });
    assert.equal(r.status, 200);
    const order = JSON.parse(bad.env.ORDERS.m.get("order:cs_paid_1"));
    assert.match(order.history[0].note, /hand-off failed: HTTP 503/);
  });
  test("Stripe outage while fetching the session returns an error so Stripe retries", async () => {
    const s = setup();
    const failing = createHandler({ catalog, supplier, fetchImpl: async () => Response.json({ error: { message: "down" } }, { status: 500 }) });
    const r = await failing(req("/webhook", { method: "POST", ...signed(completed()) }), s.env);
    assert.equal(r.status, 502);
    assert.equal(s.env.ORDERS.m.size, 0);
  });
  test("older API versions (shipping_details at top level) and unknown products", () => {
    const o = orderFromSession(paidSession({
      collected_information: undefined,
      shipping_details: { name: "Old Api", address: { line1: "2 Elm", city: "Reno", state: "NV", postal_code: "89501", country: "US" } },
      line_items: { data: [{ description: "Mystery", quantity: 1, amount_total: 100, price: { product: { metadata: {} } } }] },
    }), supplier);
    assert.equal(o.name, "Old Api"); assert.equal(o.address.city, "Reno");
    assert.equal(o.items[0].sku, "UNMAPPED");
  });
});

describe("admin orders", () => {
  async function withOrder() {
    const s = setup();
    await s.handle(req("/webhook", { method: "POST", ...signed(completed()) }), s.env);
    return s;
  }
  const auth = { authorization: "Bearer admintoken123" };
  test("needs the token", async () => {
    const { handle, env } = await withOrder();
    assert.equal((await handle(req("/orders"), env)).status, 401);
    assert.equal((await handle(req("/orders", { headers: { authorization: "Bearer wrong" } }), env)).status, 401);
    assert.equal((await handle(req("/orders", { headers: auth }), { ...env, ADMIN_TOKEN: "" })).status, 401);   // unset token never means open
    assert.equal((await handle(req("/orders/cs_paid_1/status", { method: "POST", body: { status: "placed" } }), env)).status, 401);
  });
  test("lists, exports CSV and updates status with tracking", async () => {
    const { handle, env } = await withOrder();
    const list = await (await handle(req("/orders", { headers: auth }), env)).json();
    assert.equal(list.orders.length, 1);
    const csv = await (await handle(req("/orders?format=csv", { headers: auth }), env)).text();
    const rows = csv.trim().split("\r\n");
    assert.equal(rows.length, 3);
    assert.match(rows[1], /LL-HTEE-BLACK-M/);
    let r = await handle(req("/orders/cs_paid_1/status", { method: "POST", headers: auth, body: { status: "shipped", carrier: "USPS", tracking: "9400" } }), env);
    assert.equal(r.status, 200);
    const o = await r.json();
    assert.equal(o.status, "shipped"); assert.deepEqual(o.tracking, { number: "9400", carrier: "USPS" });
    r = await handle(req("/orders/cs_paid_1/status", { method: "POST", headers: auth, body: { status: "lost" } }), env);
    assert.equal(r.status, 400);
    r = await handle(req("/orders/nope/status", { method: "POST", headers: auth, body: { status: "placed" } }), env);
    assert.equal(r.status, 404);
  });
  test("CSV quotes commas and neutralises spreadsheet formulas from customer input", () => {
    const o = orderFromSession(paidSession({ collected_information: { shipping_details: { name: '=HYPERLINK("x")', address: { line1: "1 Main St, Apt 2", city: "A", country: "US" } } } }), supplier);
    const csv = ordersToCsv([o]);
    assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
    assert.match(csv, /"1 Main St, Apt 2"/);
  });
});

describe("cart (browser logic)", () => {
  test("sanitize drops removed items and bad data, merges and caps", () => {
    const c = sanitizeCart([
      { id: "heavy-tee", color: "Black", size: "M", qty: 2 },
      { id: "heavy-tee", color: "Black", size: "M", qty: 9 },
      { id: "gone", color: "Black", size: "M", qty: 1 },
      { id: "heavy-tee", color: "Pink", size: "M", qty: 1 },
      { id: "heavy-tee", color: "Black", size: "M", qty: "abc" },
      { id: "heavy-tee", color: "Black", size: "L", qty: -1 },
      null, "x",
    ], catalog);
    assert.deepEqual(c, [{ id: "heavy-tee", color: "Black", size: "M", qty: 10 }]);
    assert.deepEqual(sanitizeCart({ not: "array" }, catalog), []);
  });
  test("add respects the cap and reports how many were added", () => {
    let { cart, added } = addToCart([], { id: "heavy-tee", color: "Black", size: "M", qty: 8 }, catalog);
    assert.equal(added, 8);
    ({ cart, added } = addToCart(cart, { id: "heavy-tee", color: "Black", size: "M", qty: 5 }, catalog));
    assert.equal(added, 2); assert.equal(cart[0].qty, 10);
    ({ cart, added } = addToCart(cart, { id: "heavy-tee", color: "Black", size: "M", qty: 1 }, catalog));
    assert.equal(added, 0);
    assert.equal(setQty(cart, "heavy-tee|Black|M", 0, catalog).length, 0);
  });
  test("totals and free-shipping progress", () => {
    const cart = [{ id: "heavy-tee", color: "Black", size: "M", qty: 2 }, { id: "crew-socks", color: "White", size: "S/M", qty: 1 }];
    assert.equal(subtotal(cart, catalog), 7400);
    assert.equal(count(cart), 3);
    assert.deepEqual(freeShipping(7400, catalog), { free: false, remaining: 100, pct: 99 });
    assert.equal(freeShipping(9000, catalog).free, true);
    assert.equal(money(7400), "$74.00");
  });
});
