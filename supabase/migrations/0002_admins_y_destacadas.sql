-- 0002_admins_y_destacadas.sql — Somos Aurora
-- 1) Seguridad: solo los correos de la tabla `admins` pueden leer opiniones,
--    ver fotos y publicar en la web. Antes bastaba con tener sesión iniciada.
-- 2) Carrusel semanal: máximo 5 opiniones destacadas por semana.
--
-- Cómo aplicarla: Supabase → SQL Editor → pegar todo → Run.
-- ANTES de ejecutar, revisa el correo de la sección 4: debe ser el mismo con
-- el que entras al panel /admin/. Si no coincide, el panel quedará vacío.

-- ============================================================
-- 1. LISTA DE ADMINISTRADORES
-- ============================================================
create table if not exists public.admins (
  email      text primary key,
  created_at timestamptz not null default now()
);
-- RLS activo y sin políticas: nadie la lee ni la edita por la API pública.
-- Se administra solo desde el SQL Editor.
alter table public.admins enable row level security;

-- ¿El usuario de esta sesión es admin? (security definer para poder leer `admins`)
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admins a
    where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- ============================================================
-- 2. POLÍTICAS: de "cualquier sesión" a "solo admins"
-- ============================================================
drop policy if exists submissions_admin_all on public.submissions;
create policy submissions_admin_all on public.submissions
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists weekly_reports_admin_write on public.weekly_reports;
create policy weekly_reports_admin_write on public.weekly_reports
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists featured_admin_write on public.featured_opinions;
create policy featured_admin_write on public.featured_opinions
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists evidencias_admin_all on storage.objects;
create policy evidencias_admin_all on storage.objects
  for all to authenticated
  using (bucket_id = 'evidencias' and public.is_admin())
  with check (bucket_id = 'evidencias' and public.is_admin());

-- (La lectura pública de weekly_reports y featured_opinions no cambia.)

-- ============================================================
-- 3. CARRUSEL: máximo 5 destacadas por semana, sin posiciones repetidas
-- ============================================================
alter table public.featured_opinions drop constraint if exists featured_rank_1_5;
alter table public.featured_opinions
  add constraint featured_rank_1_5 check (rank between 1 and 5) not valid; -- no valida informes antiguos
create unique index if not exists featured_report_rank_uq
  on public.featured_opinions (report_id, rank);

-- ============================================================
-- 4. ADMINISTRADORES (EDITA AQUÍ)
-- ============================================================
-- Un insert por cada correo que deba entrar al panel.
insert into public.admins (email) values
  ('somosaurora.daule@gmail.com')
on conflict (email) do nothing;

-- ============================================================
-- 5. RECORDATORIO (en el panel de Supabase, no en SQL)
-- ============================================================
-- Authentication → Sign In / Providers → desactivar "Allow new users to sign up".
-- Con esta migración, aunque alguien se registre no verá ni publicará nada.
