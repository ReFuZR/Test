// Storefront: catalog grid, product sheet, cart drawer, Stripe checkout hand-off.
import { productVisual } from "./art.js";
import { money, lineKey, sanitizeCart, addToCart, setQty, subtotal, count, freeShipping } from "./cart.js";

const CFG = window.SHOP_CONFIG || {};
const CART_KEY = "loomline-cart";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let catalog = null;
let cart = [];
let view = { category: "all", sort: "featured" };
let sel = null;   // product sheet selection: { p, color, size, qty }

// ---------- storage (private mode or blocked storage must not break the shop) ----------
function loadCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY) || "[]"); } catch { return []; }
}
function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* cart just won't survive a reload */ }
}

const fmt = (c) => money(c, catalog?.currency);
const product = (id) => catalog.products.find((p) => p.id === id);

// ---------- grid ----------
function renderChips() {
  const cats = [{ id: "all", name: "All" }, ...catalog.categories.filter((c) => catalog.products.some((p) => p.category === c.id))];
  $("#chips").innerHTML = cats.map((c) => `<button role="tab" data-cat="${esc(c.id)}" aria-selected="${c.id === view.category}">${esc(c.name)}</button>`).join("");
}

function priceHtml(p) {
  return `${fmt(p.price)}${p.compareAt > p.price ? `<s>${fmt(p.compareAt)}</s>` : ""}`;
}

function renderGrid() {
  let list = catalog.products.filter((p) => view.category === "all" || p.category === view.category);
  if (view.sort === "low") list = [...list].sort((a, b) => a.price - b.price);
  if (view.sort === "high") list = [...list].sort((a, b) => b.price - a.price);
  $("#grid").innerHTML = list.length ? list.map((p) => `
    <button class="card" data-product="${esc(p.id)}" aria-label="${esc(p.name)}, ${esc(fmt(p.price))}">
      <div class="art">${productVisual(p, p.colors[0].name)}
        ${p.tags?.[0] ? `<span class="tag">${esc(p.tags[0])}</span>` : ""}
        ${p.compareAt > p.price ? `<span class="tag sale">Save ${Math.round((1 - p.price / p.compareAt) * 100)}%</span>` : ""}
      </div>
      <h3>${esc(p.name)}</h3>
      <p class="price">${priceHtml(p)}</p>
      <span class="swatches">${p.colors.map((c) => `<span class="dot" style="background:${esc(c.hex)}" title="${esc(c.name)}"></span>`).join("")}</span>
    </button>`).join("") : `<p class="empty">Nothing here yet.</p>`;
}

// ---------- product sheet ----------
function openProduct(id, { push = true } = {}) {
  const p = product(id);
  if (!p) return;
  sel = { p, color: p.colors[0].name, size: p.sizes.length === 1 ? p.sizes[0] : null, qty: 1 };
  $("#pCat").textContent = catalog.categories.find((c) => c.id === p.category)?.name || "";
  $("#pName").textContent = p.name;
  $("#pPrice").innerHTML = priceHtml(p);
  $("#pDesc").textContent = p.description;
  $("#pDetails").innerHTML = (p.details || []).map((d) => `<li>${esc(d)}</li>`).join("");
  $("#pSizeSet").hidden = p.sizes.length === 1;
  $("#pHint").textContent = ""; $("#pHint").className = "hint";
  renderSelection();
  if (push && location.hash !== `#p/${id}`) history.pushState(null, "", `#p/${id}`);
  if (!$("#product").open) $("#product").showModal();
}

function renderSelection() {
  const { p } = sel;
  $("#pArt").innerHTML = productVisual(p, sel.color);
  $("#pColorName").textContent = sel.color;
  $("#pColors").innerHTML = p.colors.map((c) => `<button data-color="${esc(c.name)}" aria-pressed="${c.name === sel.color}" aria-label="${esc(c.name)}" style="background:${esc(c.hex)}"></button>`).join("");
  $("#pSizes").innerHTML = p.sizes.map((s) => `<button data-size="${esc(s)}" aria-pressed="${s === sel.size}">${esc(s)}</button>`).join("");
  $("#qVal").textContent = sel.qty;
}

function addSelection() {
  if (!sel.size) { $("#pHint").className = "hint"; $("#pHint").textContent = "Choose a size first."; return; }
  const res = addToCart(cart, { id: sel.p.id, color: sel.color, size: sel.size, qty: sel.qty }, catalog);
  if (!res.added) {
    $("#pHint").className = "hint";
    $("#pHint").textContent = `You already have the most we can send of this (${catalog.maxQty || 10}).`;
    return;
  }
  cart = res.cart; saveCart(); renderCart();
  $("#pHint").className = "hint ok";
  $("#pHint").textContent = res.added < sel.qty ? `Added ${res.added}: that's the limit for this item.` : "Added to your cart.";
  $("#cartBtn").classList.remove("bump"); void $("#cartBtn").offsetWidth; $("#cartBtn").classList.add("bump");
}

