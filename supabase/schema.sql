-- ============================================================
-- Multimedia Club — Supabase schema (v1)
-- Run this once in your project's SQL Editor (Supabase Dashboard
-- → SQL Editor → New query → paste all of this → Run).
-- Safe to re-run on a fresh project; it will error if objects
-- already exist, which just means it's already been applied.
-- ============================================================

-- ---------- extensions ----------
create extension if not exists "pgcrypto";

-- ============================================================
-- PROFILES  (1:1 with auth.users — Supabase Auth owns the actual
-- login credentials; this table holds everything app-specific)
-- ============================================================
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  name          text not null,
  email         text not null,
  account_type  text not null default 'member' check (account_type in ('member','administrator')),
  club_role     text check (club_role in ('Editor','Photographer') or club_role is null),
  officer       text,
  suspended     boolean not null default false,
  avatar_url    text,
  created_at    timestamptz not null default now(),
  last_active   timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- security-definer helper so RLS policies can check "is this caller
-- an admin" without recursive-policy issues
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and account_type = 'administrator' and suspended = false
  );
$$;

create policy "profiles_select_authenticated"
  on public.profiles for select
  using (auth.role() = 'authenticated');

create policy "profiles_update_self_or_admin"
  on public.profiles for update
  using (auth.uid() = id or public.is_admin())
  with check (auth.uid() = id or public.is_admin());

-- profiles are created automatically by the trigger below, never
-- directly by clients, so no insert policy for normal users
create policy "profiles_insert_admin_only"
  on public.profiles for insert
  with check (public.is_admin());

create policy "profiles_delete_admin_only"
  on public.profiles for delete
  using (public.is_admin());

-- ---- trigger: create a profile row whenever someone signs up ----
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
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---- trigger: only admins may change account_type / club_role /
-- officer / suspended — prevents a member from self-promoting via
-- a direct API call even if they know the table shape ----
create or replace function public.protect_privileged_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    if new.account_type is distinct from old.account_type
       or new.club_role   is distinct from old.club_role
       or new.officer     is distinct from old.officer
       or new.suspended   is distinct from old.suspended then
      raise exception 'Only administrators can change account type, club role, officer position, or suspension status';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_protect_privileged_fields
  before update on public.profiles
  for each row execute function public.protect_privileged_fields();

-- ---- trigger: hard cap of 2 active administrator accounts ----
create or replace function public.enforce_admin_seat_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.account_type = 'administrator'
     and (old.account_type is distinct from 'administrator')
     and new.suspended = false then
    if (select count(*) from public.profiles
        where account_type = 'administrator' and suspended = false) >= 2 then
      raise exception 'Administrator seat limit (2) reached';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_admin_seat_limit
  before update on public.profiles
  for each row execute function public.enforce_admin_seat_limit();

