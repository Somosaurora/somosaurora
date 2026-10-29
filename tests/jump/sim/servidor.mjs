// Supabase simulado por HTTP sobre PGlite (Postgres real con RLS) + el sitio estático con las cabeceras de vercel.json
// + las funciones /api/jump-* reales + un Zoom falso. Solo para pruebas.
//
// Imita el subconjunto que usa la Comunidad JUMP:
//   REST    /supa/rest/v1/<tabla>   GET/HEAD/POST/PATCH/DELETE, filtros eq|neq|gt|gte|lt|lte|is|in|like|ilike,
//                                    select=cols|*, order, limit, offset, Prefer return/count/resolution, on_conflict,
//                                    Accept: application/vnd.pgrst.object+json
//           /supa/rest/v1/rpc/<fn>  POST con argumentos por nombre
//   Auth    /supa/auth/v1/token (password, refresh_token), /user, /logout, /admin/users[/:id]
//   Storage /supa/storage/v1/object/<bucket>/<ruta>, /object/sign/… (una ruta o varias: createSignedUrls),
//           /object/public/…, DELETE /object/<bucket>
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { crearBase, como } from "./db.mjs";

const require = createRequire(import.meta.url);
const { getTransformedRoutes } = require("@vercel/routing-utils");
const RAIZ_REPO = fileURLToPath(new URL("../../../", import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".pdf": "application/pdf",
};
const ID = /^[a-z_][a-z0-9_]*$/;
const b64u = (s) => Buffer.from(s).toString("base64url");

class ErrorHttp extends Error {
  constructor(status, cuerpo) { super(cuerpo.message || cuerpo.msg || "error"); this.status = status; this.cuerpo = cuerpo; }
}

// Error de Postgres → respuesta como la da PostgREST.
function errorPg(e, rol) {
  const code = e.code || "XX000";
  const status = code === "42501" ? (rol === "anon" ? 401 : 403)
    : code === "23505" || code === "23503" ? 409
    : code === "42P01" || code === "42883" ? 404
    : 400;
  return new ErrorHttp(status, { code, message: e.message, details: e.detail ?? null, hint: e.hint ?? null });
}

export async function iniciarSim({ puerto = 0, raiz = RAIZ_REPO, db = null } = {}) {
  db = db || (await crearBase());
  const refrescos = new Map(); // refresh_token → user id
  const archivos = new Map(); // "bucket/ruta" → { bytes, tipo }
  const firmas = new Map(); // token → "bucket/ruta"
  const zoomFalso = crearZoomFalso();
  let origen = "";

  // ---------- JWT ----------
  const emitir = async (u) => {
    const ahora = Math.floor(Date.now() / 1000);
    const access_token = [b64u('{"alg":"HS256","typ":"JWT"}'),
      b64u(JSON.stringify({ sub: u.id, email: u.email, role: "authenticated", aud: "authenticated", iat: ahora, exp: ahora + 3600 })),
      "firma-falsa"].join(".");
    const refresh_token = randomUUID();
    refrescos.set(refresh_token, u.id);
    return { access_token, token_type: "bearer", expires_in: 3600, expires_at: ahora + 3600, refresh_token, user: usuarioJson(u) };
  };
  const usuarioJson = (u) => ({ id: u.id, aud: "authenticated", role: "authenticated", email: u.email,
    email_confirmed_at: u.created_at, app_metadata: { provider: "email" }, user_metadata: u.raw_user_meta_data || {},
    created_at: u.created_at, banned_until: u.banned_until });
  const leerJwt = (token) => {
    const partes = String(token || "").split(".");
    if (partes.length !== 3) return null;
    try {
      const c = JSON.parse(Buffer.from(partes[1], "base64url").toString());
      return c.exp * 1000 > Date.now() ? c : "vencido";
    } catch { return null; }
  };
  const usuarioPorId = async (id) => (await db.query("select * from auth.users where id = $1", [id])).rows[0];
  const usuarioPorEmail = async (email) => (await db.query("select * from auth.users where lower(email) = lower($1)", [email])).rows[0];
  const baneado = (u) => u.banned_until && new Date(u.banned_until) > new Date();

  // Quién llama según el Bearer: "service", "anon" o el usuario del JWT.
  function quien(req) {
    const h = req.headers.authorization || "";
    const t = h.startsWith("Bearer ") ? h.slice(7) : req.headers.apikey || "anon";
    if (t === "service") return { rol: "service_role", quien: "service" };
    if (t === "anon") return { rol: "anon", quien: "anon" };
    const c = leerJwt(t);
    if (c === "vencido") throw new ErrorHttp(401, { code: "PGRST301", message: "JWT expired" });
    if (!c) throw new ErrorHttp(401, { code: "PGRST301", message: "JWT invalid" });
    return { rol: "authenticated", quien: { id: c.sub, email: c.email } };
  }

  // ---------- REST ----------
  function filtros(params, valores) {
    const w = [];
    for (const [k, v] of params) {
      if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(k)) continue;
      if (!ID.test(k)) throw new ErrorHttp(400, { code: "PGRST100", message: `columna inválida ${k}` });
      const i = v.indexOf(".");
      const op = v.slice(0, i), val = v.slice(i + 1);
      const p = () => { valores.push(val); return "$" + valores.length; };
      if (op === "eq") w.push(`${k} = ${p()}`);
      else if (op === "neq") w.push(`${k} <> ${p()}`);
      else if (["gt", "gte", "lt", "lte"].includes(op)) w.push(`${k} ${{ gt: ">", gte: ">=", lt: "<", lte: "<=" }[op]} ${p()}`);
      else if (op === "like") w.push(`${k}::text like ${p()}`);
      else if (op === "ilike") w.push(`${k}::text ilike ${p()}`);
      else if (op === "is") {
        if (!["null", "true", "false"].includes(val)) throw new ErrorHttp(400, { code: "PGRST100", message: "is inválido" });
        w.push(`${k} is ${val}`);
      } else if (op === "in") {
        const lista = val.replace(/^\(|\)$/g, "").split(",").filter(Boolean).map((x) => x.replace(/^"|"$/g, ""));
        valores.push(lista);
        w.push(`${k}::text = any($${valores.length}::text[])`);
      } else throw new ErrorHttp(400, { code: "PGRST100", message: `operador no soportado ${op}` });
    }
    return w.length ? " where " + w.join(" and ") : "";
  }
  const columnas = (sel) => {
    if (!sel || sel === "*") return "*";
    const cols = sel.split(",").map((c) => c.trim());
    if (!cols.every((c) => ID.test(c))) throw new ErrorHttp(400, { code: "PGRST100", message: `select no soportado: ${sel}` });
    return cols.join(", ");
  };
  const orden = (o) => {
    if (!o) return "";
    return " order by " + o.split(",").map((x) => {
      const [c, ...mods] = x.split(".");
      if (!ID.test(c)) throw new ErrorHttp(400, { code: "PGRST100", message: "order inválido" });
      return c + (mods.includes("desc") ? " desc" : " asc") + (mods.includes("nullslast") ? " nulls last" : mods.includes("nullsfirst") ? " nulls first" : "");
    }).join(", ");
  };
  const clavePrimaria = async (tabla) => (await db.query(
    `select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = ('public.' || $1)::regclass and i.indisprimary`, [tabla])).rows.map((r) => r.attname);

  async function rest(req, res, ruta, url, cuerpo) {
    const q = quien(req);
    const prefer = String(req.headers.prefer || "");
    const objeto = String(req.headers.accept || "").includes("vnd.pgrst.object");
    const p = url.searchParams;

    if (ruta.startsWith("rpc/")) {
      const fn = ruta.slice(4);
      if (!ID.test(fn)) throw new ErrorHttp(404, { code: "PGRST202", message: "función inválida" });
      const info = (await db.query(
        `select p.proretset, t.typtype, t.typname from pg_proc p join pg_type t on t.oid = p.prorettype
          where p.proname = $1 and p.pronamespace = 'public'::regnamespace`, [fn])).rows[0];
      if (!info) throw new ErrorHttp(404, { code: "PGRST202", message: `no existe ${fn}` });
      const args = cuerpo ? JSON.parse(cuerpo) : {};
      const nombres = Object.keys(args);
      if (!nombres.every((n) => ID.test(n))) throw new ErrorHttp(400, { code: "PGRST100", message: "argumento inválido" });
      const llamada = `public.${fn}(${nombres.map((n, i) => `${n} => $${i + 1}`).join(", ")})`;
      const vals = nombres.map((n) => args[n]);
      let r;
      try {
        r = info.proretset || info.typtype === "c"
          ? await como(db, q.quien, `select coalesce(json_agg(r), '[]'::json) as v from ${llamada} r`, vals)
          : await como(db, q.quien, `select to_json(${llamada}) as v`, vals);
      } catch (e) { throw errorPg(e, q.rol); }
      let v = r.rows[0].v;
      if (objeto) {
        if (!Array.isArray(v)) return enviar(res, 200, v);
        if (v.length !== 1) throw new ErrorHttp(406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" });
        v = v[0];
      }
      return info.typname === "void" ? enviar(res, 204, null) : enviar(res, 200, v);
    }

    const tabla = ruta;
    if (!ID.test(tabla)) throw new ErrorHttp(404, { code: "42P01", message: "tabla inválida" });
    const cols = columnas(p.get("select"));
    const vals = [];
    const where = filtros(p, vals);
    const devolver = prefer.includes("return=representation");
    const contar = prefer.includes("count=exact");
    // Como PostgREST: con return=minimal (lo que manda supabase-js v2 si no hay .select()) la escritura usa
    // RETURNING 1, así que no hace falta permiso de lectura sobre todas las columnas (p. ej. ip_hash de postulaciones).
    const devuelve = devolver ? "*" : "1";
    const leer = devolver ? cols : "1 as _";
    let sql;

    if (req.method === "GET" || req.method === "HEAD") {
      const lim = p.get("limit") ? ` limit ${+p.get("limit")}` : "";
      const off = p.get("offset") ? ` offset ${+p.get("offset")}` : "";
      sql = `select coalesce(json_agg(t), '[]'::json) as v from (select ${cols} from public.${tabla}${where}${orden(p.get("order"))}${lim}${off}) t`;
    } else if (req.method === "POST") {
      const filas = [].concat(JSON.parse(cuerpo || "[]"));
      const claves = [...new Set(filas.flatMap((f) => Object.keys(f)))];
      if (!claves.every((c) => ID.test(c))) throw new ErrorHttp(400, { code: "PGRST100", message: "columna inválida" });
      vals.push(JSON.stringify(filas));
      let conflicto = "";
      if (prefer.includes("resolution=")) {
        const cc = p.get("on_conflict") ? p.get("on_conflict").split(",") : await clavePrimaria(tabla);
        conflicto = prefer.includes("ignore-duplicates") ? ` on conflict (${cc.join(", ")}) do nothing`
          : ` on conflict (${cc.join(", ")}) do update set ${claves.filter((c) => !cc.includes(c)).map((c) => `${c} = excluded.${c}`).join(", ") || cc.map((c) => `${c} = excluded.${c}`).join(", ")}`;
      }
      sql = `with x as (insert into public.${tabla} (${claves.join(", ")})
               select ${claves.join(", ")} from json_populate_recordset(null::public.${tabla}, $${vals.length}::json)${conflicto} returning ${devuelve})
             select coalesce(json_agg(t), '[]'::json) as v from (select ${leer} from x) t`;
    } else if (req.method === "PATCH") {
      const fila = JSON.parse(cuerpo || "{}");
      const claves = Object.keys(fila);
      if (!claves.length || !claves.every((c) => ID.test(c))) throw new ErrorHttp(400, { code: "PGRST100", message: "columna inválida" });
      vals.push(JSON.stringify(fila));
      const n = vals.length;
      const asignar = claves.map((c) => `${c} = (select r.${c} from json_populate_record(null::public.${tabla}, $${n}::json) r)`);
      sql = `with x as (update public.${tabla} set ${asignar.join(", ")}${where} returning ${devuelve})
             select coalesce(json_agg(t), '[]'::json) as v from (select ${leer} from x) t`;
    } else if (req.method === "DELETE") {
      sql = `with x as (delete from public.${tabla}${where} returning ${devuelve}) select coalesce(json_agg(t), '[]'::json) as v from (select ${leer} from x) t`;
    } else throw new ErrorHttp(405, { message: "método no permitido" });

    let filas, total = null;
    try {
      filas = (await como(db, q.quien, sql, vals)).rows[0].v;
      if (contar && (req.method === "GET" || req.method === "HEAD"))
        total = (await como(db, q.quien, `select count(*)::int n from public.${tabla}${where}`, vals.slice(0))).rows[0].n;
    } catch (e) { throw errorPg(e, q.rol); }

    const rango = `${filas.length ? `0-${filas.length - 1}` : "*"}/${total ?? "*"}`;
    res.setHeader("Content-Range", rango);
    if (req.method === "HEAD") return enviar(res, 200, null);
    if (req.method !== "GET" && !devolver) return enviar(res, req.method === "POST" ? 201 : 204, null);
    if (objeto) {
      if (filas.length !== 1) throw new ErrorHttp(406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" });
      return enviar(res, req.method === "POST" ? 201 : 200, filas[0]);
    }
    return enviar(res, req.method === "POST" ? 201 : 200, filas);
  }

  // ---------- Auth ----------
  const errorAuth = (status, error_code, msg) => new ErrorHttp(status, { code: status, error_code, msg });

  async function auth(req, res, ruta, url, cuerpo) {
    const b = cuerpo ? JSON.parse(cuerpo) : {};
    if (ruta === "token") {
      const tipo = url.searchParams.get("grant_type");
      let u;
      if (tipo === "password") {
        u = await usuarioPorEmail(b.email || "");
        if (!u || u.encrypted_password !== b.password) throw errorAuth(400, "invalid_credentials", "Invalid login credentials");
      } else if (tipo === "refresh_token") {
        const id = refrescos.get(b.refresh_token);
        if (!id) throw errorAuth(400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
        refrescos.delete(b.refresh_token);
        u = await usuarioPorId(id);
      } else throw errorAuth(400, "validation_failed", "grant_type no soportado");
      if (!u) throw errorAuth(400, "invalid_credentials", "Invalid login credentials");
      if (baneado(u)) throw errorAuth(400, "user_banned", "User is banned");
      return enviar(res, 200, await emitir(u));
    }
    if (ruta === "user") {
      const h = req.headers.authorization || "";
      const c = leerJwt(h.slice(7));
      if (!c || c === "vencido") throw errorAuth(401, "bad_jwt", "invalid JWT");
      const u = await usuarioPorId(c.sub);
      if (!u) throw errorAuth(403, "user_not_found", "User from sub claim in JWT does not exist");
      return enviar(res, 200, usuarioJson(u));
    }
    if (ruta === "logout") return enviar(res, 204, null);
    if (ruta.startsWith("admin/users")) {
      if ((req.headers.authorization || "") !== "Bearer service") throw errorAuth(401, "no_authorization", "service_role requerido");
      const id = ruta.split("/")[2];
      if (req.method === "POST" && !id) {
        if (await usuarioPorEmail(b.email || "")) throw errorAuth(422, "email_exists", "A user with this email address has already been registered");
        const u = (await db.query("insert into auth.users (email, encrypted_password) values ($1, $2) returning *", [b.email, b.password])).rows[0];
        return enviar(res, 200, usuarioJson(u));
      }
      if (!/^[0-9a-f-]{36}$/.test(id || "")) throw errorAuth(404, "user_not_found", "User not found");
      if (req.method === "PUT") {
        if (b.password) await db.query("update auth.users set encrypted_password = $2 where id = $1", [id, b.password]);
        if (b.ban_duration) await db.query("update auth.users set banned_until = $2 where id = $1",
          [id, b.ban_duration === "none" ? null : new Date(Date.now() + parseInt(b.ban_duration, 10) * 3600e3).toISOString()]);
        const u = await usuarioPorId(id);
        if (!u) throw errorAuth(404, "user_not_found", "User not found");
        return enviar(res, 200, usuarioJson(u));
      }
      if (req.method === "DELETE") {
        await db.query("delete from auth.users where id = $1", [id]);
        return enviar(res, 200, {});
      }
    }
    throw errorAuth(404, "not_found", "ruta de auth no soportada");
  }

  // ---------- Storage ----------
  const errorSt = (status, error, message) => new ErrorHttp(status === 403 ? 400 : status, { statusCode: String(status), error, message });

  async function storage(req, res, ruta, url, cuerpoBuf) {
    const q = quien(req);
    const m = ruta.match(/^object\/(sign\/|public\/)?([^/]+)\/?(.*)$/);
    if (!m) throw errorSt(404, "not_found", "ruta de storage no soportada");
    const [, modo, bucket, nombre] = [m[0], m[1] || "", m[2], decodeURIComponent(m[3] || "")];
    const llave = `${bucket}/${nombre}`;
    const leerFila = async (quienLee) => {
      try { return (await como(db, quienLee, "select name from storage.objects where bucket_id = $1 and name = $2", [bucket, nombre])).rows[0]; }
      catch (e) { throw errorSt(403, "Unauthorized", e.message); }
    };

    if (modo === "public/" && req.method === "GET") {
      const b = (await db.query("select public from storage.buckets where id = $1", [bucket])).rows[0];
      if (!b?.public || !archivos.has(llave)) throw errorSt(404, "not_found", "Object not found");
      return enviarArchivo(res, archivos.get(llave));
    }
    if (modo === "sign/" && req.method === "GET") {
      if (firmas.get(url.searchParams.get("token")) !== llave || !archivos.has(llave)) throw errorSt(400, "InvalidSignature", "invalid signature");
      return enviarArchivo(res, archivos.get(llave));
    }
    if (modo === "sign/" && req.method === "POST" && !nombre) { // createSignedUrls: varias rutas en una llamada
      const { paths = [] } = JSON.parse(cuerpoBuf.toString() || "{}");
      const out = [];
      for (const p of paths) {
        let ok = false;
        try { ok = !!(await como(db, q.quien, "select name from storage.objects where bucket_id = $1 and name = $2", [bucket, p])).rows[0]; } catch { /* sin permiso */ }
        if (!ok) { out.push({ error: "Either the object does not exist or you do not have access to it", path: p, signedURL: null }); continue; }
        const t = randomUUID();
        firmas.set(t, `${bucket}/${p}`);
        out.push({ error: null, path: p, signedURL: `/object/sign/${bucket}/${p}?token=${t}` });
      }
      return enviar(res, 200, out);
    }
    if (modo === "sign/" && req.method === "POST") {
      if (!(await leerFila(q.quien))) throw errorSt(404, "not_found", "Object not found");
      const t = randomUUID();
      firmas.set(t, llave);
      return enviar(res, 200, { signedURL: `/object/sign/${bucket}/${nombre}?token=${t}` });
    }
    if (!modo && req.method === "GET") {
      if (!(await leerFila(q.quien)) || !archivos.has(llave)) throw errorSt(404, "not_found", "Object not found");
      return enviarArchivo(res, archivos.get(llave));
    }
    if (!modo && req.method === "POST") {
      const bk = (await db.query("select * from storage.buckets where id = $1", [bucket])).rows[0];
      if (!bk) throw errorSt(404, "Bucket not found", "Bucket not found");
      let bytes = cuerpoBuf, tipo = req.headers["content-type"] || "application/octet-stream";
      if (tipo.startsWith("multipart/form-data")) {
        const fd = await new Response(cuerpoBuf, { headers: { "content-type": tipo } }).formData();
        const archivo = [...fd.values()].find((v) => typeof v === "object");
        bytes = Buffer.from(await archivo.arrayBuffer());
        tipo = archivo.type || "application/octet-stream";
      }
      if (bk.file_size_limit && bytes.length > Number(bk.file_size_limit)) throw errorSt(413, "Payload too large", "The object exceeded the maximum allowed size");
      if (bk.allowed_mime_types && !bk.allowed_mime_types.includes(tipo.split(";")[0])) throw errorSt(415, "invalid_mime_type", `mime type ${tipo} is not supported`);
      try {
        await como(db, q.quien, "insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)",
          [bucket, nombre, q.quien.id || null]);
      } catch (e) {
        if (e.code === "23505") throw errorSt(409, "Duplicate", "The resource already exists");
        throw errorSt(403, "Unauthorized", e.message);
      }
      archivos.set(llave, { bytes, tipo });
      return enviar(res, 200, { Key: llave, Id: randomUUID() });
    }
    if (!modo && req.method === "DELETE") {
      const { prefixes = [] } = JSON.parse(cuerpoBuf.toString() || "{}");
      let borradas;
      try {
        borradas = (await como(db, q.quien, "delete from storage.objects where bucket_id = $1 and name = any($2::text[]) returning name", [bucket, prefixes])).rows;
      } catch (e) { throw errorSt(403, "Unauthorized", e.message); }
      for (const r of borradas) archivos.delete(`${bucket}/${r.name}`);
      return enviar(res, 200, borradas.map((r) => ({ name: r.name, bucket_id: bucket })));
    }
    throw errorSt(404, "not_found", "ruta de storage no soportada");
  }

  // ---------- sitio y API ----------
  const vj = JSON.parse(readFileSync(join(raiz, "vercel.json"), "utf8"));
  // JUMP está cerrado al público (vercel.json lo manda a /en-construccion/); las pruebas lo siguen viendo abierto.
  const redirects = vj.redirects.filter((r) => r.destination !== "/en-construccion/");
  const RUTAS = getTransformedRoutes({ redirects, headers: vj.headers }).routes;
  const handlers = {};
  const handler = async (nombre) => {
    if (!(nombre in handlers)) {
      const f = join(raiz, "api", nombre + ".js");
      handlers[nombre] = existsSync(f) ? (await import(pathToFileURL(f).href)).default : null;
    }
    return handlers[nombre];
  };

  const enviar = (res, status, cuerpo) => {
    res.statusCode = status;
    if (cuerpo === null || cuerpo === undefined) return res.end();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(cuerpo));
  };
  const enviarArchivo = (res, a) => { res.setHeader("Content-Type", a.tipo); res.end(a.bytes); };

  const servidor = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origen);
      const trozos = [];
      for await (const c of req) trozos.push(c);
      const cuerpoBuf = Buffer.concat(trozos);
      const cuerpo = cuerpoBuf.toString("utf8");
      const p = url.pathname;

      if (p.startsWith("/supa/rest/v1/")) return await rest(req, res, p.slice(14), url, cuerpo);
      if (p.startsWith("/supa/auth/v1/")) return await auth(req, res, p.slice(14), url, cuerpo);
      if (p.startsWith("/supa/storage/v1/")) return await storage(req, res, p.slice(17), url, cuerpoBuf);

      // vercel.json: redirecciones (con has/missing de User-Agent) y cabeceras
      const ua = req.headers["user-agent"];
      for (const r of RUTAS) {
        if (!new RegExp(r.src).test(p)) continue;
        if (r.status) {
          const hasOk = !r.has || r.has.every((h) => h.key === "user-agent" && ua !== undefined && new RegExp("^" + h.value + "$").test(ua));
          const missOk = !r.missing || r.missing.every((h) => h.key === "user-agent" && ua === undefined);
          if (hasOk && missOk) { res.statusCode = r.status; res.setHeader("location", r.headers.Location); return res.end(); }
        } else if (r.headers) for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
      }
      if (p.startsWith("/api/jump-")) {
        const h = await handler(p.slice(5));
        if (!h) return enviar(res, 404, { error: "no existe" });
        const r = new Request(origen + req.url, {
          method: req.method,
          headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === "string")),
          body: ["GET", "HEAD"].includes(req.method) ? undefined : cuerpoBuf,
        });
        const out = await h(r);
        res.statusCode = out.status;
        out.headers.forEach((v, k) => res.setHeader(k, v));
        return res.end(Buffer.from(await out.arrayBuffer()));
      }
      let f = join(raiz, decodeURIComponent(p.endsWith("/") ? p + "index.html" : p));
      if (!f.startsWith(raiz) || !existsSync(f) || statSync(f).isDirectory()) { res.statusCode = 404; return res.end("no"); }
      res.setHeader("Content-Type", MIME[extname(f)] || "application/octet-stream");
      res.end(readFileSync(f));
    } catch (e) {
      if (e instanceof ErrorHttp) return enviar(res, e.status, e.cuerpo);
      console.error("[sim]", e);
      enviar(res, 500, { message: String(e.message || e) });
    }
  });

  await new Promise((ok) => servidor.listen(puerto, "127.0.0.1", ok));
  origen = `http://127.0.0.1:${servidor.address().port}`;

  // Entorno de las funciones /api/jump-* y Zoom falso en el fetch global.
  Object.assign(process.env, {
    JUMP_SUPABASE_URL: origen + "/supa", JUMP_SUPABASE_ANON_KEY: "anon", JUMP_SUPABASE_SERVICE_ROLE_KEY: "service",
    JUMP_SECRET: "s".repeat(48), JUMP_PUBLIC_URL: origen,
    ZOOM_CLIENT_ID: "zoom-id", ZOOM_CLIENT_SECRET: "zoom-secreto", ZOOM_WEBHOOK_SECRET: "zoom-webhook",
  });
  const fetchReal = globalThis.fetch;
  globalThis.fetch = (u, init) => {
    const h = new URL(typeof u === "string" ? u : u.url).host;
    return h === "zoom.us" || h === "api.zoom.us" ? zoomFalso.atender(u, init) : fetchReal(u, init);
  };

  return {
    url: origen, db, zoomFalso, archivos,
    crearUsuario: async ({ email, password }) =>
      (await db.query("insert into auth.users (email, encrypted_password) values ($1, $2) returning id", [email, password])).rows[0].id,
    banear: (id) => db.query("update auth.users set banned_until = now() + interval '100 years' where id = $1", [id]),
    cerrar: () => new Promise((ok) => { globalThis.fetch = fetchReal; servidor.close(ok); servidor.closeAllConnections?.(); }),
  };
}

