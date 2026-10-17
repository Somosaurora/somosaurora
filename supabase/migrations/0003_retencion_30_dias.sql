-- 0003_retencion_30_dias.sql — Somos Aurora
-- Limpieza automática: las opiniones (y sus fotos) se borran a los 30 días de
-- recibidas, salvo las marcadas "en gestión" ante una institución pública.
-- Así se cumple la Política de tratamiento de datos personales (punto 6).
--
-- Cómo aplicarla: Supabase → SQL Editor → pegar todo → Run.
-- Requiere haber aplicado antes la 0002 (usa public.is_admin()).
-- Después hay que configurar CRON_SECRET en Vercel (ver README, sección "Limpieza automática").

-- ============================================================
-- 1. MARCA "EN GESTIÓN" (excepción del punto 6 de la política)
-- ============================================================
alter table public.submissions
  add column if not exists en_gestion       boolean     not null default false,
  add column if not exists en_gestion_desde timestamptz;

-- Acelera la búsqueda diaria de lo que ya venció.
create index if not exists submissions_retencion_idx
  on public.submissions (created_at) where en_gestion = false;

-- ============================================================
-- 2. BITÁCORA DE LIMPIEZAS (solo conteos, sin datos personales)
-- ============================================================
create table if not exists public.purga_log (
  id           bigint generated always as identity primary key,
  ejecutada_en timestamptz not null default now(),
  opiniones    integer     not null default 0,
  fotos        integer     not null default 0,
  error        text
);
alter table public.purga_log enable row level security;

-- Solo los admins la leen desde el panel. La función de limpieza escribe con
-- service_role, que ignora RLS; nadie más puede insertar ni editar.
drop policy if exists purga_log_admin_read on public.purga_log;
create policy purga_log_admin_read on public.purga_log
  for select to authenticated using (public.is_admin());
