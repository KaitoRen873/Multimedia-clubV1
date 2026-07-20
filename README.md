# MSHS Multimedia Club — Join Portal

A recruitment site for the MSHS Multimedia Club. Registering here **creates a real
Supabase Auth account** in the **same Supabase project as your main club website** —
so it isn't a copy or a sync, it's literally the same account and the same `profiles`
row. Once someone registers here, they can log in on the main site immediately with
the same email and password, and they'll show up in the main site's member list.

It also includes an **admin dashboard** (`admin.html`) for officers to review and
manage applications, using the exact same "administrator" check as your main site.

## ⚠️ Before anything else: point this at your MAIN site's project

This only works if `index.html` and `admin.html` here use the **exact same**
`SUPABASE_URL` and `SUPABASE_ANON_KEY` as your main club website's `config.js`.
Right now, check both:

- This project's `index.html` / `admin.html`
- Your main site's `config.js`

If the URLs (the `https://xxxxx.supabase.co` part) don't match, these are two
different databases and nothing here will appear on your main site no matter what
else is configured correctly. Copy your main site's real values into both
`index.html` and `admin.html` here, replacing whatever is currently there.

## Files

- `index.html` — the public recruitment site + registration form.
- `admin.html` — officer-only login and applications dashboard.
- `schema.sql` — adds the `applications` table to your **existing** main-site
  database. It does *not* recreate `profiles` or its triggers — those already exist
  from your main site's own schema.sql, and this file is written to build on top of
  them rather than conflict with them.
- `netlify.toml` — optional deployment config for Netlify (safe to ignore/delete if
  you're using GitHub Pages or another host).

## 1. Set up Supabase

1. Confirm you're using the **same Supabase project** as your main club website (see
   the warning above — this is the part that actually makes accounts "permanent" on
   both sites, since they're the same database).
2. Open the **SQL Editor** and run all of `schema.sql`. It starts with a safety check
   that stops immediately with a clear error if `public.profiles` or
   `public.is_admin()` don't exist yet — that means you're not pointed at the right
   project, or haven't run your main site's own schema.sql there. Fix that first.
3. If you ever previously ran an older version of this file against your main site's
   project, that old version could have overwritten your main site's user-creation
   trigger with an incompatible one. The last block in the current `schema.sql`
   restores the correct version regardless — it's safe to run even if you never had
   the problem.
4. In **Authentication → Providers**, make sure **Email** sign-up is enabled. Under
   **Authentication → Settings**, decide whether "Confirm email" is on — if it's on,
   new members must click a confirmation link before they can log in (the form
   already tells them this when it applies).
5. Go to **Project Settings → API** and copy your **Project URL** and **anon public
   key** — these are the values to paste into both HTML files (see the warning
   above).

## 2. Connect both pages to Supabase

In **both** `index.html` and `admin.html`, find:

```js
const SUPABASE_URL = "...";
const SUPABASE_ANON_KEY = "...";
```

and make sure both files have **the same values as your main site's `config.js`** —
not just the same as each other.

## 3. Point registration at your main site's login page

In `index.html`, find:

```js
const MAIN_SITE_LOGIN_URL = "https://your-main-club-website.example.com/login";
```

and set it to your main website's actual URL — since your main site's login is a
hidden keyboard sequence rather than a page, this can just point at your main site's
homepage; members will use the sequence once they're there.

## 4. Create your first admin (if you haven't already)

New accounts default to `account_type = 'member'` (set by your main site's own
trigger — this project doesn't touch that). To make an account an admin, this is the
same step you'd already do on your main site:

```sql
update public.profiles set account_type = 'administrator'
where email = 'your-email@example.com';
```

Do this from the SQL editor only — never expose a way for the public site to grant
itself admin access. The 2-administrator seat limit from your main site's schema
still applies here too, since it's the same trigger enforcing it.

## 5. Run it locally

No build step needed — both pages are static files. Open `index.html` or `admin.html`
directly in a browser, or serve the folder with:

```bash
npx serve .
```

## 6. Deploy

**GitHub Pages:** push this folder to a repo, then in **Settings → Pages** set the
source to your branch/folder. You'll get a URL like
`https://yourusername.github.io/your-repo-name/` — `admin.html` will be reachable at
`.../admin.html`. (`netlify.toml` isn't used here — you can leave or delete it.)

**Netlify:** drag the folder into [app.netlify.com/drop](https://app.netlify.com/drop),
or connect a Git repo. `netlify.toml` is already configured for a no-build static
deploy.

> `admin.html` isn't linked from the public navigation, but it isn't secret either —
> anyone can find the URL. That's fine: the real protection is the Supabase login +
> admin role check, not the URL being hidden.

## How it fits together

- **Join Portal (`index.html`)** — public. Registering calls `supabase.auth.signUp()`
  to create the member's login (with `name` set in the metadata, which your main
  site's trigger reads to fill in the member's display name), then inserts a row into
  `applications` linked to that account. No admin powers here.
- **Main club website** — the same Supabase project. The account created here *is*
  a real row in that same `profiles` table the moment it's created — there's no sync
  step, no export/import, no delay. The member can use the hidden login sequence on
  the main site right away (once they've confirmed their email, if that's enabled).
- **Admin Dashboard (`admin.html`)** — officers sign in, the page checks
  `profiles.account_type === 'administrator'` (and that they're not suspended) —
  the exact same check your main site uses — and only admins get past the login
  screen. From there they can search, filter (by status/specialty/grade), update an
  application's status (Pending/Reviewed/Approved/Declined), or delete an entry.
  Deleting an application never deletes the member's actual account — those are
  independent.
