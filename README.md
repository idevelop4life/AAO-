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

## Workspace

Inside the admin: **Tasks** (board), **Chat** (direct + groups), **Calendar** (with Add to Google Calendar), **Documents**, **Team**, and a notification bell. Super admins give each person workspace access under *Users & access* (Tasks, Assign tasks to others, Chat, Calendar, Documents) and set their category.

### Email notifications (Gmail)

`api/notify.js` runs on Vercel and emails people when they get a task, comment, status change or invite. To switch it on, add these in **Vercel → Project → Settings → Environment Variables**, then redeploy:

| Name | Value |
|---|---|
| `GMAIL_USER` | the Gmail address emails come from |
| `GMAIL_APP_PASSWORD` | a 16-character Gmail app password (Google Account → Security → App passwords; needs 2-Step Verification) |

Never put the app password in the code.

## Super admin: setting someone's password
"Email them a reset link" works with no setup. "Set password" needs one Vercel environment variable:
`FIREBASE_SERVICE_ACCOUNT` = the whole JSON file from Firebase → Project settings → Service accounts →
Generate new private key. Keep that file private; never commit it or paste it into chat.

## Daily reminder emails
`/api/reminders` runs every morning (see `vercel.json`, 11:00 UTC). Each person gets one email with their overdue
tasks, what's due, today's events (in their own time zone), content going out today and tasks waiting for their review.
Needs Vercel environment variables: `CRON_SECRET` (any long random text), `GMAIL_USER`, `GMAIL_APP_PASSWORD`,
`FIREBASE_SERVICE_ACCOUNT`. In-app reminders in the bell work without any of these.

## Storage rules
Task attachments live under `workspace/tasks/` and need the latest `storage.rules` published.
