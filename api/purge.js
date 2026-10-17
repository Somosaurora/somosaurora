// GET /api/purge — Limpieza automática de 30 días (Vercel Cron, una vez al día).
// Borra las opiniones recibidas hace más de 30 días y sus fotos del bucket privado
// "evidencias", salvo las marcadas "en gestión" (excepción del punto 6 de la
// Política de tratamiento de datos personales). Los informes semanales y las
// opiniones destacadas (ya anónimas) no se tocan.
//
// Seguridad: exige `Authorization: Bearer <CRON_SECRET>` (Vercel lo envía solo
// cuando la variable CRON_SECRET existe en el proyecto). Sin secreto configurado
// no hace nada. Usa la SERVICE_ROLE_KEY, que vive solo en variables de Vercel.
//
// Prueba sin borrar:  GET /api/purge?dry=1  (con el mismo encabezado).

export const config = { runtime: "edge" };

const RETENCION_DIAS = 30;   // debe coincidir con la política publicada
const LOTE = 100;            // filas por tanda
const MAX_LOTES = 10;        // tope por ejecución (si sobran, siguen mañana)

export default async function handler(request) {
  if (request.method !== "GET") return json({ ok: false, error: "Método no permitido." }, 405);
  const env = process.env;
  // Acepta tanto los nombres estándar como los que quedaron puestos en Vercel.
  const SUPA_URL = env.SUPABASE_URL || env.ProjectURL || "";
  const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY || env.service_role || "";
  const SECRET = env.CRON_SECRET || "";

  if (SECRET.length < 16) return json({ ok: false, error: "CRON_SECRET no está configurado." }, 503);
  if (!sameString(request.headers.get("authorization") || "", `Bearer ${SECRET}`))
    return json({ ok: false, error: "No autorizado." }, 401);
  if (!SUPA_URL || !SERVICE) return json({ ok: false, error: "Falta la conexión a la base de datos." }, 500);

  const dry = new URL(request.url).searchParams.get("dry") === "1";
  const cutoff = new Date(Date.now() - RETENCION_DIAS * 864e5).toISOString();
  const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
  const vencidas = `created_at=lt.${encodeURIComponent(cutoff)}&en_gestion=is.false`;

  let opiniones = 0, fotos = 0, error = null;
  try {
    if (dry) {
      const total = await contar(SUPA_URL, H, `submissions?select=id&${vencidas}`);
      const conFoto = await contar(SUPA_URL, H, `submissions?select=id&${vencidas}&evidencia_path=not.is.null`);
      return json({ ok: true, dry: true, cutoff, vencidas: { opiniones: total, fotos: conFoto } });
    }

    for (let i = 0; i < MAX_LOTES; i++) {
      const r = await fetch(
        `${SUPA_URL}/rest/v1/submissions?select=id,evidencia_path&${vencidas}&order=created_at.asc&limit=${LOTE}`,
        { headers: H }
      );
      if (!r.ok) throw new Error(`Consulta fallida (${r.status}). ¿Aplicaste la migración 0003?`);
      const lote = await r.json();
      if (!lote.length) break;

      // 1º las fotos: si falla, no se borran las filas y se reintenta mañana.
      const rutas = lote.map((x) => x.evidencia_path).filter(Boolean);
      if (rutas.length) {
        const d = await fetch(`${SUPA_URL}/storage/v1/object/evidencias`, {
          method: "DELETE",
          headers: { ...H, "Content-Type": "application/json" },
          body: JSON.stringify({ prefixes: rutas }),
        });
        if (!d.ok) throw new Error(`No se pudieron borrar las fotos (${d.status}).`);
      }

      const ids = lote.map((x) => x.id).join(",");
      const b = await fetch(`${SUPA_URL}/rest/v1/submissions?id=in.(${ids})`, {
        method: "DELETE",
        headers: { ...H, Prefer: "return=minimal" },
      });
      if (!b.ok) throw new Error(`No se pudieron borrar las opiniones (${b.status}).`);

      opiniones += lote.length;
      fotos += rutas.length;
      if (lote.length < LOTE) break;
    }
  } catch (e) {
    error = String((e && e.message) || e);
  }

  // Bitácora (solo conteos). Si falla, no afecta a la limpieza.
  try {
    await fetch(`${SUPA_URL}/rest/v1/purga_log`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ opiniones, fotos, error }),
    });
  } catch {}

  console.log(JSON.stringify({ purga: { cutoff, opiniones, fotos, error } }));
  return json({ ok: !error, cutoff, borradas: { opiniones, fotos }, error }, error ? 500 : 200);
}

async function contar(base, H, path) {
  const r = await fetch(`${base}/rest/v1/${path}`, { headers: { ...H, Prefer: "count=exact", Range: "0-0" } });
  if (!r.ok) throw new Error(`Consulta fallida (${r.status}). ¿Aplicaste la migración 0003?`);
  const m = (r.headers.get("content-range") || "").match(/\/(\d+)$/);
  return m ? Number(m[1]) : 0;
}

// Comparación sin salida temprana (evita filtrar el secreto por tiempos).
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
