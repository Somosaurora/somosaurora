// JUMP está cerrado al público («sitio en construcción»): la web publicada manda /jump y todo lo que cuelga de ella
// a /en-construccion/, y no publica las API abiertas a cualquiera (postulaciones y votos).
// Para abrir JUMP de nuevo: quitar las dos redirecciones a /en-construccion/ de vercel.json, las dos líneas de JUMP
// en .vercelignore y esta prueba.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { iniciarSim } from "./sim/servidor.mjs";

const require = createRequire(import.meta.url);
const { getTransformedRoutes } = require("@vercel/routing-utils");
const leer = (ruta) => readFileSync(new URL("../../" + ruta, import.meta.url), "utf8");
const NAVEGADOR = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const CERRADO = { status: 307, destino: "/en-construccion/" };

// Lo que Vercel hace con una ruta antes de buscar el archivo: la primera redirección que aplica a un navegador normal.
function redireccion(ruta) {
  const vj = JSON.parse(leer("vercel.json"));
  for (const r of getTransformedRoutes({ redirects: vj.redirects, headers: vj.headers }).routes) {
    if (r.handle === "filesystem") break;
    if (!r.status || r.missing || !new RegExp(r.src).test(ruta)) continue; // missing: solo quien no manda User-Agent
    if (r.has && !r.has.every((h) => h.key === "user-agent" && new RegExp("^" + h.value + "$").test(NAVEGADOR))) continue;
    return { status: r.status, destino: r.headers.Location };
  }
  return null;
}

test("la página de JUMP, la comunidad y todos sus archivos llevan a «en construcción»", () => {
  for (const ruta of ["/jump", "/jump/", "/jump/index.html", "/jump/comunidad", "/jump/comunidad/",
    "/jump/comunidad/privacidad.html", "/jump/landing.js", "/jump/jc/jc.css", "/jump/assets/josue-hero.webp"])
    assert.deepEqual(redireccion(ruta), CERRADO, ruta);
});

test("el resto del sitio sigue igual", () => {
  for (const ruta of ["/", "/index.html", "/terminos.html", "/politica-datos.html", "/admin/", "/en-construccion/",
    "/api/submit", "/api/jump-config", "/api/jump-zoom-deauth", "/jumper", "/jump-x"])
    assert.equal(redireccion(ruta), null, ruta);
});

test("la página «en construcción» existe, no se indexa y no pide nada de /jump/ (que redirige a ella)", () => {
  const html = leer("en-construccion/index.html");
  assert.match(html, /<html lang="es">/);
  assert.match(html, /<title>JUMP · Sitio en construcción<\/title>/);
  assert.match(html, /<h1>Sitio en construcción<\/h1>/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /<a [^>]*href="\/"/, "lleva de vuelta a Somos Aurora");
  assert.doesNotMatch(html, /<script/i, "la CSP del sitio no deja scripts en línea sin su hash");
  assert.doesNotMatch(html, /(?:src|href)=["']?\/jump|url\(["']?\/jump/i);
  assert.doesNotMatch(html, /barrio/i);
});

test("las API de JUMP abiertas a cualquiera no se publican, y nada publicado las usa", () => {
  const ignorados = leer(".vercelignore").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  for (const api of ["/api/jump-postular.js", "/api/jump-publico.js"]) assert.ok(ignorados.includes(api), api);
  // El aviso de Zoom (alguien desconecta la app) sigue publicado: Zoom lo llama aunque JUMP esté cerrado.
  assert.ok(!ignorados.some((l) => "/api/jump-zoom-deauth.js".startsWith(l)), "jump-zoom-deauth debe publicarse");
  const publicados = readdirSync(new URL("../../api/", import.meta.url), { recursive: true })
    .map((f) => "api/" + String(f).replace(/\\/g, "/"))
    .filter((f) => f.endsWith(".js") && !ignorados.includes("/" + f));
  for (const f of publicados) assert.doesNotMatch(leer(f), /\bfrom\s+["'][^"']*jump-(postular|publico)\.js["']/, f);
});

test("el simulador de las pruebas sigue sirviendo JUMP, para poder seguir trabajándolo", async () => {
  const sim = await iniciarSim();
  try {
    const r = await fetch(sim.url + "/jump/", { headers: { "User-Agent": NAVEGADOR }, redirect: "manual" });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<title>JUMP/);
  } finally { await sim.cerrar(); }
});
