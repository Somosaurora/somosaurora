# SECURITY — Somos Aurora

Clasificación de riesgo LOAN-IX: **HIGH** (formulario público + panel admin + fotos + RLS + secretos). Última revisión: 2026-10-15.

## Clasificación de datos
- **PII baja/media:** nombre y celular son **opcionales**. El sitio pide explícitamente no incluir datos de terceros. El nombre real **no** se muestra en público.
- Sin datos financieros, de pago ni credenciales de usuarios finales.
- Consentimiento explícito por envío: `consentimiento = true` + `consent_version` (versión de la política aceptada) + `consent_at` (hora del servidor). Migración 0004. Los envíos anteriores quedan con esos dos campos vacíos.
- Las fotos se reducen en el navegador antes de enviarse (≤ 1600 px, JPEG), lo que además quita los datos de ubicación (EXIF) de los celulares.
- Retención: 30 días, automática (`/api/purge`, ver README), salvo opiniones marcadas "En gestión".

## Autenticación y autorización
- **Admin:** Supabase Auth (email+password). **Signup público deshabilitado** (confirmado por el dueño) — admins creados a mano. Solo los correos de `public.admins` pasan `is_admin()` (migración 0002).
- **RLS activado en todas las tablas:**
  - `submissions`: sin acceso para `anon`. Solo admins (`is_admin()`). Inserción solo vía service role (Function).
  - `featured_opinions` / `weekly_reports`: `SELECT` público (anon); escritura solo admins.
  - `purga_log`: lectura solo admins.
- La `service_role key` vive **solo** en variables de entorno de Vercel; nunca en el navegador ni en el repo.

## Entrada y anti-abuso (`/api/submit`)
En orden, antes de tocar la base de datos:
1. **Mismo origen** (`Origin` = el propio sitio) y cuerpo ≤ 4,4 MB (Vercel rechaza > 4,5 MB).
2. **Prueba de trabajo** (estilo ALTCHA, sin terceros): `GET /api/submit` entrega un desafío firmado con HMAC y ligado al hash de IP; el navegador lo resuelve al abrir el formulario y lo manda en `X-Aurora-Pow`. Caduca a los 15 min y no se acepta antes de 4 s. La firma usa `IP_SALT` (≥ 16 caracteres; si falta, la prueba se desactiva y el formulario sigue funcionando).
3. **Límites por conexión (hash de IP)**: 5 envíos / 10 min y 30 / día; **tope global** 400 / hora. Los límites son holgados a propósito (varias personas comparten una misma IP móvil).
4. **Honeypot** (`bot-field`), **listas permitidas** de tipo, tema y sector, largos máximos, celular con formato.
5. **Fotos**: ≤ 4 MB; el formato se verifica por el contenido real (JPG, PNG, WEBP, GIF, HEIC), no por el tipo que declare el navegador; se guarda con tipo y extensión deducidos. Si el insert falla, la foto subida se borra.
6. Respuestas de error genéricas: nunca se devuelve detalle interno de la base de datos.

Límites del diseño (honestos): la prueba de trabajo frena scripts, no a una persona decidida con tiempo. Para eso existe el siguiente nivel: **Cloudflare Turnstile** (gratis; implica un tercero y habría que nombrarlo en la política de datos).

## Navegador y cabeceras (`vercel.json`)
- **CSP con hashes** para los `<script>` en línea (sin `unsafe-inline` en scripts), `connect-src` restringido (público: solo el propio sitio; admin: solo el proyecto Supabase), `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`.
- **Mantenimiento obligatorio:** al editar un `<script>` en línea de cualquier página hay que correr `node scripts/csp.mjs` (recalcula los hashes). Si se olvida, el navegador bloquea ese script. `node scripts/csp.mjs --check` verifica sin modificar.
- HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP `same-origin`.
- El panel carga `supabase-js` con **SRI** (hash fijo): si el CDN sirviera otro archivo, el navegador no lo ejecuta.
- Sin recursos de terceros en la página pública salvo Google Fonts (se quitó una imagen enlazada desde un portal inmobiliario).
- El panel escapa todo texto que viene del público y el CSV exportado neutraliza fórmulas de Excel (`= + - @`).

## Anti-scraping / anti-bots
Capas (ninguna es infalible; juntas suben mucho el costo):
1. `robots.txt` (solo detiene a quien lo respeta) y cabecera `X-Robots-Tag: noai, noimageai`.
2. **Bloqueo por User-Agent** en `vercel.json` → `/api/blocked` (403): rastreadores de IA (GPTBot, ClaudeBot, PerplexityBot, CCBot, Bytespider, FirecrawlAgent…), bibliotecas HTTP genéricas (curl, python-requests, Go-http-client, axios…), navegadores sin interfaz y peticiones sin User-Agent. Googlebot/Bing y las vistas previas de WhatsApp/Facebook siguen permitidos. `/api/purge` está exento (lo protege su secreto).
3. **Vercel Firewall (panel de Vercel, lo configura el dueño)**: Bot Protection, AI Bots y una regla de rate limit sobre `/api/submit`. Un bot que falsifique su User-Agent solo se frena aquí.
4. Lo que se publica en la web es público por diseño; lo privado (opiniones, nombres, celulares, fotos) nunca sale del panel autenticado.

## Storage
- Bucket `evidencias` **privado**. Subidas solo vía service role. Las fotos no se exponen públicamente; el admin las abre con URL firmada de 120 s.
- Al purgar (manual o automática) se borran también los objetos de Storage de esos envíos.

## Operación sensible: purga
- Manual ("Archivar y limpiar"): destructiva, exige escribir `BORRAR`; respeta las opiniones "En gestión".
- Automática (`/api/purge`): exige `Authorization: Bearer CRON_SECRET`, falla cerrado sin secreto, fotos primero, tope de 1000 por ejecución. `weekly_reports` y `featured_opinions` nunca se tocan.

## Secretos
- `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `IP_SALT` → solo variables de entorno de Vercel.
- `SUPABASE_ANON_KEY`, `SUPABASE_URL` → públicos por diseño (los entrega `/api/config` al panel).
- Nada de claves en el repositorio. `.gitignore` cubre `.env*` (salvo `.env.example`).

## Pendiente / riesgos aceptados
- Turnstile (o equivalente) si el spam supera a las capas actuales.
- CAPTCHA en el inicio de sesión del panel (Supabase Auth → Attack Protection) si se detectan intentos de fuerza bruta; hoy lo limita Supabase por IP.
- La prueba de trabajo no es de un solo uso (se acota con el límite por conexión).