-- ============================================================
-- ANNOUNCEMENTS
-- ============================================================
create table public.announcements (
  id          bigint generated always as identity primary key,
  title       text not null,
  body        text not null,
  category    text not null check (category in ('academics','sports','arts','general')),
  pinned      boolean not null default false,
  author      text not null,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
alter table public.announcements enable row level security;
create policy "announcements_select_all" on public.announcements for select using (true);
create policy "announcements_write_admin" on public.announcements for insert with check (public.is_admin());
create policy "announcements_update_admin" on public.announcements for update using (public.is_admin());
create policy "announcements_delete_admin" on public.announcements for delete using (public.is_admin());

-- ============================================================
-- EVENTS
-- ============================================================
create table public.events (
  id          bigint generated always as identity primary key,
  title       text not null,
  event_date  timestamptz not null,
  category    text not null check (category in ('academics','sports','arts','general')),
  location    text not null,
  description text,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
alter table public.events enable row level security;
create policy "events_select_all" on public.events for select using (true);
create policy "events_write_admin" on public.events for insert with check (public.is_admin());
create policy "events_update_admin" on public.events for update using (public.is_admin());
create policy "events_delete_admin" on public.events for delete using (public.is_admin());

-- ============================================================
-- NEWS
-- ============================================================
create table public.news (
  id          bigint generated always as identity primary key,
  title       text not null,
  category    text not null,
  icon        text default '📰',
  body        text not null,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
alter table public.news enable row level security;
create policy "news_select_all" on public.news for select using (true);
create policy "news_write_admin" on public.news for insert with check (public.is_admin());
create policy "news_update_admin" on public.news for update using (public.is_admin());
create policy "news_delete_admin" on public.news for delete using (public.is_admin());

-- ============================================================
-- SAVED ANNOUNCEMENTS  (per-member bookmarks)
-- ============================================================
create table public.saved_announcements (
  user_id         uuid references public.profiles(id) on delete cascade,
  announcement_id bigint references public.announcements(id) on delete cascade,
  saved_at        timestamptz not null default now(),
  primary key (user_id, announcement_id)
);
alter table public.saved_announcements enable row level security;
create policy "saved_select_own" on public.saved_announcements for select using (auth.uid() = user_id);
create policy "saved_insert_own" on public.saved_announcements for insert with check (auth.uid() = user_id);
create policy "saved_delete_own" on public.saved_announcements for delete using (auth.uid() = user_id);

-- ============================================================
-- LOGIN EVENTS  (successful logins only — see README for why
-- failed-attempt logging is handled client-side in v1)
-- ============================================================
create table public.login_events (
  id          bigint generated always as identity primary key,
  user_id     uuid references public.profiles(id) on delete cascade,
  device      text,
  created_at  timestamptz not null default now()
);
alter table public.login_events enable row level security;
create policy "login_events_insert_own" on public.login_events for insert with check (auth.uid() = user_id);
create policy "login_events_select_admin_or_own" on public.login_events for select
  using (public.is_admin() or auth.uid() = user_id);

-- ============================================================
-- AUDIT LOG  (admin actions: promote, demote, suspend, delete, etc.)
-- ============================================================
create table public.audit_log (
  id          bigint generated always as identity primary key,
  actor_id    uuid references public.profiles(id),
  action      text not null,
  target_id   uuid,
  detail      text,
  created_at  timestamptz not null default now()
);
alter table public.audit_log enable row level security;
create policy "audit_insert_admin" on public.audit_log for insert with check (public.is_admin());
create policy "audit_select_admin" on public.audit_log for select using (public.is_admin());

-- ============================================================
-- PAGE VIEWS  (lightweight real visit counter — one row per load)
-- ============================================================
create table public.page_views (
  id          bigint generated always as identity primary key,
  viewed_at   timestamptz not null default now()
);
alter table public.page_views enable row level security;
create policy "page_views_insert_anyone" on public.page_views for insert with check (true);
create policy "page_views_select_admin" on public.page_views for select using (public.is_admin());

-- ============================================================
-- REALTIME — let the frontend subscribe to live changes
-- ============================================================
alter publication supabase_realtime add table public.announcements;
alter publication supabase_realtime add table public.events;
alter publication supabase_realtime add table public.news;
alter publication supabase_realtime add table public.profiles;

-- ============================================================
-- SEED DATA (safe to delete/edit later from the admin dashboard)
-- ============================================================
insert into public.announcements (title, body, category, pinned, author) values
('Midterm schedule released', 'The midterm exam schedule for all grade levels is now posted on the academics portal. Please check your block assignments and arrive 10 minutes early.', 'academics', true, 'Registrar''s Office'),
('Varsity soccer advances to finals', 'Congratulations to the varsity soccer team on a decisive 3-1 win. The championship match is set for next Friday at the home stadium.', 'sports', true, 'Athletics Dept.'),
('Spring art exhibition opens Monday', 'Student artwork from this semester''s studio classes will be on display in the main gallery starting Monday. All are welcome.', 'arts', false, 'Arts Dept.'),
('Cafeteria menu update', 'A refreshed weekly menu with more plant-based options begins next week. Nutrition info will be posted at each station.', 'general', false, 'Facilities'),
('Library extended hours during exams', 'The library will stay open until 9pm on weekdays for the two weeks surrounding final exams, with quiet study rooms bookable online.', 'academics', false, 'Library'),
('Robotics club wins regional award', 'The robotics team placed first at the regional showcase and will represent the school at nationals this fall.', 'general', false, 'STEM Dept.');

insert into public.events (title, event_date, category, location, description) values
('Soccer Championship Final', now() + interval '3 days', 'sports', 'Home Stadium', 'Varsity soccer takes on Eastview High.'),
('Spring Art Exhibition Opening', now() + interval '1 day', 'arts', 'Main Gallery', 'Opening night reception with student artists.'),
('Midterm Exams Begin', now() + interval '6 days', 'academics', 'All Buildings', 'Check your block schedule on the portal.'),
('Robotics Nationals Send-off', now() + interval '10 days', 'general', 'Auditorium', 'Pep rally send-off for the robotics team.'),
('Fall Course Registration Opens', now() + interval '14 days', 'academics', 'Online Portal', 'Registration opens for returning students.');

insert into public.news (title, category, icon, body) values
('Robotics team heads to nationals', 'STEM', '🤖', 'After a first-place regional finish, the team is fundraising for the trip to nationals this fall.'),
('New makerspace opens in the library wing', 'Campus', '🛠️', '3D printers, laser cutters, and a recording booth are now open for student use during free periods.'),
('Alumni spotlight: from student council to city council', 'Alumni', '🏛️', 'A 2016 graduate reflects on the debate club habits that shaped a career in public service.'),
('Music department announces spring showcase lineup', 'Arts', '🎵', 'Twelve student ensembles will perform, including two new original compositions.');

-- ============================================================
-- FIRST ADMINISTRATOR
-- ============================================================
-- New sign-ups always start as 'member' (see handle_new_user above).
-- To create your first administrator:
--   1. Sign up normally through the site with the account you want
--      to be an admin.
--   2. Come back here and run, with that account's real email:
--
--   update public.profiles set account_type = 'administrator'
--   where email = 'you@example.com';
--
-- After that, use the Admin dashboard on the site (or Solis, if
-- you're logged in as that admin) to promote a second admin — the
-- 2-seat cap is enforced by the trigger above either way.
