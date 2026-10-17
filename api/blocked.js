// GET /api/blocked — Destino de las redirecciones de vercel.json para clientes automatizados
// (rastreadores de IA, bibliotecas HTTP genéricas, navegadores sin interfaz o sin User-Agent).
// Responde 403 sin contenido útil. Las personas con navegador normal nunca llegan aquí.

export const config = { runtime: "edge" };

export default function handler() {
  return new Response("403 — Este sitio no autoriza la lectura automatizada de su contenido.\n", {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, noai" },
  });
}
