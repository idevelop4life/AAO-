# Angela Agunwami Onwuka — Personal Website

Personal site with a private admin. Black and gold, plain HTML/JS, hosted on Vercel, with Supabase for logins, content, photos, replies and subscribers.

## Files

| Path | What it is |
|---|---|
| `index.html` + `site.js` | The public website |
| `admin/` | The admin app at **/admin** |
| `config.js` | Supabase Project URL + anon key (public by design) |
| `setup.sql` | Creates the database tables, roles and security rules. Run once. |
| `images/` | Starting photos. New uploads go to Supabase storage. |

## Roles

| Role | Can do |
|---|---|
| **Super admin** | Everything, plus approve people and change anyone's role under *Users & access* |
| **Admin** | Edit all website content and photos, manage replies and subscribers |
| **No access** | Signed up but waiting for approval; can't change anything |

- The **first account ever created** becomes super admin automatically.
- Everyone after that starts with no access until a super admin approves them.
- There must always be at least one super admin; the database blocks removing the last one.
- Permissions are enforced by the database (row level security), not just the page, so they can't be bypassed from the browser.

## One-time setup

1. Create a Supabase project.
2. In Supabase, open **SQL Editor → New query**, paste all of `setup.sql`, click **Run**.
3. In **Authentication → URL Configuration**, set **Site URL** to the live site (e.g. `https://yoursite.vercel.app`) and add `https://yoursite.vercel.app/admin/` under **Redirect URLs**.
4. Put the Project URL and anon/publishable key in `config.js`. Never put the service_role / secret key in this repo.
5. Go to **/admin**, click **Request access**, and create the first account. It becomes super admin.

## Editing

Sign in at **/admin**. Changes preview in the form; click **Save & publish** and the live site shows them immediately (no redeploy needed). Wrap a word in `*asterisks*` to make it gold.

`index.html` also carries a copy of the content, used only if the database can't be reached.
