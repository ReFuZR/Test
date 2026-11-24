// The shop in a phone-sized browser: browsing, product sheet, cart, checkout hand-off and every failure path.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let playwright = null;
try { playwright = require("playwright"); } catch { /* skipped */ }
const opts = { skip: !playwright && "Playwright not installed", timeout: 60_000 };

const SHOP = join(dirname(fileURLToPath(import.meta.url)), "..", "shop");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
const ORIGIN = "https://shop.test";
const API = "https://api.test";

async function startShop({ api = null, apiBase = API, storage = {}, viewport = { width: 390, height: 844 }, path = "/shop/", catalog } = {}) {
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  const apiCalls = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === ORIGIN && url.pathname.startsWith("/shop/")) {
      const rel = url.pathname.slice("/shop/".length) || "index.html";
      if (rel === "config.js") return route.fulfill({ contentType: "text/javascript", body: `window.SHOP_CONFIG = ${JSON.stringify({ apiBase, contactEmail: "help@shop.test" })};` });
      if (rel === "catalog.json" && catalog) return catalog === "fail" ? route.fulfill({ status: 500, body: "" }) : route.fulfill({ contentType: "application/json", body: JSON.stringify(catalog) });
      const file = join(SHOP, rel);
      if (!file.startsWith(SHOP) || rel.startsWith("worker") || !existsSync(file)) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ contentType: TYPES[extname(file)] || "text/plain", body: readFileSync(file) });
    }
    if (url.origin === API) {
      apiCalls.push({ path: url.pathname, body: route.request().postData() });
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": ORIGIN, "access-control-allow-headers": "content-type,authorization", "access-control-allow-methods": "GET,POST" } });
      const res = api ? await api(url, route.request()) : { status: 404, json: { error: "Not found" } };
      if (res === "abort") return route.abort("failed");
      return route.fulfill({ status: res.status || 200, contentType: "application/json", headers: { "access-control-allow-origin": ORIGIN }, body: JSON.stringify(res.json) });
    }
    if (url.host === "checkout.stripe.com") return route.fulfill({ contentType: "text/html", body: "<h1>Stripe Checkout</h1>" });
    return route.fulfill({ status: 204, body: "" });   // fonts etc.
  });
  if (Object.keys(storage).length) {
    await context.addInitScript((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
  }
  await page.goto(ORIGIN + path);
  return { page, errors, apiCalls, close: () => browser.close() };
}

async function withShop(cfg, fn) {
  const s = await startShop(cfg);
  try { await fn(s); assert.deepEqual(s.errors, [], `page errors: ${s.errors.join(" | ")}`); }
  finally { await s.close(); }
}
const ready = (page) => page.waitForSelector(".card[data-product]");
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const cartJson = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("loomline-cart") || "[]"));

async function addTee(page, { size = "M", qty = 1 } = {}) {
  await page.click('[data-product="heavy-tee"]');
  await page.click(`#pSizes [data-size="${size}"]`);
  for (let i = 1; i < qty; i++) await page.click("#qPlus");
  await page.click("#addBtn");
}

describe("browsing", opts, () => {
  test("grid renders every product with prices; filters and sort work; no sideways scroll at 320px", () => withShop({ viewport: { width: 320, height: 700 } }, async ({ page }) => {
    await ready(page);
    assert.equal((await page.$$(".card")).length, 12);
    assert.match(await page.textContent("#announce"), /\$75/);
    await page.click('[data-cat="accessories"]');
    assert.equal((await page.$$(".card")).length, 4);
    await page.click('[data-cat="all"]');
    await page.selectOption("#sort", "low");
    const first = await page.getAttribute(".card", "data-product");
    assert.equal(first, "crew-socks");
    assert.ok(await noSideScroll(page));
    // each illustration keeps its own colour (inline SVG <style> blocks would leak across the page)
    const fills = await page.$$eval(".card .art svg", (els) => els.map((e) => getComputedStyle(e.querySelector("path")).fill));
    assert.ok(new Set(fills).size >= 4, `fills: ${fills}`);
    await page.click('[data-product="oversized-hoodie"]');
    assert.ok(await noSideScroll(page));
  }));

  test("product sheet: colour changes art, size required, deep link and back button", () => withShop({}, async ({ page }) => {
    await ready(page);
    await page.click('[data-product="heavy-tee"]');
    assert.equal(new URL(page.url()).hash, "#p/heavy-tee");
    await page.click('#pColors [data-color="Sage"]');
    assert.equal(await page.textContent("#pColorName"), "Sage");
    assert.match(await page.getAttribute("#pArt svg", "aria-label"), /Sage/);
    await page.click("#addBtn");
    assert.match(await page.textContent("#pHint"), /Choose a size/);
    assert.equal(await page.textContent("#cartCount"), "0");
    await page.goBack();
    await page.waitForFunction(() => !document.querySelector("#product").open);
    await page.goto(`${ORIGIN}/shop/#p/dad-cap`);
    await page.waitForFunction(() => document.querySelector("#product").open);
    assert.equal(await page.textContent("#pName"), "Washed Dad Cap");
    assert.equal(await page.isHidden("#pSizeSet"), true);   // one size: no picker, adds straight away
    await page.click("#addBtn");
    assert.equal(await page.textContent("#cartCount"), "1");
  }));

  test("unknown deep link and failed catalog are handled", async () => {
    if (!playwright) return;
    await withShop({ path: "/shop/#p/not-a-thing" }, async ({ page }) => {
      await ready(page);
      assert.equal(await page.evaluate(() => document.querySelector("#product").open), false);
    });
    await withShop({ catalog: "fail" }, async ({ page }) => {
      await page.waitForSelector("text=couldn't load the shop");
    });
  });

  test("policies open with the real shipping numbers", () => withShop({}, async ({ page }) => {
    await ready(page);
    await page.click('[data-policy="shipping"]');
    const t = await page.textContent("#policyBody");
    assert.match(t, /\$5\.95/); assert.match(t, /6–12 business days/); assert.match(t, /separate packages/);
    await page.click("#policy [data-close]");
    await page.click('[data-policy="contact"]');
    assert.match(await page.textContent("#policyBody"), /help@shop\.test/);
  }));
});

