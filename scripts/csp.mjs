// Recalcula la Content-Security-Policy de vercel.json a partir de los <script> en línea de las páginas.
//
// Las páginas usan scripts dentro del propio HTML; la CSP solo los deja correr si su hash coincide.
// Por eso, CADA VEZ que se edite un <script> en línea de index.html, admin/index.html, terminos.html,
// politica-datos.html o informe-demo.html hay que correr:
//
//     node scripts/csp.mjs          # actualiza vercel.json
//     node scripts/csp.mjs --check  # solo comprueba (sale con error si está desactualizada)
//
// Si se olvida, el navegador bloquea ese script y la página pierde su JavaScript.
// (Los saltos de línea se normalizan a LF antes de calcular el hash: es lo que ve el navegador,
// aunque el archivo local esté en Windows con CRLF. En el repositorio siempre quedan en LF.)

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8");

const PUBLIC_PAGES = ["index.html", "terminos.html", "politica-datos.html", "informe-demo.html"];
const ADMIN_PAGES = ["admin/index.html"];
const SUPABASE_HOST = "https://jdterctcniotbipgwcdv.supabase.co";
const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";

function inlineHashes(files) {
  const out = new Set();
  for (const f of files) {
    for (const m of read(f).matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      const text = m[1].replace(/\r\n?/g, "\n"); // lo que ve el navegador (el HTML normaliza los saltos de línea)
      if (text.trim()) out.add(`'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`);
    }
  }
  return [...out].sort();
}

const common = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];
const publicCsp = [...common, `script-src 'self' ${inlineHashes(PUBLIC_PAGES).join(" ")}`, "img-src 'self' data:", "connect-src 'self'"].join("; ");
const adminCsp = [...common, `script-src 'self' ${inlineHashes(ADMIN_PAGES).join(" ")} ${SUPABASE_JS}`, `img-src 'self' data: ${SUPABASE_HOST}`, `connect-src 'self' ${SUPABASE_HOST}`].join("; ");

const cfg = JSON.parse(read("vercel.json"));
let touched = 0;
for (const rule of cfg.headers || []) {
  for (const h of rule.headers) {
    if (h.key !== "Content-Security-Policy") continue;
    const want = rule.source.startsWith("/admin") ? adminCsp : publicCsp;
    if (h.value !== want) { h.value = want; touched++; }
  }
}
if (process.argv.includes("--check")) {
  if (touched) { console.error("La CSP de vercel.json está desactualizada. Corre: node scripts/csp.mjs"); process.exit(1); }
  console.log("CSP al día."); process.exit(0);
}
if (touched) writeFileSync(join(root, "vercel.json"), JSON.stringify(cfg, null, 2) + "\n");
console.log(touched ? `CSP actualizada (${touched}).` : "CSP ya estaba al día.");
