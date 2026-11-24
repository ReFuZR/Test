// Loomline shop backend, written for Cloudflare Workers (plain fetch + Web Crypto, no SDKs).
//
//   POST /checkout              cart -> Stripe Checkout Session, returns { url }
//   POST /webhook               Stripe webhook: paid session -> supplier order (stored, optionally forwarded)
//   GET  /orders[?format=csv]   admin: list orders (Bearer ADMIN_TOKEN)
//   POST /orders/:id/status     admin: mark an order placed / shipped / cancelled, with tracking
//
// Prices always come from the catalog bundled here; whatever the browser sends is only ids and quantities.

const STRIPE = "https://api.stripe.com/v1";
const STATUSES = ["new", "placed", "shipped", "cancelled"];

// ---------- small helpers ----------

/** Flattens nested objects/arrays into Stripe's form encoding: a[b][0][c]=d */
export function formEncode(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export const skuFor = (pattern, color, size) =>
  pattern.replace("{color}", slug(color)).replace("{size}", slug(size));
const slug = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, "");

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Checks a Stripe-Signature header ("t=...,v1=...,v1=...") against the raw body. */
export async function verifyStripeSignature(body, header, secret, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isFinite(t) || !sigs.length || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = await hmacHex(secret, `${t}.${body}`);
  return sigs.some((s) => timingSafeEqual(s, expected));
}

// ---------- cart ----------

/**
 * Turns what the browser sent into priced lines from the catalog.
 * Throws { status: 400, message } on anything that doesn't match the catalog.
 */
export function priceCart(catalog, items) {
  const bad = (message) => Object.assign(new Error(message), { status: 400 });
  if (!Array.isArray(items) || !items.length) throw bad("Your cart is empty.");
  if (items.length > 30) throw bad("Too many different items in one order.");
  const byId = new Map(catalog.products.map((p) => [p.id, p]));
  const merged = new Map();
  for (const it of items) {
    const p = byId.get(it?.id);
    if (!p) throw bad("An item in your cart is no longer available.");
    const color = p.colors.find((c) => c.name === it.color);
    if (!color) throw bad(`${p.name} isn't available in that colour any more.`);
    if (!p.sizes.includes(it.size)) throw bad(`${p.name} isn't available in that size.`);
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1) throw bad("Quantities must be whole numbers of at least 1.");
    const key = `${p.id}|${color.name}|${it.size}`;
    const line = merged.get(key) || { id: p.id, name: p.name, color: color.name, size: it.size, unitAmount: p.price, qty: 0 };
    line.qty += qty;
    if (line.qty > (catalog.maxQty || 10)) throw bad(`You can order up to ${catalog.maxQty || 10} of each item.`);
    merged.set(key, line);
  }
  const lines = [...merged.values()];
  const subtotal = lines.reduce((s, l) => s + l.unitAmount * l.qty, 0);
  return { lines, subtotal };
}

export function shippingOptions(catalog, subtotal) {
  const s = catalog.shipping;
  const rate = (label, amount, min, max) => ({
    shipping_rate_data: {
      type: "fixed_amount", display_name: label,
      fixed_amount: { amount, currency: catalog.currency },
      delivery_estimate: { minimum: { unit: "business_day", value: min }, maximum: { unit: "business_day", value: max } },
    },
  });
  const free = s.freeOver != null && subtotal >= s.freeOver;
  return [
    rate(free ? `Free ${s.standard.label.toLowerCase()}` : s.standard.label, free ? 0 : s.standard.amount, s.standard.minDays, s.standard.maxDays),
    ...(s.express ? [rate(s.express.label, s.express.amount, s.express.minDays, s.express.maxDays)] : []),
  ];
}

