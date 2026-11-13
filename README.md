# Angela Agunwami Onwuka — Personal Website

My personal site: who I am, what I'm building, photos, quick thoughts, a journal and a newsletter signup. Black and gold, one page, no build step.

## What's in here

| File | What it is |
|---|---|
| `index.html` | The whole site: layout, styles, scripts and all the content |
| `content/site.json` | All the words, links and photo paths on the site |
| `images/` | Photos |
| `admin/` | The admin page at /admin |
| `.pages.yml` | Settings for the Pages CMS editor |

## Editing content (admin)

Go to **yoursite/admin** and click **Open the editor**, or go straight to [app.pagescms.org](https://app.pagescms.org). Sign in with GitHub, open this repository, then **Website**. Every section of the site is editable there, including photo uploads. Saving commits to GitHub, and Vercel redeploys automatically.

Only people with write access to this GitHub repository can sign in and save.

Behind the scenes:
- All content lives in `content/site.json`. The editor's layout is defined in `.pages.yml`.
- Photos live in `images/`.
- `index.html` also carries a copy of the content as a fallback, so the page never loads blank.
- Wrap a word in `*asterisks*` to make it gold (for example `*Agunwami* Enterprises`).

## Going live

The site is plain HTML, so it works on any static host:

- **Vercel** or **Netlify**: import this repository and deploy. No settings needed.
- **GitHub Pages**: Settings → Pages → deploy from the `main` branch.

Then point your domain at the host.

## Things that only work inside Claude

The in-page **Edit site** button and replies under Thoughts use Claude's artifact features, so they only appear in the Claude preview. On the public site, use /admin to edit. Public replies would need a small database, which can be added later.

## Newsletter

Paste your newsletter provider's signup URL into `subscribe.url` in the site data. Until then, the form tells visitors subscriptions are opening soon.