describe("cart", opts, () => {
  test("add, change quantity, free-shipping bar, remove, survives reload", () => withShop({}, async ({ page }) => {
    await ready(page);
    await addTee(page, { qty: 2 });
    assert.equal(await page.textContent("#cartCount"), "2");
    await page.keyboard.press("Escape");
    await page.click("#cartBtn");
    assert.equal(await page.textContent("#subtotal"), "$56.00");
    assert.match(await page.textContent("#shipBar"), /\$19\.00 away/);
    await page.click('#lines [data-dq="1"]');
    assert.equal(await page.textContent("#subtotal"), "$84.00");
    assert.match(await page.textContent("#shipBar"), /free shipping/);
    await page.reload(); await ready(page);
    assert.equal(await page.textContent("#cartCount"), "3");
    await page.click("#cartBtn");
    await page.click("#lines [data-rm]");
    assert.match(await page.textContent("#lines"), /empty/);
    assert.equal(await page.isDisabled("#checkoutBtn"), true);
  }));

  test("quantity cap per item", () => withShop({}, async ({ page }) => {
    await ready(page);
    await addTee(page, { qty: 12 });        // the + button stops at 10
    assert.equal(await page.textContent("#cartCount"), "10");
    await page.click("#addBtn");
    assert.match(await page.textContent("#pHint"), /most we can send/);
    assert.equal(await page.textContent("#cartCount"), "10");
  }));

  test("stale or tampered saved carts are cleaned up", () => withShop({ storage: { "loomline-cart": JSON.stringify([
    { id: "heavy-tee", color: "Black", size: "M", qty: 99 }, { id: "discontinued", color: "Black", size: "M", qty: 1 }, { id: "heavy-tee", color: "Neon", size: "M", qty: 1 },
  ]) } }, async ({ page }) => {
    await ready(page);
    assert.equal(await page.textContent("#cartCount"), "10");
    assert.deepEqual(await cartJson(page), [{ id: "heavy-tee", color: "Black", size: "M", qty: 10 }]);
  }));

  test("corrupt storage doesn't break the shop", () => withShop({ storage: { "loomline-cart": "{nope" } }, async ({ page }) => {
    await ready(page);
    assert.equal(await page.textContent("#cartCount"), "0");
  }));
});