export function checkoutParams(catalog, priced, env) {
  const shop = String(env.SHOP_URL || "").replace(/\/+$/, "");
  const countries = String(env.ALLOWED_COUNTRIES || "US").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
  return {
    mode: "payment",
    line_items: priced.lines.map((l) => ({
      quantity: l.qty,
      price_data: {
        currency: catalog.currency,
        unit_amount: l.unitAmount,
        product_data: {
          name: `${l.name} (${l.color}${l.size === "One Size" ? "" : ` / ${l.size}`})`,
          metadata: { product_id: l.id, color: l.color, size: l.size },
        },
      },
    })),
    shipping_address_collection: { allowed_countries: countries },
    shipping_options: shippingOptions(catalog, priced.subtotal),
    phone_number_collection: { enabled: true },   // most suppliers and carriers ask for a phone number
    allow_promotion_codes: true,
    ...(env.AUTOMATIC_TAX === "true" ? { automatic_tax: { enabled: true } } : {}),
    success_url: `${shop}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${shop}/?checkout=cancel`,
  };
}

// ---------- orders ----------

/** Builds the order record the supplier needs from a completed Checkout Session (with expanded line items). */
export function orderFromSession(session, supplier) {
  const ship = session.collected_information?.shipping_details || session.shipping_details || {};
  const cust = session.customer_details || {};
  const addr = ship.address || cust.address || {};
  const items = (session.line_items?.data || []).map((li) => {
    const meta = li.price?.product?.metadata || {};
    const sup = supplier.products[meta.product_id] || {};
    return {
      productId: meta.product_id || null,
      name: li.description,
      color: meta.color || "", size: meta.size || "",
      qty: li.quantity,
      sku: sup.sku ? skuFor(sup.sku, meta.color || "", meta.size || "") : "UNMAPPED",
      supplier: sup.supplier || "UNMAPPED",
      unitCost: sup.cost ?? null,
      amount: li.amount_total,
    };
  });
  return {
    id: session.id,
    created: new Date((session.created || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    status: "new",
    email: cust.email || null,
    phone: cust.phone || null,
    name: ship.name || cust.name || null,
    address: { line1: addr.line1 || "", line2: addr.line2 || "", city: addr.city || "", state: addr.state || "", postalCode: addr.postal_code || "", country: addr.country || "" },
    shippingMethod: session.shipping_cost?.shipping_rate?.display_name || null,
    currency: session.currency,
    total: session.amount_total,
    items,
    tracking: null,
    history: [],
  };
}

const CSV_COLS = ["order_id", "created", "status", "name", "email", "phone", "address1", "address2", "city", "state", "zip", "country", "shipping", "supplier", "sku", "product", "color", "size", "qty"];
const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;   // stop spreadsheet formula injection from customer-typed fields
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** One row per item, the layout most supplier "bulk order" CSV importers expect. */
export function ordersToCsv(orders) {
  const rows = [CSV_COLS.join(",")];
  for (const o of orders) for (const it of o.items) {
    rows.push([o.id, o.created, o.status, o.name, o.email, o.phone, o.address.line1, o.address.line2, o.address.city, o.address.state,
      o.address.postalCode, o.address.country, o.shippingMethod, it.supplier, it.sku, it.name, it.color, it.size, it.qty].map(csvCell).join(","));
  }
  return rows.join("\r\n") + "\r\n";
}

// ---------- the handler ----------

export function createHandler({ catalog, supplier, fetchImpl = (...a) => fetch(...a) }) {
  async function stripe(env, path, { method = "GET", body } = {}) {
    const r = await fetchImpl(`${STRIPE}${path}`, {
      method,
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: body ? formEncode(body).toString() : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data?.error?.message || `Stripe error ${r.status}`), { status: 502 });
    return data;
  }

  function cors(env, req) {
    const allowed = String(env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
    const origin = req.headers.get("origin");
    if (!origin || !allowed.includes(origin)) return {};
    return { "access-control-allow-origin": origin, "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,authorization", vary: "origin" };
  }

  const isAdmin = (env, req) => !!env.ADMIN_TOKEN && timingSafeEqual(req.headers.get("authorization") || "", `Bearer ${env.ADMIN_TOKEN}`);

  async function handleCheckout(req, env, h) {
    if (!env.STRIPE_SECRET_KEY || !env.SHOP_URL) return json({ error: "Checkout isn't set up yet." }, 503, h);
    let body;
    try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400, h); }
    const priced = priceCart(catalog, body?.items);
    const session = await stripe(env, "/checkout/sessions", { method: "POST", body: checkoutParams(catalog, priced, env) });
    return json({ url: session.url }, 200, h);
  }

  async function handleWebhook(req, env) {
    const raw = await req.text();
    if (!(await verifyStripeSignature(raw, req.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET))) return json({ error: "Bad signature" }, 400);
    const event = JSON.parse(raw);
    const paid = (event.type === "checkout.session.completed" && event.data.object.payment_status === "paid") || event.type === "checkout.session.async_payment_succeeded";
    if (!paid) return json({ received: true, ignored: event.type });
    const id = event.data.object.id;
    const existing = await env.ORDERS.get(`order:${id}`);
    if (existing) return json({ received: true, duplicate: true });   // Stripe retries; never create an order twice
    const session = await stripe(env, `/checkout/sessions/${encodeURIComponent(id)}?expand[]=line_items.data.price.product`);
    const order = orderFromSession(session, supplier);
    await env.ORDERS.put(`order:${id}`, JSON.stringify(order));
    if (env.SUPPLIER_WEBHOOK_URL) {
      // Hand-off to Zapier / Make / your supplier's API. A failure here must not lose the order: it's already stored.
      try {
        const r = await fetchImpl(env.SUPPLIER_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(order) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } catch (e) {
        order.history.push({ at: new Date().toISOString(), note: `Supplier hand-off failed: ${e.message}` });
        await env.ORDERS.put(`order:${id}`, JSON.stringify(order));
      }
    }
    return json({ received: true, order: id });
  }

  async function listOrders(env) {
    const orders = [];
    let cursor;
    do {
      const page = await env.ORDERS.list({ prefix: "order:", cursor });
      for (const k of page.keys) { const v = await env.ORDERS.get(k.name); if (v) orders.push(JSON.parse(v)); }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return orders.sort((a, b) => b.created.localeCompare(a.created));
  }

  async function updateStatus(req, env, id, h) {
    const raw = await env.ORDERS.get(`order:${id}`);
    if (!raw) return json({ error: "No such order." }, 404, h);
    let body;
    try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400, h); }
    if (!STATUSES.includes(body?.status)) return json({ error: `Status must be one of ${STATUSES.join(", ")}.` }, 400, h);
    const order = JSON.parse(raw);
    order.status = body.status;
    if (body.tracking || body.carrier) order.tracking = { number: String(body.tracking || "").slice(0, 100), carrier: String(body.carrier || "").slice(0, 60) };
    if (body.note) order.history.push({ at: new Date().toISOString(), note: String(body.note).slice(0, 500) });
    order.history.push({ at: new Date().toISOString(), note: `Status: ${body.status}` });
    await env.ORDERS.put(`order:${id}`, JSON.stringify(order));
    return json(order, 200, h);
  }

  return async function handle(req, env) {
    const url = new URL(req.url);
    const h = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    try {
      if (req.method === "POST" && url.pathname === "/checkout") return await handleCheckout(req, env, h);
      if (req.method === "POST" && url.pathname === "/webhook") return await handleWebhook(req, env);
      if (url.pathname === "/orders" || url.pathname.startsWith("/orders/")) {
        if (!isAdmin(env, req)) return json({ error: "Unauthorized" }, 401, h);
        if (req.method === "GET" && url.pathname === "/orders") {
          const orders = await listOrders(env);
          if (url.searchParams.get("format") === "csv") {
            return new Response(ordersToCsv(orders), { headers: { ...h, "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="orders.csv"' } });
          }
          return json({ orders }, 200, h);
        }
        const m = url.pathname.match(/^\/orders\/([^/]+)\/status$/);
        if (req.method === "POST" && m) return await updateStatus(req, env, decodeURIComponent(m[1]), h);
      }
      if (req.method === "GET" && url.pathname === "/") return json({ ok: true, store: catalog.store }, 200, h);
      return json({ error: "Not found" }, 404, h);
    } catch (e) {
      return json({ error: e.status ? e.message : "Something went wrong. Please try again." }, e.status || 500, h);
    }
  };
}
