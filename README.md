# Angela Agunwami Onwuka — Personal Website

Personal site with a private admin. Black and gold, plain HTML/JS, hosted on Vercel, with Firebase (free Spark plan) for logins, content, photos, replies and subscribers.

## Files

| Path | What it is |
|---|---|
| `index.html` + `site.js` | The public website |
| `admin/` | The admin app at **/admin** |
| `config.js` | Firebase web config (public by design) |
| `firestore.rules` | Database security rules: who can read and change what. Paste into Firebase. |
| `storage.rules` | Video storage rules. Paste into Firebase Storage. |
| `images/` | Starting photos. New uploads are compressed and stored in Firestore. |

## Roles

| Role | Can do |
|---|---|
| **Super admin** | Everything, plus approve people and change anyone's role under *Users & access* |
| **Admin** | Edits only the sections a super admin ticks for them (e.g. Journal and Thoughts) |
| **No access** | Signed up but waiting for approval; can't change anything |

- The **first account ever created** becomes super admin automatically.
- Everyone after that starts with no access until a super admin approves them.
- Section access is enforced by the database: an admin's save is rejected if it touches a section they weren't given.
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

## Videos

Videos (MP4/MOV up to 200 MB) upload to Firebase Storage, which needs the Blaze plan (the first 5 GB stored is free). They can go in the main photo frame (Profile), in Thoughts posts, and in the Gallery.

## Editing

Sign in at **/admin**. Changes preview in the form; click **Save & publish** and the live site shows them immediately (no redeploy needed). Wrap a word in `*asterisks*` to make it gold.

`index.html` also carries a copy of the content, used only if the database can't be reached.
