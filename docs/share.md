# Client status pages

A read-only page per project that you can give a client, a manager or whoever the work is for: the project name, its stage, progress, the planned updates with what is done, and uptime and incidents from [Launch Watch](watch.md). Projium writes it as one self-contained HTML file (fonts and styles inside, no scripts, no analytics, no requests to anyone) and never publishes it: you put it where your client can open it.

## What is shown

You choose per project. The safe set is on by default; the rest you turn on yourself, because cards usually hold internal notes there.

| Part | Default | What the client sees |
|---|---|---|
| `stage` | on | In development, In review, Fixing review notes, Done |
| `progress` | on | The readiness file's `Ready: X of Y` as a bar, or, without one, how many items of `## Updates` are checked |
| `updates` | on | The `## Updates` items with their checkmarks; links and block ids are stripped |
| `uptime` | on | The card's site checks over 7 and 30 days with a bar per day, and the project's Launch Watch sites and heartbeats as working or not, with the certificate date |
| `incidents` | on | Site, certificate and heartbeat incidents of the last 90 days: when, and how long until resolved |
| `status` | off | The card's own status words |
| `next_step` | off | The next step |
| `tasks` | off | Open tasks with due dates (no priorities) |

Never on the page: file paths, repo names, other frontmatter keys, task priorities, done tasks, timeline rows, wallet addresses and balances (balance targets and their incidents are left out), alert details, and anything from other projects. The page says when it was generated, in the zone of your card times.

The page has `noindex` set and the export folder gets a `robots.txt` that asks search engines to stay away. Its folder name ends in a random part (`acme-shop-k3x9p2`), so the address cannot be guessed from the project name.

## Turn it on

On the project page, **Client page** → **Share a status page**. Tick what to show, optionally give the page another title (the client's name for the project) and a language (English or Russian; the digest language by default), and **Save**. **Export now** writes the page; **Preview** opens it from the dashboard.

Or in `tracker.config.json`:

```json
"share": {
  "dir": "share",
  "every": 60,
  "projects": {
    "Acme Shop": { "show": ["stage", "progress", "updates", "uptime", "incidents"], "title": "Acme web shop", "lang": "en", "slug": "acme-shop-k3x9p2" }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `dir` | `share` next to the config | Where pages are written: `<dir>/<slug>/index.html` |
| `every` | `0` | Minutes between automatic exports; `0` exports only when you ask |
| `projects` | none | Card name → what to show. `show` defaults to the safe set; `slug` is the page's folder name (the dashboard makes a random one) |

Sharing settings are read at each export, so turning a page on or off needs no restart. Export from the command line with `npx github:egorb2302/Projium share` (or `node bin/projium.mjs share` in a clone) while the dashboard runs. A page you stop sharing is deleted from the folder at the next export; files Projium did not write are never touched.

## Put it online

The folder holds only static files. Any static host works; pick one your client can reach:

- **Send the file.** `index.html` opens on its own, offline too; send it by mail or a messenger.
- **Cloudflare Pages.** Create a project with direct upload, drop the `share` folder, or run `npx wrangler pages deploy share --project-name <name>`. The page is then at `https://<name>.pages.dev/<slug>/`.
- **GitHub Pages.** Copy the folder into a repository (for example `docs/` on `main`) and turn on Pages for it. Mind that a public repository shows every page in it to anyone browsing the repository; use one repository per client or a private one with Pages where your plan allows it.
- **Netlify Drop** (app.netlify.com/drop) or any web server: upload the folder.

To keep a page current, set `every` and let a sync tool (a synced folder, `rclone`, a scheduled `wrangler pages deploy`) copy the folder. Projium itself never uploads anything.

The dashboard's own server answers only on `127.0.0.1` and is not meant to be opened to clients; the static export is the way to share.