// ---------- cart ----------
function renderCart() {
  $("#cartCount").textContent = count(cart);
  const sub = subtotal(cart, catalog);
  const fs = freeShipping(sub, catalog);
  $("#shipBar").innerHTML = fs.remaining == null || !cart.length ? "" :
    `${fs.free ? "You've got <b>free shipping</b>." : `You're <b>${fmt(fs.remaining)}</b> away from free shipping.`}<div class="track"><div class="fill" style="width:${fs.pct}%"></div></div>`;
  $("#lines").innerHTML = cart.length ? cart.map((l) => {
    const p = product(l.id);
    return `<li data-key="${esc(lineKey(l))}">
      <div class="thumb">${productVisual(p, l.color)}</div>
      <div><h4>${esc(p.name)}</h4><p class="meta">${esc(l.color)}${l.size === "One Size" ? "" : ` · ${esc(l.size)}`}</p>
        <div class="qty"><button data-dq="-1" aria-label="Less">−</button><span>${l.qty}</span><button data-dq="1" aria-label="More">+</button></div>
        <button class="rm" data-rm>Remove</button></div>
      <div class="amt">${fmt(p.price * l.qty)}</div></li>`;
  }).join("") : `<li class="empty-cart">Your cart is empty.</li>`;
  $("#subtotal").textContent = fmt(sub);
  $("#checkoutBtn").disabled = !cart.length;
}

async function checkout() {
  const msg = $("#checkoutMsg"), btn = $("#checkoutBtn");
  msg.textContent = "";
  if (!cart.length) return;
  if (!CFG.apiBase) {
    msg.textContent = "This is a demo store: checkout isn't connected yet.";
    return;
  }
  btn.disabled = true; btn.textContent = "Opening secure checkout…";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(`${CFG.apiBase.replace(/\/+$/, "")}/checkout`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: ctrl.signal,
      body: JSON.stringify({ items: cart }),
    });
    const data = (await r.json().catch(() => null)) || {};
    if (!r.ok || typeof data.url !== "string") throw new Error(data.error || "Checkout is unavailable right now. Please try again in a minute.");
    location.assign(data.url);
    return;
  } catch (e) {
    msg.textContent = e.name === "AbortError" || e instanceof TypeError
      ? "Couldn't reach checkout. Check your connection and try again."
      : e.message;
  } finally {
    clearTimeout(timer);
  }
  btn.disabled = !cart.length; btn.textContent = "Checkout";
}

// ---------- policies ----------
function policyHtml(kind) {
  const s = catalog.shipping, email = esc(CFG.contactEmail || "");
  const pages = {
    shipping: `<h2>Shipping</h2>
      <p>Orders are packed by our fulfilment partners and leave their warehouse within 1–3 business days. You'll get a tracking number by email when your order ships.</p>
      <ul><li>${esc(s.standard.label)}: ${fmt(s.standard.amount)}, ${s.standard.minDays}–${s.standard.maxDays} business days${s.freeOver != null ? `, free on orders over ${fmt(s.freeOver)}` : ""}.</li>
      ${s.express ? `<li>${esc(s.express.label)}: ${fmt(s.express.amount)}, ${s.express.minDays}–${s.express.maxDays} business days.</li>` : ""}</ul>
      <p>Items in one order can ship from different warehouses and arrive in separate packages. If your order hasn't arrived within 20 business days, email us and we'll resend it or refund you.</p>`,
    returns: `<h2>Returns</h2>
      <p>Changed your mind? Return unworn, unwashed items with their tags within 30 days of delivery for a full refund of the item price.</p>
      <p>Email ${email ? `<a href="mailto:${email}">${email}</a>` : "us"} with your order number and we'll send the return address. Wrong size, damaged or wrong item? We'll replace it at no cost: just send a photo.</p>`,
    privacy: `<h2>Privacy</h2>
      <p>We collect only what's needed to deliver your order: your name, email, phone and shipping address. Payments are handled by Stripe; we never see or store your card number.</p>
      <p>Your shipping details are shared with our fulfilment partner and the carrier so your order can be delivered, and with nobody else. Your cart is stored only in your browser.</p>`,
    contact: `<h2>Contact</h2><p>Questions about an order, sizing or anything else: ${email ? `<a href="mailto:${email}">${email}</a>` : "use the email on your receipt"}. We answer within one business day.</p>`,
  };
  return pages[kind] || pages.contact;
}

