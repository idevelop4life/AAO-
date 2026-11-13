# Angela Agunwami Onwuka — Personal Website

My personal site: who I am, what I'm building, photos, quick thoughts, a journal and a newsletter signup. Black and gold, one page, no build step.

## What's in here

| File | What it is |
|---|---|
| `index.html` | The whole site: layout, styles, scripts and all the content |
| `portrait.jpg` | Main photo at the top of the page |
| `gallery-1.jpg`, `gallery-2.jpg`, `gallery-3.jpg` | Gallery photos |

## Editing content

All the text, links, projects, gallery photos, thoughts and journal posts live in one block near the bottom of `index.html`:

```html
<script type="application/json" id="site-data">
```

Change the text there and save. Wrap a word in `*asterisks*` to make it gold (for example `*Agunwami* Enterprises`).

To add a gallery photo, put the image in this folder and add a line to `gallery.items`:

```json
{"src": "gallery-4.jpg", "caption": "Optional caption"}
```

## Going live

The site is plain HTML, so it works on any static host:

- **Vercel** or **Netlify**: import this repository and deploy. No settings needed.
- **GitHub Pages**: Settings → Pages → deploy from the `main` branch.

Then point your domain at the host.

## Things that only work inside Claude

The **Edit site** panel and replies under Thoughts use Claude's artifact features. On another host the page still works; those two features stay hidden. When the site moves to its own domain, they can be rebuilt with a hosted editor and a small database.

## Newsletter

Paste your newsletter provider's signup URL into `subscribe.url` in the site data. Until then, the form tells visitors subscriptions are opening soon.
