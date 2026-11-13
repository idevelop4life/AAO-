# Angela Agunwami Onwuka — Personal Website

Personal site with a private admin. Black and gold, plain HTML/JS, hosted on Vercel, with Firebase (free Spark plan) for logins, content, photos, replies and subscribers.

## Files

| Path | What it is |
|---|---|
| `index.html` + `site.js` | The public website |
| `admin/` | The admin app at **/admin** |
| `config.js` | Firebase web config (public by design) |
| `firestore.rules` | Security rules: who can read and change what. Paste into Firebase once. |
| `images/` | Starting photos. New uploads are compressed and stored in Firestore. |

## Roles

| Role | Can do |
|---|---|
| **Super admin** | Everything, plus approve people and change anyone's role under *Users & access* |
| **Admin** | Edit all website content and photos, manage replies and subscribers |
| **No access** | Signed up but waiting for approval; can't change anything |

- The **first account ever created** becomes super admin automatically.
- Everyone after that starts with no access until a super admin approves them.
- Nobody can change their own role, so there is always at least one super admin.
- Permissions are enforced by Firestore security rules, not just the page, so they can't be bypassed from the browser.

## One-time setup

1. Create a Firebase project (Analytics off).
2. **Authentication → Get started → Email/Password → Enable.**
3. **Firestore Database → Create database** (production mode).
4. **Firestore → Rules:** paste all of `firestore.rules`, click **Publish**.
5. **Project settings → Your apps → Web (</>)**: register the app and copy the config values into `config.js`.
6. **Authentication → Settings → Authorized domains:** add the Vercel domain.
7. Go to **/admin**, click **Request access**, and create the first account. It becomes super admin, and the starting content is copied into the database automatically.

## Editing

Sign in at **/admin**. Changes preview in the form; click **Save & publish** and the live site shows them immediately (no redeploy needed). Wrap a word in `*asterisks*` to make it gold.

`index.html` also carries a copy of the content, used only if the database can't be reached.
