// Prints profit per product after supplier cost, supplier shipping and Stripe fees.
//   node scripts/shop-margins.mjs            (Stripe US card rate 2.9% + 30¢ by default)
//   node scripts/shop-margins.mjs 0.034 30   (another fee rate)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function margins(catalog, supplier, feePct = 0.029, feeFixed = 30) {
  return catalog.products.map((p) => {
    const s = supplier.products[p.id];
    if (!s) return { id: p.id, name: p.name, price: p.price, missing: true };
    const fees = Math.round(p.price * feePct + feeFixed);
    const profit = p.price - s.cost - s.shipCost - fees;
    return { id: p.id, name: p.name, price: p.price, cost: s.cost, shipCost: s.shipCost, fees, profit, margin: profit / p.price };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL("../shop/", import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL("catalog.json", root)));
  const supplier = JSON.parse(readFileSync(new URL("worker/supplier.json", root)));
  const [pct = 0.029, fixed = 30] = process.argv.slice(2).map(Number);
  const usd = (c) => `$${(c / 100).toFixed(2)}`.padStart(8);
  console.log(`${"Product".padEnd(26)}${"Price".padStart(8)}${"Cost".padStart(8)}${"Ship".padStart(8)}${"Fees".padStart(8)}${"Profit".padStart(8)}  Margin`);
  for (const m of margins(catalog, supplier, pct, fixed)) {
    if (m.missing) { console.log(`${m.name.padEnd(26)}  NO SUPPLIER ENTRY in shop/worker/supplier.json`); continue; }
    const flag = m.margin < 0.3 ? "  <- under 30%" : "";
    console.log(`${m.name.slice(0, 25).padEnd(26)}${usd(m.price)}${usd(m.cost)}${usd(m.shipCost)}${usd(m.fees)}${usd(m.profit)}  ${(m.margin * 100).toFixed(0).padStart(4)}%${flag}`);
  }
  console.log("\nPer single-item order, before ads, returns and taxes. Free-shipping orders also absorb the shipping you'd otherwise charge.");
}
