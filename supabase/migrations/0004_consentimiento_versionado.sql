-- 0004_consentimiento_versionado.sql — Somos Aurora
-- Prueba del consentimiento: cada opinión guarda QUÉ versión de la Política de
-- tratamiento de datos personales se aceptó y la hora exacta (la pone el servidor,
-- no el navegador). Además agrega un índice para el límite de envíos por conexión.
--
-- Cómo aplicarla: Supabase → SQL Editor → pegar todo → Run. Se puede correr varias veces.
-- Las opiniones anteriores quedan con estos campos vacíos (no se inventa lo que no se guardó).

-- 1. VERSIÓN Y HORA DE ACEPTACIÓN
alter table public.submissions
  add column if not exists consent_version text,
  add column if not exists consent_at      timestamptz;

comment on column public.submissions.consent_version is
  'Versión de la política aceptada (fecha de "Última actualización" de politica-datos.html). La escribe api/submit.js.';
comment on column public.submissions.consent_at is
  'Momento exacto en que se recibió la aceptación (hora del servidor).';

-- 2. ANTI-ABUSO: api/submit.js cuenta los envíos recientes de cada conexión (ip_hash).
create index if not exists submissions_ip_recent_idx
  on public.submissions (ip_hash, created_at desc)
  where ip_hash is not null;
