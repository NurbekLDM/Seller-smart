# Smart Retail ERP — Vercel + Supabase deployment

Production architecture:

- **Vercel** serves the app (`public/`) and runs `middleware.js`, which blocks
  the app page server-side unless the visitor has a valid Supabase session.
- **Supabase** holds the users (Supabase Auth) and the shared database
  (`supabase/schema.sql`). All devices read/write one versioned snapshot, so
  everyone works with the same data. Permissions are enforced by the database
  (Row Level Security), not by hidden buttons.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/app.html` | Source of truth — the original customer HTML. Never edited by hand for auth/sync. |
| `scripts/build.mjs` | Builds `public/index.html` from the source (removes legacy VPS sync, injects Supabase auth + sync). Run with `npm run build`. |
| `public/index.html` | Built app (generated — do not edit directly). |
| `public/login.html` | Real login page (Supabase Auth, email + password). |
| `public/assets/app-config.js` | **Fill in** the Supabase URL + anon key here. |
| `public/assets/auth-guard.js` | In-page guard: redirects to login, keeps session cookie fresh. |
| `public/assets/supabase-sync.js` | Sync engine: shared snapshot with version-conflict protection. |
| `middleware.js` | Vercel Edge gate — validates the session cookie against Supabase before serving the app. |
| `supabase/schema.sql` | Database schema: profiles + roles, shared state, RLS policies. |

## Step 1 — Supabase (one time)

1. Create a project at supabase.com (choose a strong database password; region: closest to the customer, e.g. `eu-central-1`).
2. **SQL Editor → New query** → paste the whole `supabase/schema.sql` → Run.
3. **Authentication → Sign In / Providers**: make sure Email is enabled and
   **disable "Allow new users to sign up"** — only the owner creates accounts.
4. **Authentication → Users → Add user**: create the owner's account
   (email + password, check "Auto Confirm User").
5. Copy from **Project Settings → API**: the **Project URL** and the
   **anon / publishable key**.

Data model: **every user is a fully isolated private workspace** (ERP +
analytics, all features). No roles, no sharing — nobody, including other
users, can read or write someone else's data (enforced by Row Level
Security). Each workspace has its own automatic version history.
Deactivate a user without deleting their data:
`update public.profiles set active = false where id = '...';`

## Step 2 — configure the frontend

Put the two values from step 1.6 into `public/assets/app-config.js`.
(The anon key is safe in the browser — access is enforced by RLS.)
No rebuild needed for config changes; rebuild only if `src/app.html` changes:

```bash
npm run build
```

## Step 3 — Vercel

1. Push this repository to GitHub (private repo).
2. vercel.com → **Add New Project** → import the repo.
   Framework preset: **Other**. Build command: leave empty. Output directory
   is already set to `public` via `vercel.json`.
3. **Environment Variables** (Production):
   - `SUPABASE_URL` — the Project URL
   - `SUPABASE_ANON_KEY` — the anon/publishable key
   - `SUPABASE_SERVICE_ROLE_KEY` — the service_role / secret key
     (Supabase → Project Settings → API). Server-side only — powers the
     `/api/admin/users` function; never ship it to the browser.

Admin access is controlled by the `public.admins` table. Seed the first
admin once (SQL Editor, see the note at the end of `supabase/schema.sql`);
after that, admins grant/revoke admin from the `/admin` page itself.
4. Deploy. Optionally attach the customer's domain under **Settings → Domains**.

## Verify after deploy

- Opening the site logged-out must redirect to the login page (server-side).
- Log in as the owner → app loads, sync badge shows "Baza bilan ulangan · v…".
- Make a change on device A → reload on device B → the change is there.
- Two devices editing simultaneously: the slower one gets a conflict badge
  instead of silently overwriting ("Boshqa qurilmada o‘zgarish bor").

## Known items for the next phases

- **Admin dashboard (phase 3):** owner creates/deactivates users and assigns
  roles from a UI (today it's done in the Supabase dashboard). Will use a
  Vercel serverless function with the Supabase service-role key.
- The ERP's old **built-in login screen** still exists inside the app; a
  server-authenticated ADMIN bypasses it automatically (same as the previous
  server build). Unifying it for non-admin roles is part of phase 3.
- Advanced exports (real `.xlsx`, QR, PDF) load libraries from public CDNs,
  so the browser needs internet — same as before.
- The first save from the owner's browser uploads the current local data as
  snapshot v1; afterwards every device shares it.
