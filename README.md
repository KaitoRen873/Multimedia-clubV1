# Multimedia Club — v1 (Supabase-backed)

This is a real, working version of the site: real accounts via Supabase
Auth, a real Postgres database with row-level security, and live
updates via Supabase Realtime. No mock data, no in-memory arrays that
reset on refresh.

## What this includes

- **Auth is real.** Sign-up/sign-in go through Supabase Auth. Passwords
  are hashed and managed by Supabase, not by this code.
- **Data is real.** Announcements, events, news, member profiles,
  login history, and admin audit logs all live in Postgres tables
  defined in `supabase/schema.sql`.
- **Access control is enforced in the database**, not just hidden in
  the UI — Row Level Security policies and triggers block privilege
  escalation and enforce the 2-administrator seat cap even if someone
  bypasses the frontend entirely.
- **Two avatar images** are included as original SVG artwork:
  `assets/solis-avatar.svg` (the AI assistant) and
  `assets/club-logo.svg` (the club mark, also used as the favicon).

## Setup (about 10 minutes)

**Keep the whole folder together.** `index.html` on its own will not
work — it loads `config.js`, `js/app.js`, and the files in `assets/`
as separate files, exactly like any real website's assets. If you
only saved `index.html`, go back and grab the rest. As of this
version, if any of that fails to load, a red banner across the top
of the page will now tell you exactly what's missing instead of the
page silently doing nothing.

1. **Create a Supabase project** at [supabase.com](https://supabase.com)
   (free tier is enough for v1).
2. **Run the schema.** Dashboard → SQL Editor → New query → paste the
   entire contents of `supabase/schema.sql` → Run. This creates every
   table, security policy, trigger, and the seed announcements/events/
   news.
3. **Copy your API keys.** Dashboard → Settings → API. Copy the
   **Project URL** and the **anon public** key (never the
   `service_role` key — that one must never reach a browser).
4. **Paste them into `config.js`** at the project root.
5. **Serve the files.** Any static host works — this is still plain
   HTML/CSS/JS with no build step:
   - Quick local test: `npx serve .` (or any static server) from this
     folder, then open the printed URL.
   - Production: deploy the whole folder to Netlify, Vercel, Cloudflare
     Pages, or GitHub Pages, exactly like a static site.
6. **Create your first administrator.** New sign-ups always start as a
   `member` (enforced by a trigger). Sign up once through the site
   with the account you want to be an admin, then in the SQL Editor:
   ```sql
   update public.profiles set account_type = 'administrator'
   where email = 'you@example.com';
   ```
   From then on, promote a second admin from the Admin dashboard or
   through Solis — the 2-seat cap is enforced by the database either
   way.

## Hidden access

- `↑ ↑ ↑ ↓ → →` — opens the Member Portal (login/join)
- `↓ ↓ ← ← ↑` — opens the Administrator login
- `↓ ↓ ↓` — emergency fallback, also opens the Administrator login

These sequences only ever reveal a form. Every credential is still
checked by Supabase Auth, and every privileged action is still
re-checked by the database.

## Honest scope notes for v1

A few things worth knowing before you treat this as fully finished:

- **I could not test this against a live Supabase project.** This
  sandbox has no network access, so I wrote and syntax-checked the
  code carefully but have not run it end-to-end against a real
  database. Test the auth flow and admin actions yourself after setup,
  and open an issue in your own tracking if something doesn't line up
  — the code is straightforward enough to patch.
- **Member directory privacy.** The `profiles` table currently lets
  any logged-in member read every other member's row (needed for the
  admin panel and directory features). Emails and suspension status
  are technically visible to any member via a direct API call, even
  though the UI never displays that to non-admins. If that's too
  broad for your use case, replace the `profiles_select_authenticated`
  policy with a public view that excludes sensitive columns for
  non-admins.
- **Full account deletion needs one more step.** Browsers can never
  hold the `service_role` key, so the admin dashboard's "Delete"
  button removes a member's profile data and blocks their app access,
  but their underlying Supabase Auth login isn't destroyed until you
  either remove it from Authentication → Users in the dashboard, or
  deploy `supabase/functions/delete-user/index.ts` (included, and
  explained inline).
- **Failed login attempts aren't persisted.** Only successful logins
  are written to `login_events`, since logging a failed attempt would
  need an open insert policy usable by anyone, which is its own abuse
  surface. Client-side lockout after repeated failures is still in
  place as a UX layer; Supabase Auth also rate-limits at the API level.
- **Notifications are real but per-tab.** The bell fires from actual
  Realtime events (new announcements, new events, event reminders
  inside 24 hours, your own login, and role/officer changes made to
  your account) — they're just not stored in a table, so a fresh tab
  starts with an empty notification list rather than history. Everything
  else (announcements, events, news, members, logins, audit log, page
  views) is fully persisted in Postgres.

## File map

```
index.html                          the site
config.js                           your Supabase URL + anon key
js/app.js                           all application logic
assets/solis-avatar.svg             Solis avatar
assets/club-logo.svg                club logo / favicon
supabase/schema.sql                 run this once in SQL Editor
supabase/functions/delete-user/     optional edge function for full account deletion
```
