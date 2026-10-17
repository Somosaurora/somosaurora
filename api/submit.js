// /api/submit — Entrada pública de opiniones (Vercel Edge Function).
//
//   GET  → entrega un desafío anti-bot (prueba de trabajo firmada y ligada a la conexión).
//   POST → valida y guarda la opinión (y la foto, si hay) en Supabase.
//
// Capas, de la más barata a la más cara (todas antes de tocar la base de datos):
//   1. Mismo origen (Origin = este sitio) y tamaño máximo del cuerpo.
//   2. Prueba de trabajo: hay que pedir un desafío (GET), resolverlo y esperar unos
//      segundos. Es de un solo uso por conexión y caduca. Frena scripts que disparan POST.
//   3. Límite por conexión (hash de IP) y tope global por hora.
//   4. Honeypot, listas permitidas (tema, sector, tipo), largos máximos y foto con
//      verificación de formato real (no se confía en el tipo que declara el navegador).
//
// La SERVICE_ROLE_KEY vive SOLO aquí (variables de entorno de Vercel). A quien llama
// nunca se le devuelve detalle interno de errores.

export const config = { runtime: "edge" };

// Versión de la política que se acepta al marcar la casilla = fecha de "Última
// actualización" de politica-datos.html. Si cambias la política, cambia también esto.
const CONSENT_VERSION = "2026-10-15";

const TIPOS = ["Propuesta", "Queja o problema", "Otro tema"];
const TEMAS = [
  "Agua potable y cortes", "Alcantarillado e inundaciones", "Tráfico y movilidad", "Calles y baches",
  "Basura y aseo", "Alumbrado público", "Áreas verdes y parques", "Otro servicio",
];
const SECTORES = [
  "Villa Club", "La Joya", "La Rioja", "Laguna Club", "Villa Italia", "La Piazza", "Avalon Plaza",
  "Palmora Plaza", "Vermont Plaza", "Av. León Febres-Cordero", "Zona abierta o pueblo antiguo", "Otro sector",
];

// Vercel rechaza cuerpos de más de 4,5 MB, así que la foto (que el navegador reduce
// antes de enviar) no puede pasar de 4 MB.
const MAX_BODY = 4.4 * 1024 * 1024;
const MAX_PHOTO = 4 * 1024 * 1024;
const LEN = { referencia: 120, nombre: 60, detalleMin: 10, detalleMax: 600 };

// Límites de envío. Hay barrios enteros detrás de una misma IP móvil (CGNAT), por eso
// el tope por conexión es holgado; el global es un cortafuegos contra inundaciones.
const LIMITS = { per10min: 5, perDay: 30, globalHour: 400 };

// Prueba de trabajo (estilo ALTCHA/hashcash, sin servicios de terceros).
const POW = { maxnumber: 50000, minAgeMs: 4000, maxAgeMs: 15 * 60 * 1000 };

