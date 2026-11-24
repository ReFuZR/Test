// Order desk: see paid orders, download them as a supplier CSV, mark them placed/shipped with tracking.
import { money } from "./cart.js";

const KEY = "loomline-admin";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let auth = null;            // { api, token }
let orders = [];
let filter = "new";

function loadAuth() { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } }
function saveAuth(a) { try { a ? localStorage.setItem(KEY, JSON.stringify(a)) : localStorage.removeItem(KEY); } catch { /* session only */ } }

async function api(path, opts = {}) {
  const r = await fetch(`${auth.api.replace(/\/+$/, "")}${path}`, {
    ...opts, headers: { authorization: `Bearer ${auth.token}`, ...(opts.body ? { "content-type": "application/json" } : {}) },
  });
  if (r.status === 401) throw Object.assign(new Error("That admin token was rejected."), { auth: true });
  if (!r.ok) throw new Error(((await r.json().catch(() => null)) || {}).error || `Request failed (${r.status}).`);
  return r;
}

function render() {
  const list = orders.filter((o) => filter === "all" || o.status === filter);
  const todo = orders.filter((o) => o.status === "new").length;
  $("#summary").textContent = `${orders.length} order${orders.length === 1 ? "" : "s"} · ${todo} waiting to be ordered from the supplier`;
  document.querySelectorAll("#filters [data-f]").forEach((b) => b.setAttribute("aria-selected", b.dataset.f === filter));
  $("#orders").innerHTML = list.length ? list.map((o) => {
    const a = o.address;
    const unmapped = o.items.some((i) => i.sku === "UNMAPPED");
    const cost = o.items.reduce((s, i) => s + (i.unitCost || 0) * i.qty, 0);
    return `<article class="order" data-id="${esc(o.id)}">
      <header><h3>${esc(o.name || "No name")} · ${money(o.total, o.currency)}</h3><span class="badge ${esc(o.status)}">${esc(o.status)}</span></header>
      <p class="small">${new Date(o.created).toLocaleString()} · ${esc(o.email || "")} · ${esc(o.phone || "")} · ${esc(o.shippingMethod || "")}</p>
      <p class="addr">${esc([a.line1, a.line2, [a.city, a.state, a.postalCode].filter(Boolean).join(" "), a.country].filter(Boolean).join("\n"))}</p>
      <div class="tbl"><table><thead><tr><th>Item</th><th>SKU</th><th>Qty</th></tr></thead><tbody>
        ${o.items.map((i) => `<tr><td>${esc(i.name)}</td><td><code>${esc(i.sku)}</code><br><span class="small">${esc(i.supplier)}</span></td><td>${i.qty}</td></tr>`).join("")}
      </tbody></table></div>
      ${cost ? `<p class="small">Supplier cost ≈ ${money(cost, o.currency)} + shipping · gross before fees ≈ ${money(o.total - cost, o.currency)}</p>` : ""}
      ${unmapped ? `<p class="warn-line">An item has no supplier SKU. Add it to shop/worker/supplier.json and redeploy.</p>` : ""}
      ${o.history?.filter((h) => /fail/i.test(h.note)).map((h) => `<p class="warn-line">${esc(h.note)}</p>`).join("") || ""}
      ${o.tracking?.number ? `<p class="small">Tracking: ${esc(o.tracking.carrier)} ${esc(o.tracking.number)}</p>` : ""}
      <div class="actions">
        ${o.status === "new" ? `<button class="btn sm" data-status="placed">Mark ordered from supplier</button>` : ""}
        ${o.status !== "cancelled" && o.status !== "shipped" ? `<button class="btn sm ghost" data-status="cancelled">Cancel</button>` : ""}
      </div>
      ${o.status === "placed" ? `<form class="ship-form"><label>Carrier<input name="carrier" placeholder="USPS"></label><label>Tracking number<input name="tracking" required></label><button class="btn sm">Mark shipped</button></form>` : ""}
    </article>`;
  }).join("") : `<p class="empty">No orders here.</p>`;
}

async function load() {
  $("#summary").textContent = "Loading…";
  try {
    orders = ((await (await api("/orders")).json()) || {}).orders || [];
    $("#login").hidden = true; $("#board").hidden = false;
    render();
  } catch (e) {
    if (e.auth) { saveAuth(null); }
    $("#login").hidden = false; $("#board").hidden = true;
    $("#loginMsg").textContent = e instanceof TypeError ? "Couldn't reach the shop API. Check the address (and ALLOWED_ORIGIN in wrangler.toml)." : e.message;
  }
}

async function setStatus(id, body, btn) {
  btn.disabled = true;
  try {
    const updated = await (await api(`/orders/${encodeURIComponent(id)}/status`, { method: "POST", body: JSON.stringify(body) })).json();
    orders = orders.map((o) => (o.id === id ? updated : o));
    render();
  } catch (e) { alert(e.message); btn.disabled = false; }
}

async function downloadCsv() {
  try {
    const blob = await (await api("/orders?format=csv")).blob();
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `orders-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) { alert(e.message); }
}

$("#login").addEventListener("submit", (e) => {
  e.preventDefault();
  auth = { api: $("#api").value.trim(), token: $("#token").value };
  saveAuth(auth); $("#loginMsg").textContent = ""; load();
});
$("#filters").addEventListener("click", (e) => { const b = e.target.closest("[data-f]"); if (b) { filter = b.dataset.f; render(); } });
$("#refresh").addEventListener("click", load);
$("#csv").addEventListener("click", downloadCsv);
$("#logout").addEventListener("click", () => { saveAuth(null); auth = null; orders = []; $("#token").value = ""; $("#board").hidden = true; $("#login").hidden = false; });
$("#orders").addEventListener("click", (e) => {
  const b = e.target.closest("[data-status]"); if (!b) return;
  if (b.dataset.status === "cancelled" && !confirm("Cancel this order? Refund the customer in Stripe separately.")) return;
  setStatus(b.closest("[data-id]").dataset.id, { status: b.dataset.status }, b);
});
$("#orders").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target, id = f.closest("[data-id]").dataset.id;
  setStatus(id, { status: "shipped", carrier: f.carrier.value.trim(), tracking: f.tracking.value.trim() }, f.querySelector("button"));
});

$("#api").value = (window.SHOP_CONFIG || {}).apiBase || "";
auth = loadAuth();
if (auth) { $("#api").value = auth.api; load(); }