// ---------- routing & events ----------
function route() {
  const m = location.hash.match(/^#p\/([\w-]+)$/);
  if (m && product(m[1])) openProduct(m[1], { push: false });
  else if ($("#product").open) $("#product").close();
}

function showNotice(text, warn = false) {
  const n = $("#notice");
  n.textContent = text; n.className = `notice${warn ? " warn" : ""}`; n.hidden = false;
}

function handleReturnFromCheckout() {
  const q = new URLSearchParams(location.search);
  const state = q.get("checkout");
  if (!state) return;
  if (state === "success") {
    cart = []; saveCart();
    showNotice("Thank you! Your order is confirmed and a receipt is on its way to your inbox. We'll email tracking as soon as it ships.");
  } else if (state === "cancel") {
    showNotice("Checkout was cancelled. Your cart is still here whenever you're ready.", true);
  }
  q.delete("checkout"); q.delete("session_id");
  history.replaceState(null, "", `${location.pathname}${q.size ? `?${q}` : ""}${location.hash}`);
}

function bind() {
  $("#chips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cat]"); if (!b) return;
    view.category = b.dataset.cat; renderChips(); renderGrid();
  });
  $("#sort").addEventListener("change", (e) => { view.sort = e.target.value; renderGrid(); });
  $("#grid").addEventListener("click", (e) => { const c = e.target.closest("[data-product]"); if (c) openProduct(c.dataset.product); });

  $("#pColors").addEventListener("click", (e) => { const b = e.target.closest("[data-color]"); if (b) { sel.color = b.dataset.color; renderSelection(); } });
  $("#pSizes").addEventListener("click", (e) => { const b = e.target.closest("[data-size]"); if (b) { sel.size = b.dataset.size; $("#pHint").textContent = ""; renderSelection(); } });
  $("#qMinus").addEventListener("click", () => { sel.qty = Math.max(1, sel.qty - 1); $("#qVal").textContent = sel.qty; });
  $("#qPlus").addEventListener("click", () => { sel.qty = Math.min(catalog.maxQty || 10, sel.qty + 1); $("#qVal").textContent = sel.qty; });
  $("#addBtn").addEventListener("click", addSelection);
  $("#product").addEventListener("close", () => { if (location.hash.startsWith("#p/")) history.replaceState(null, "", location.pathname + location.search); });

  $("#cartBtn").addEventListener("click", () => { renderCart(); $("#checkoutMsg").textContent = ""; $("#cart").showModal(); });
  $("#lines").addEventListener("click", (e) => {
    const li = e.target.closest("[data-key]"); if (!li) return;
    const line = cart.find((l) => lineKey(l) === li.dataset.key); if (!line) return;
    if (e.target.closest("[data-rm]")) cart = setQty(cart, li.dataset.key, 0, catalog);
    const dq = e.target.closest("[data-dq]");
    if (dq) cart = setQty(cart, li.dataset.key, line.qty + Number(dq.dataset.dq), catalog);
    saveCart(); renderCart();
  });
  $("#checkoutBtn").addEventListener("click", checkout);

  document.querySelectorAll("[data-policy]").forEach((b) => b.addEventListener("click", () => {
    $("#policyBody").innerHTML = policyHtml(b.dataset.policy); $("#policy").showModal();
  }));
  document.querySelectorAll("dialog").forEach((d) => {
    d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.close(); });   // backdrop or ×
  });
  window.addEventListener("popstate", route);
  window.addEventListener("storage", (e) => { if (e.key === CART_KEY) { cart = sanitizeCart(loadCart(), catalog); renderCart(); } });   // other tabs
}

async function init() {
  try {
    const r = await fetch("catalog.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status);
    catalog = await r.json();
  } catch {
    $("#grid").innerHTML = `<p class="empty">We couldn't load the shop. <button class="btn" onclick="location.reload()">Try again</button></p>`;
    return;
  }
  document.title = `${catalog.store} — Everyday Basics`;
  if (catalog.shipping?.freeOver != null) $("#announce").textContent = `Free shipping on orders over ${fmt(catalog.shipping.freeOver).replace(/\.00$/, "")}`;
  $("#copyright").textContent = `© ${new Date().getFullYear()} ${catalog.store}`;
  cart = sanitizeCart(loadCart(), catalog); saveCart();
  handleReturnFromCheckout();
  renderChips(); renderGrid(); renderCart(); bind(); route();
}

init();