export default async function handler(request) {
  const env = process.env;
  // Acepta tanto los nombres estándar como los que quedaron puestos en Vercel.
  const SUPA_URL = env.SUPABASE_URL || env.ProjectURL || "";
  const SUPA_SERVICE = env.SUPABASE_SERVICE_ROLE_KEY || env.service_role || "";
  const IP_SALT = env.IP_SALT || "";
  // Sin una sal larga no hay prueba de trabajo (no se firma con una clave adivinable).
  const powKey = IP_SALT.length >= 16 ? "pow|" + IP_SALT : "";

  const ip = clientIp(request);
  const ipHash = ip ? await sha256Hex(ip + "|" + (IP_SALT || "aurora")) : null;

  // ---- GET: desafío ------------------------------------------------------------
  if (request.method === "GET") {
    if (!powKey) return json({ ok: true, pow: false });
    const issued = Date.now();
    const salt = `${randomHex(12)}.${issued}`;
    const number = randomInt(POW.maxnumber);
    const challenge = await sha256Hex(salt + number);
    const signature = await hmacHex(powKey, `${salt}|${challenge}|${ipHash || "-"}`);
    return json({ ok: true, pow: true, salt, challenge, signature, maxnumber: POW.maxnumber, issued, minAgeMs: POW.minAgeMs });
  }
  if (request.method !== "POST") return json({ ok: false, error: "Método no permitido." }, 405);

  // ---- POST --------------------------------------------------------------------
  // 1) Mismo origen y tamaño
  const origin = request.headers.get("origin") || "";
  let sameOrigin = false;
  try { sameOrigin = !!origin && new URL(origin).host === new URL(request.url).host; } catch {}
  if (!sameOrigin) return json({ ok: false, error: "Solicitud no permitida." }, 403);
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BODY) return json({ ok: false, error: "El envío es demasiado grande.", code: "size" }, 413);

  if (!SUPA_URL || !SUPA_SERVICE)
    return json({ ok: false, error: "El servidor no tiene configurada la conexión a la base de datos." }, 500);

  // 2) Prueba de trabajo (antes de leer el cuerpo)
  if (powKey) {
    const bad = await checkPow(request.headers.get("x-aurora-pow") || "", powKey, ipHash);
    if (bad) return json({ ok: false, error: "Verificación no válida. Inténtalo de nuevo.", code: bad }, bad === "too_fast" ? 429 : 403);
  }

  // 3) Límite por conexión y global
  const H = { apikey: SUPA_SERVICE, Authorization: `Bearer ${SUPA_SERVICE}` };
  const limited = await overLimit(SUPA_URL, H, ipHash);
  if (limited) return json({ ok: false, error: "Hay muchos envíos ahora mismo. Inténtalo de nuevo en unos minutos.", code: "rate" }, 429, { "Retry-After": "300" });

  let uploaded = null;
  try {
    let form;
    try { form = await request.formData(); } catch { return json({ ok: false, error: "Envío no válido." }, 400); }

    // 4) Honeypot: si un bot llena este campo, respondemos "ok" y descartamos.
    if (clean(form.get("bot-field"))) return json({ ok: true });

    const tipo    = clean(form.get("tipo"));
    const tema    = clean(form.get("tema"));
    const sector  = clean(form.get("sector"));
    const refer   = clean(form.get("referencia"));
    const detalle = clean(form.get("detalle"));
    const nombre  = clean(form.get("nombre"));
    const celular = clean(form.get("celular"));
    const consRaw = clean(form.get("consentimiento"));
    const consentimiento = consRaw === "si" || consRaw === "true" || consRaw === "on";

    if (!TIPOS.includes(tipo))        return json({ ok: false, error: "Tipo inválido." }, 400);
    if (!TEMAS.includes(tema))        return json({ ok: false, error: "Tema inválido." }, 400);
    if (sector && !SECTORES.includes(sector)) return json({ ok: false, error: "Sector inválido." }, 400);
    if (detalle.length < LEN.detalleMin || detalle.length > LEN.detalleMax)
                                      return json({ ok: false, error: "El detalle debe tener entre 10 y 600 caracteres." }, 400);
    if (refer.length > LEN.referencia || nombre.length > LEN.nombre)
                                      return json({ ok: false, error: "Hay un campo demasiado largo." }, 400);
    if (!consentimiento)              return json({ ok: false, error: "Falta la autorización." }, 400);
    if (celular && !/^[0-9+\s-]{6,15}$/.test(celular))
                                      return json({ ok: false, error: "Celular inválido." }, 400);

    // 5) Foto opcional → Supabase Storage (bucket privado "evidencias")
    let evidencia_path = null;
    const file = form.get("evidencia");
    if (file && typeof file === "object" && file.size > 0) {
      if (file.size > MAX_PHOTO) return json({ ok: false, error: "La foto pesa demasiado.", code: "photo" }, 400);
      const buf = new Uint8Array(await file.arrayBuffer());
      const kind = imageKind(buf); // por el contenido real, no por lo que declare el navegador
      if (!kind) return json({ ok: false, error: "El archivo no es una imagen válida (JPG, PNG, WEBP, GIF o HEIC).", code: "photo" }, 400);
      const key = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${kind.ext}`;
      const up = await fetch(`${SUPA_URL}/storage/v1/object/evidencias/${key}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SUPA_SERVICE}`, "Content-Type": kind.mime, "x-upsert": "false" },
        body: buf,
      });
      if (up.ok) { evidencia_path = key; uploaded = key; } // si falla, continuamos sin foto
    }

    const row = {
      tipo, tema,
      sector: sector || null,
      referencia: refer || null,
      detalle,
      evidencia_path,
      nombre: nombre || null,
      celular: celular || null,
      consentimiento,
      ip_hash: ipHash, // hash con sal; no guardamos la IP cruda
      consent_version: CONSENT_VERSION,
      consent_at: new Date().toISOString(),
    };

    let ins = await insertRow(SUPA_URL, SUPA_SERVICE, row);
    if (!ins.ok) {
      const detail = await ins.text();
      // Migración 0004 aún sin aplicar: se guarda igual, sin los campos de consentimiento versionado.
      if (ins.status === 400 && /consent_(version|at)/.test(detail)) {
        const { consent_version, consent_at, ...legacy } = row;
        ins = await insertRow(SUPA_URL, SUPA_SERVICE, legacy);
      } else {
        console.error("submit: insert falló", ins.status); // sin el detalle: podría traer datos de la fila
      }
    }
    if (!ins.ok) {
      if (uploaded) await removePhoto(SUPA_URL, SUPA_SERVICE, uploaded); // no dejar fotos huérfanas
      return json({ ok: false, error: "No se pudo guardar. Inténtalo de nuevo." }, 502);
    }
    return json({ ok: true });
  } catch (e) {
    console.error("submit: error", String((e && e.message) || e));
    if (uploaded) await removePhoto(SUPA_URL, SUPA_SERVICE, uploaded);
    return json({ ok: false, error: "Error del servidor." }, 500);
  }
}

// ---- límites ---------------------------------------------------------------------
async function overLimit(base, H, ipHash) {
  try {
    const now = Date.now();
    if (ipHash) {
      const since = new Date(now - 24 * 36e5).toISOString();
      const r = await fetch(
        `${base}/rest/v1/submissions?select=created_at&ip_hash=eq.${ipHash}&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=${LIMITS.perDay + 1}`,
        { headers: H }
      );
      if (r.ok) {
        const rows = await r.json();
        if (rows.length >= LIMITS.perDay) return true;
        const cut = now - 10 * 60 * 1000;
        if (rows.filter((x) => Date.parse(x.created_at) >= cut).length >= LIMITS.per10min) return true;
      }
    }
    const hour = new Date(now - 36e5).toISOString();
    const g = await fetch(`${base}/rest/v1/submissions?select=id&created_at=gte.${encodeURIComponent(hour)}`, {
      headers: { ...H, Prefer: "count=exact", Range: "0-0" },
    });
    const m = (g.headers.get("content-range") || "").match(/\/(\d+)$/);
    if (m && Number(m[1]) >= LIMITS.globalHour) return true;
  } catch {} // si la consulta falla, no se bloquea a la gente (el insert fallará solo si la base cayó)
  return false;
}

// ---- prueba de trabajo -----------------------------------------------------------
async function checkPow(token, key, ipHash) {
  if (!token || token.length > 800) return "pow";
  let t;
  try { t = JSON.parse(atob(token)); } catch { return "pow"; }
  const { salt, challenge, signature, number } = t || {};
  if (typeof salt !== "string" || typeof challenge !== "string" || typeof signature !== "string") return "pow";
  if (!Number.isInteger(number) || number < 0 || number > POW.maxnumber) return "pow";
  const issued = Number(salt.split(".")[1]);
  if (!(issued > 0)) return "pow";
  const age = Date.now() - issued;
  if (age > POW.maxAgeMs) return "expired";
  if (age < POW.minAgeMs) return "too_fast";
  const expected = await hmacHex(key, `${salt}|${challenge}|${ipHash || "-"}`);
  if (!sameString(expected, signature)) return "pow"; // firma falsa, o pedida desde otra conexión
  if ((await sha256Hex(salt + number)) !== challenge) return "pow";
  return null;
}

// ---- imágenes --------------------------------------------------------------------
function imageKind(b) {
  const at = (i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length < 16) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b[0] === 0x89 && at(1, "PNG") && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return { mime: "image/png", ext: "png" };
  if (at(0, "GIF87a") || at(0, "GIF89a")) return { mime: "image/gif", ext: "gif" };
  if (at(0, "RIFF") && at(8, "WEBP")) return { mime: "image/webp", ext: "webp" };
  if (at(4, "ftyp") && ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].some((s) => at(8, s)))
    return { mime: "image/heic", ext: "heic" };
  return null;
}

// ---- utilidades ------------------------------------------------------------------
function insertRow(base, key, row) {
  return fetch(`${base}/rest/v1/submissions`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
}
async function removePhoto(base, key, path) {
  try {
    await fetch(`${base}/storage/v1/object/evidencias`, {
      method: "DELETE",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: [path] }),
    });
  } catch {}
}
function clientIp(request) {
  return (request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "").split(",")[0].trim();
}
function clean(v) { return (v == null ? "" : String(v)).replace(/\s+/g, " ").trim(); }
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });
}
const enc = (s) => new TextEncoder().encode(s);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256Hex(s) { return hex(await crypto.subtle.digest("SHA-256", enc(s))); }
async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc(msg)));
}
function randomHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a); }
function randomInt(max) { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % (max + 1); }
// Comparación sin salida temprana (evita filtrar la firma por tiempos).
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