describe("checkout", opts, () => {
  test("sends only ids/variants/qty and redirects to Stripe", () => withShop({ api: () => ({ json: { url: "https://checkout.stripe.com/c/pay/cs_1" } }) }, async ({ page, apiCalls }) => {
    await ready(page);
    await addTee(page);
    await page.keyboard.press("Escape");
    await page.click("#cartBtn");
    await Promise.all([page.waitForURL("https://checkout.stripe.com/**"), page.click("#checkoutBtn")]);
    const call = apiCalls.find((c) => c.path === "/checkout" && c.body);
    assert.deepEqual(JSON.parse(call.body), { items: [{ id: "heavy-tee", color: "Black", size: "M", qty: 1 }] });
  }));

  test("server error message is shown and the button comes back", () => withShop({ api: () => ({ status: 400, json: { error: "Heavyweight Tee isn't available in that size." } }) }, async ({ page }) => {
    await ready(page); await addTee(page); await page.keyboard.press("Escape");
    await page.click("#cartBtn"); await page.click("#checkoutBtn");
    await page.waitForSelector("#checkoutMsg:has-text('available in that size')");
    assert.equal(await page.isDisabled("#checkoutBtn"), false);
    assert.equal(await page.textContent("#checkoutBtn"), "Checkout");
  }));

  test("network failure and a non-JSON response", async () => {
    if (!playwright) return;
    await withShop({ api: () => "abort" }, async ({ page }) => {
      await ready(page); await addTee(page); await page.keyboard.press("Escape");
      await page.click("#cartBtn"); await page.click("#checkoutBtn");
      await page.waitForSelector("#checkoutMsg:has-text(\"Couldn't reach checkout\")");
    });
    await withShop({ api: () => ({ status: 502, json: null }) }, async ({ page }) => {
      await ready(page); await addTee(page); await page.keyboard.press("Escape");
      await page.click("#cartBtn"); await page.click("#checkoutBtn");
      await page.waitForSelector("#checkoutMsg:has-text('unavailable right now')");
    });
  });

  test("demo mode (no API configured) says so instead of failing", () => withShop({ apiBase: "" }, async ({ page, apiCalls }) => {
    await ready(page); await addTee(page); await page.keyboard.press("Escape");
    await page.click("#cartBtn"); await page.click("#checkoutBtn");
    assert.match(await page.textContent("#checkoutMsg"), /demo store/);
    assert.equal(apiCalls.length, 0);
  }));

  test("returning from Stripe: success clears the cart, cancel keeps it; query is cleaned", async () => {
    if (!playwright) return;
    const storage = { "loomline-cart": JSON.stringify([{ id: "heavy-tee", color: "Black", size: "M", qty: 1 }]) };
    await withShop({ storage, path: "/shop/?checkout=cancel" }, async ({ page }) => {
      await ready(page);
      assert.match(await page.textContent("#notice"), /cancelled/);
      assert.equal(await page.textContent("#cartCount"), "1");
      assert.equal(new URL(page.url()).search, "");
    });
    const s = await startShop({ path: "/shop/?checkout=success&session_id=cs_1" });
    try {
      await ready(s.page);
      // seed after load to prove success wipes what was there at return time
      await s.page.evaluate((c) => localStorage.setItem("loomline-cart", c), storage["loomline-cart"]);
      await s.page.goto(`${ORIGIN}/shop/?checkout=success&session_id=cs_1`); await ready(s.page);
      assert.match(await s.page.textContent("#notice"), /order is confirmed/);
      assert.equal(await s.page.textContent("#cartCount"), "0");
      assert.deepEqual(await cartJson(s.page), []);
      assert.equal(new URL(s.page.url()).search, "");
      assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
  });
});

describe("admin", opts, () => {
  const order = {
    id: "cs_paid_1", created: "2026-11-20T10:00:00.000Z", status: "new", email: "a@b.co", phone: "+1555", name: "Ana B",
    address: { line1: "1 Main St", line2: "", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    shippingMethod: "Standard shipping", currency: "usd", total: 6395, tracking: null, history: [],
    items: [{ name: "Heavyweight Tee (Black / M)", sku: "LL-HTEE-BLACK-M", supplier: "CJ Dropshipping", qty: 2, unitCost: 950 }],
  };
  test("wrong token, then login, mark placed, then shipped with tracking", async () => {
    if (!playwright) return;
    let state = { ...order };
    const api = (url, r) => {
      if (r.headers().authorization !== "Bearer good") return { status: 401, json: { error: "Unauthorized" } };
      if (url.pathname === "/orders") return { json: { orders: [state] } };
      const body = JSON.parse(r.postData());
      state = { ...state, status: body.status, tracking: body.tracking ? { number: body.tracking, carrier: body.carrier } : state.tracking };
      return { json: state };
    };
    await withShop({ api, path: "/shop/admin.html" }, async ({ page }) => {
      await page.fill("#token", "bad"); await page.click("#login button");
      await page.waitForSelector("#loginMsg:has-text('rejected')");
      await page.fill("#token", "good"); await page.click("#login button");
      await page.waitForSelector(".order");
      assert.match(await page.textContent(".order"), /LL-HTEE-BLACK-M/);
      assert.match(await page.textContent("#summary"), /1 waiting/);
      await page.click('[data-status="placed"]');
      await page.click('[data-f="placed"]');
      await page.fill(".ship-form [name=carrier]", "USPS");
      await page.fill(".ship-form [name=tracking]", "9400111");
      await page.click(".ship-form button");
      await page.click('[data-f="shipped"]');
      await page.waitForSelector(".order:has-text('USPS 9400111')");
      assert.ok(await noSideScroll(page));
    });
  });
});
