-- ============================================================
-- MSHS Multimedia Club — Member Recruitment schema
-- ============================================================
-- For: Member_Recruitment.html + admin.html
--
-- IMPORTANT: this only works if these two files use the SAME
-- Supabase project (same SUPABASE_URL / SUPABASE_ANON_KEY) as your
-- main club website. That's what makes an account created here a
-- real, permanent account there too — same auth.users row, same
-- profiles row, no sync step.
--
-- This file does NOT create `public.profiles`, `handle_new_user()`,
-- or the sign-up trigger — those already exist from your main
-- site's own schema.sql. Redefining them here would silently
-- overwrite your main site's user-creation logic with an
-- incompatible version. This file only adds what's actually new:
-- the `applications` table that Member_Recruitment.html writes to
-- and admin.html reads from.
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- Sanity check — run this first. If it errors, you are NOT pointed
-- at your main site's Supabase project yet. Fix that before
-- continuing (see the comment block below the error message).
-- ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema='public' and table_name='profiles') then
    raise exception 'public.profiles does not exist. Member_Recruitment.html and admin.html must point at the SAME Supabase project as your main club website — run the main site''s schema.sql there first, then update SUPABASE_URL/SUPABASE_ANON_KEY in both files here to match.';
  end if;
  if not exists (select 1 from pg_proc where proname='is_admin' and pronamespace = 'public'::regnamespace) then
    raise exception 'public.is_admin() does not exist. Same issue as above — these files are not pointed at your main site''s project.';
  end if;
end $$;

-- ============================================================
-- APPLICATIONS — membership applications submitted through
-- Member_Recruitment.html, reviewed in admin.html
-- ============================================================
create table if not exists public.applications (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid references public.profiles(id) on delete set null,
  full_name             text not null,
  student_id            text not null,
  grade_level           text not null,
  section               text not null,
  email                 text not null,
  contact_number        text,
  preferred_specialty   text not null,
  status                text not null default 'Pending',
  submitted_at          timestamptz not null default now()
);

alter table public.applications
  add constraint applications_status_check
  check (status in ('Pending', 'Reviewed', 'Approved', 'Declined'));

alter table public.applications
  add constraint applications_specialty_check
  check (preferred_specialty in (
    'Photographer',
    'Videographer',
    'Graphic Designer',
    'Video Editor',
    'Writer',
    'Social Media Manager',
    'Any / Willing to Learn'
  ));

alter table public.applications
  add constraint applications_email_check
  check (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$');

create index if not exists applications_submitted_at_idx
  on public.applications (submitted_at desc);

create index if not exists applications_status_idx
  on public.applications (status);

create index if not exists applications_specialty_idx
  on public.applications (preferred_specialty);

create index if not exists applications_user_id_idx
  on public.applications (user_id);

-- ============================================================
-- Row Level Security — applications
-- ============================================================
alter table public.applications enable row level security;

-- Anyone (signed up or not) can submit an application — the form
-- calls auth.signUp() first, then inserts here, but this stays open
-- to `anon` too so submissions never break on timing.
create policy "Anyone can submit an application"
  on public.applications
  for insert
  to anon, authenticated
  with check (true);

-- Only administrators — using your main site's own is_admin() helper,
-- so this always matches the exact same admin check as everywhere
-- else on the main site (including the 2-seat admin cap and the
-- "suspended admins don't count" rule) — can view applications.
create policy "Admins can view applications"
  on public.applications
  for select
  to authenticated
  using (public.is_admin());

-- Only admins can update applications (e.g. change status in admin.html).
create policy "Admins can update applications"
  on public.applications
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Only admins can delete applications.
create policy "Admins can delete applications"
  on public.applications
  for delete
  to authenticated
  using (public.is_admin());

-- No SELECT/UPDATE/DELETE policy exists for `anon`, and regular
-- `authenticated` members (account_type = 'member') aren't matched
-- by is_admin(), so members can submit but never read, edit, or
-- delete applications — only admins can.

alter publication supabase_realtime add table public.applications;

-- ------------------------------------------------------------
-- SAFETY NET — only matters if an older/different version of a
-- recruitment schema was ever run against this same project and
-- overwrote the sign-up trigger. Safe to run regardless; it just
-- re-applies the correct version your main site depends on.
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, email, account_type)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
    new.email,
    'member'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
