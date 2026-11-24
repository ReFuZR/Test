// Cart logic with no DOM, so it can be unit-tested. Prices are shown from the catalog;
// the Worker re-prices everything at checkout, so nothing here is trusted for payment.

export const money = (cents, currency = "usd") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format((cents || 0) / 100);

export const lineKey = (l) => `${l.id}|${l.color}|${l.size}`;

/** Drops anything the catalog no longer sells (removed product, colour or size) and fixes bad quantities. */
export function sanitizeCart(raw, catalog) {
  if (!Array.isArray(raw)) return [];
  const max = catalog.maxQty || 10;
  const byId = new Map(catalog.products.map((p) => [p.id, p]));
  const out = new Map();
  for (const l of raw) {
    const p = byId.get(l?.id);
    if (!p || !p.colors.some((c) => c.name === l.color) || !p.sizes.includes(l.size)) continue;
    const q = Math.floor(Number(l.qty));
    if (!Number.isFinite(q) || q < 1) continue;
    const key = lineKey(l);
    const prev = out.get(key);
    out.set(key, { id: p.id, color: l.color, size: l.size, qty: Math.min(max, (prev?.qty || 0) + q) });
  }
  return [...out.values()];
}

/** Adds qty of a variant; returns { cart, added } where added may be less than asked when the per-item cap is hit. */
export function addToCart(cart, item, catalog) {
  const max = catalog.maxQty || 10;
  const next = cart.map((l) => ({ ...l }));
  const key = lineKey(item);
  let line = next.find((l) => lineKey(l) === key);
  if (!line) { line = { id: item.id, color: item.color, size: item.size, qty: 0 }; next.push(line); }
  const added = Math.max(0, Math.min(item.qty, max - line.qty));
  line.qty += added;
  return { cart: next.filter((l) => l.qty > 0), added };
}

export function setQty(cart, key, qty, catalog) {
  const max = catalog.maxQty || 10;
  return cart.map((l) => (lineKey(l) === key ? { ...l, qty: Math.max(0, Math.min(max, qty)) } : l)).filter((l) => l.qty > 0);
}

export function subtotal(cart, catalog) {
  const byId = new Map(catalog.products.map((p) => [p.id, p]));
  return cart.reduce((s, l) => s + (byId.get(l.id)?.price || 0) * l.qty, 0);
}

export const count = (cart) => cart.reduce((s, l) => s + l.qty, 0);

/** How far the cart is from free shipping: { free, remaining, pct } */
export function freeShipping(sub, catalog) {
  const goal = catalog.shipping?.freeOver;
  if (goal == null) return { free: false, remaining: null, pct: 0 };
  return { free: sub >= goal, remaining: Math.max(0, goal - sub), pct: Math.min(100, Math.round((sub / goal) * 100)) };
}
