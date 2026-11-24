// Flat garment illustrations, recoloured per variant. Used until you add real product photos
// (set "image" on a product in catalog.json, or "images": { "Black": "url", ... } per colour).

const SHAPES = {
  tee: `<path class="b" d="M62 44 86 32q14 16 28 0l24 12 36 30-20 26-16-10v112H62V90l-16 10-20-26z"/><path class="l" d="M86 32q14 22 28 0"/>`,
  longsleeve: `<path class="b" d="M62 44 86 32q14 16 28 0l24 12 24 22 22 124-22 6-24-104v108H62V92l-24 104-22-6 22-124z"/><path class="l" d="M86 32q14 22 28 0M38 186l22-6M162 186l-22-6"/><path class="l" d="M140 92v-2M60 92v-2"/>`,
  crewneck: `<path class="b" d="M62 44 86 32q14 16 28 0l24 12 24 22 22 124-22 6-24-104v108H62V92l-24 104-22-6 22-124z"/><path class="l" d="M84 33q16 26 32 0M62 186h76M38 184l22-5M162 184l-22-5"/>`,
  hoodie: `<path class="b" d="M78 44q-6-38 22-40 28 2 22 40z"/><path class="b" d="M62 44 84 34q16 24 32 0l22 10 24 22 22 124-22 6-24-104v108H62V92l-24 104-22-6 22-124z"/><path class="l" d="M84 34q16 30 32 0M94 50v26M106 50v26M74 140h52l8 32H66z"/>`,
  pants: `<path class="b" d="M66 30h68l12 182h-38l-8-120-8 120H54z"/><path class="l" d="M66 44h68M100 44v40M74 52q8 18 0 28M126 52q-8 18 0 28"/>`,
  shorts: `<path class="b" d="M58 62h84l12 92h-46l-8-48-8 48H46z"/><path class="l" d="M58 76h84M100 76v30M66 84q8 14 0 22M134 84q-8 14 0 22"/>`,
  cap: `<path class="b" d="M44 146q2-76 56-82 54 6 56 82z"/><path class="b" d="M118 140q48-6 66 10-4 12-68 6z"/><path class="l" d="M100 64v82M70 76q-14 30-14 70M130 76q14 30 14 70"/><circle class="k" cx="100" cy="63" r="5"/>`,
  beanie: `<path class="b" d="M54 140q0-82 46-86 46 4 46 86z"/><rect class="b" x="50" y="136" width="100" height="40" rx="6"/><path class="l" d="M64 142v28M78 142v28M92 142v28M106 142v28M120 142v28M134 142v28M70 130q4-40 14-62M100 130V58M130 130q-4-40-14-62"/>`,
  socks: `<path class="b" d="M70 28h34v110q0 18 18 22l30 6q16 6 8 24H98q-28-4-28-36z"/><path class="b" d="M100 40h34v104q0 18 18 22l22 4q14 6 6 22h-50q-30-4-30-36z" transform="translate(6 6)"/><path class="l" d="M70 44h34M106 54h34"/>`,
  tote: `<path class="l w" d="M74 92V60q0-22 26-22t26 22v32"/><path class="b" d="M46 88h108l-6 124H52z"/><path class="l" d="M60 106h80"/>`,
};

function luminance(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Just the filled body parts, for the light/shade overlay
const bodies = (markup) => (markup.match(/<(?:path|rect)[^>]*class="b"[^>]*\/>/g) || []).join("").replace(/ class="b"/g, "");

let uid = 0;
/** Returns an <svg> string for a product in a colour. */
export function garmentSvg(shape_, hex, label = "") {
  const dark = luminance(hex) < 0.18;
  const line = dark ? "rgba(255,255,255,.22)" : "rgba(0,0,0,.18)";
  const id = `g${++uid}`;
  const shape = SHAPES[shape_] || SHAPES.tee;
  // Attributes, not a <style> block: inline SVG styles are page-global, so classes would clash between products.
  const attrs = {
    b: `fill="${hex}" stroke="${line}" stroke-width="1.5" stroke-linejoin="round"`,
    l: `fill="none" stroke="${line}" stroke-width="1.5" stroke-linecap="round"`,
    "l w": `fill="none" stroke="${dark ? "#555" : "#8a8172"}" stroke-width="5" stroke-linecap="round"`,
    k: `fill="${line}"`,
  };
  const painted = shape.replace(/class="([^"]+)"/g, (_, c) => attrs[c] || "");
  return `<svg viewBox="0 0 200 240" role="img" aria-label="${label.replace(/"/g, "&quot;")}" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".18"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".12"/></linearGradient></defs>
<g>${painted}</g>
<g fill="url(#${id})">${bodies(shape)}</g>
</svg>`;
}

/** Photo if the catalog has one for this colour, otherwise the illustration. */
export function productVisual(p, colorName) {
  const color = p.colors.find((c) => c.name === colorName) || p.colors[0];
  const photo = (p.images && p.images[color.name]) || p.image;
  const alt = `${p.name} in ${color.name}`;
  if (photo) return `<img src="${encodeURI(photo)}" alt="${alt.replace(/"/g, "&quot;")}" loading="lazy">`;
  return garmentSvg(p.shape, color.hex, alt);
}