// Zoom falso: OAuth (token, refresh, revoke), /users/me y crear reuniones. Guarda cada pedido.
function crearZoomFalso() {
  const z = {
    pedidos: [], revocados: [], vigentes: new Map(), usuario: { id: "zu-1", email: "jump@zoom.test", first_name: "Cuenta", last_name: "JUMP" },
    fallar: null, n: 0,
    async atender(u, init = {}) {
      const url = new URL(typeof u === "string" ? u : u.url);
      const cuerpo = typeof init.body === "string" ? init.body : init.body ? new TextDecoder().decode(init.body) : "";
      z.pedidos.push({ url: url.href, metodo: init.method || "GET", cuerpo, headers: init.headers });
      const r = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
      if (z.fallar && url.pathname.includes(z.fallar)) return r({ reason: "falla forzada" }, 500);
      if (url.host === "zoom.us" && url.pathname === "/oauth/token") {
        const f = new URLSearchParams(cuerpo || url.search);
        const g = f.get("grant_type");
        if (g === "authorization_code" && !f.get("code")) return r({ reason: "sin code" }, 400);
        if (g === "refresh_token" && !z.vigentes.has(f.get("refresh_token"))) return r({ reason: "Invalid Token!" }, 400);
        if (g === "refresh_token") z.vigentes.delete(f.get("refresh_token"));
        z.n++;
        const access = `za-${z.n}`, refresh = `zr-${z.n}`;
        z.vigentes.set(refresh, true);
        z.vigentes.set(access, Date.now() + 3600e3);
        return r({ access_token: access, refresh_token: refresh, expires_in: 3600, token_type: "bearer" });
      }
      if (url.host === "zoom.us" && url.pathname === "/oauth/revoke") {
        z.revocados.push(url.searchParams.get("token") || new URLSearchParams(cuerpo).get("token"));
        return r({ status: "success" });
      }
      const bearer = String((init.headers || {}).Authorization || (init.headers || {}).authorization || "").slice(7);
      if (!(z.vigentes.get(bearer) > Date.now())) return r({ code: 124, message: "Invalid access token." }, 401);
      if (url.host === "api.zoom.us" && url.pathname === "/v2/users/me") return r(z.usuario);
      if (url.host === "api.zoom.us" && url.pathname === "/v2/users/me/meetings" && init.method === "POST") {
        const id = 80000000000 + z.pedidos.length;
        return r({ id, join_url: `https://us06web.zoom.us/j/${id}?pwd=abc`, password: "abc123" }, 201);
      }
      return r({ message: "no soportado" }, 404);
    },
    vencerAccesos() { for (const [k] of z.vigentes) if (k.startsWith("za-")) z.vigentes.set(k, 0); },
  };
  return z;
}

export const huellaArchivo = (bytes) => createHash("sha256").update(bytes).digest("hex");
