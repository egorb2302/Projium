# HTTP API

The dashboard's own API, usable by scripts and agents on the same computer. Base URL `http://127.0.0.1:3210` (or the configured port).

Rules for every request:

- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`; anything else gets `403`. curl and most clients send it from the URL.
- POST bodies are JSON with `content-type: application/json` (otherwise `415`), at most 64 KB. A browser `Origin` header, if present, must be local.
- Errors come back as `{ "error": "..." }` with `400`, `404`, `409`, `421` or `500`.

## Read

`GET /api/projects` returns an array, one entry per card. A card that cannot be read appears as `{ "name", "error" }`.

`GET /api/projects/<name>` returns one card with uptime history. `<name>` is the card's `name`, URL-encoded.

A card entry:

| Key | Content |
|---|---|
| `name` | The card's folder with the folder layout; with `cards.layout "flat"` its note file, folder or title (`cards.name`). Cards that would share a name are named by their path inside projectsDir, like `Clients/Acme`. |
| `hash` | Short hash of the card file as read. |
| `fileId` | Short id of the note file. Send it back as `fileId` with every write: when the project name now resolves to another note (a new note with the same name appeared), the write is refused with `409` instead of going to the wrong file. |
| `preview` | URL path of the cover image (`/vault/...` or `/og/...`), or `null`. |
| `fields` | `status`, `stage`, `next_step`, `site`, `accepted_by`, `handed_over_at`, `accepted_at`, `spec_at`, `design_pick_at`, `first_push_at`, `mainnet_at` when present. Other frontmatter keys are never returned. |
| `fieldKeys` | Fields mapped to the owner's own frontmatter keys (`cards.fields`), like `{ "stage": "status" }`, whether or not this note has the key yet. Writes go to those keys; writing a field the note does not have adds the owner's key. |
| `locked` | Field names the dashboard will not write (not a plain one-line value in the card). |
| `tasks` | `{ id, at, done, text, due, p }`. `at` is the task's position among the checkbox lines of the section; `id` is its trailing block id (`^t-a1b2` gives `t-a1b2`), or `""` when the line has none. |
| `updates` | Lines of `## Updates`: `{ text, item, done, id }`, plus `at` (position among the `- ` items) on items. `done` is `true` for an item written as `- [x] `. |
| `timeline` | Rows of the `## Timeline` table. |
| `repoInfo` | `repo` (folder name), `readiness` (`proven`, `total`, `audit`, `commit`), `freshness` (`state`: `current`, `changed-after`, `no-audit-commit`, `audit-commit-unknown`, `git-unavailable`, `no-repo`, plus commit counts), `updates` (release plan and update branches). |
| `health` | `last` check `{ ts, code, ms, error }`, `uptime24` (percent), `checks24`. |
| `prodUpdates` | `{ entries, checkedAt, configError }`. Each entry: `n` (update number, `null` for a site flag outside the release plan), `flags` (`{ name, prod }`), `branch` (`{ name, sha, inMain }` or `null`), `state` (`on`, `off`, `partly`, `merged`, `branch`, `unknown`). |
| `timeSplit` | `null` when the card has no repo, the project is ignored, or the first transcript scan (a few seconds after start, then hourly) has not run yet. Otherwise `{ sessions, agents, kept, lost, at, phases }`: `kept` counts sessions whose transcript is gone but whose times Projium had already saved, `lost` counts sessions deleted in the Claude app before Projium read them (their time is missing); `phases` has `toFirstPush`, `toMainnet` and `total` only when both milestone times of that phase are set. Each phase: milliseconds of `work`, `review`, `waiting`, `pause`, `missing`, plus `total` and `hasData`. |
| `zone` | The configured UTC offset, like `+03:00`. |
| `ignored` | `true` for projects matched by the `ignore` list. |
| `watch` | `null` when no Launch Watch target names this project. Otherwise `{ open, targets }`: open incidents and the number of targets; `GET /api/projects/<name>` gives `targets` in full, as in `GET /api/watch`. |

`GET /api/meta` returns `{ app: "projium", version, instance }`; `instance` is a hash of the projects folder, so a client can tell this Projium from another one on the same port.

`GET /api/digest` returns `{ text, at, enabled, lastAuto, lastManual }`: the digest as it would be sent now. Nothing is sent.

## Write

Every write changes one thing and checks that it did not change since you read it. A write body may also carry `instance` (from `GET /api/meta`): a Projium serving another projects folder then answers `421` and writes nothing. The MCP server always sends it.

**Set a field:** `POST /api/projects/<name>/field`

```json
{ "key": "next_step", "value": "Ship update 3", "expected": "the value you read", "fileId": "from the card" }
```

Send `fileId` with every write, tasks too. With `cards.layout "flat"` it is required: a write without it gets `400`. With the folder layout it is optional but still recommended.

`key` is one of the editable fields (`stage`, `next_step`, `site`, `accepted_by`, `handed_over_at`, `accepted_at`, `spec_at`, `design_pick_at`, `first_push_at`, `mainnet_at`). `value` is a one-line string; `""` clears it. Dates are `YYYY-MM-DD`, times `YYYY-MM-DDTHH:MM`, `site` is `https://domain`. Returns the updated card. If the field changed meanwhile: `409` with `{ "error", "current" }`; resend with `expected` set to `current` if you still want to write.

**Add a task:** `POST /api/projects/<name>/task`

```json
{ "op": "add", "task": { "text": "Write the client readme", "due": "2026-11-05", "p": "p2" }, "fileId": "from the card" }
```

`due` and `p` (`p1`, `p2`, `p3`) are optional. The text must be one line, and without a due date or priority it must not end like ` · due YYYY-MM-DD` or ` · p1` (it would read back as one). A `## Tasks` section is created when missing.

**Toggle or edit a task:**

```json
{ "op": "toggle", "id": "t-a1b2", "expected": { "done": false, "text": "...", "due": "", "p": "p1" }, "fileId": "from the card" }
{ "op": "edit", "id": "t-a1b2", "expected": { "...": "as read" }, "task": { "text": "New text", "due": "", "p": "p2" }, "fileId": "from the card" }
```

A task without an id is addressed by its position: send `"at": 3` instead of `id`. A toggle flips only its checkbox; an edit rewrites the line in the Projium format and gives it an id. `expected` is the task exactly as you read it; a mismatch returns `409`.

**Mark an update done:** `POST /api/projects/<name>/update`

```json
{ "at": 0, "done": true, "expected": { "text": "u1 referral links", "done": false }, "fileId": "from the card" }
```

The item at that position becomes `- [x] ` (or `- [ ] ` with `"done": false`); the rest of the line stays. `expected` may also carry the item's `id` as read. A mismatch with `expected` returns `409`.

**Recheck now:** `POST /api/projects/<name>/refresh` with `{}` re-reads git, the live site and transcripts for that card.

**Create a card:** `POST /api/projects`

```json
{ "name": "Acme Shop", "stage": "development", "next_step": "Kick-off call" }
```

Creates a new note from [card-template.md](card-template.md) in the owner's layout: `<name>/<name>.md` with the folder layout, `<name>.md` with `cards.layout "flat"`. It uses the owner's keys and stage words from `cards`, adds the `cards.filter` keys so the note counts as a project, and names the task, update and timeline sections as `cards.sections` says. `stage` (default `development`) and `next_step` are optional. Returns the card as `GET /api/projects/<name>` does. `409` when a note or project with that name exists (nothing is written); `400` for a name that is not a safe file name (letters, digits, spaces and `. _ ( ) -`, up to 120 characters).

**Repos without a card:** `GET /api/repos` returns `{ layout, repos }`: the git repos directly in `reposDir` that no card points at (by name, `repo:` key, `cards.repos` or a repo path in the note), minus ignored ones, as `{ name, active }` (folder name and when its `.git` folder last changed, epoch ms), most recently active first. No paths.

`POST /api/repos/cards` with `{ "repos": ["helios-bridge", "nova-landing"], "stage": "development" }` creates a card named like each repo folder; only names from that list are accepted. Returns `{ created: [names], failed: [{ name, error }] }`.

**Send the digest now:** `POST /api/digest/send` with `{}`. `409` when no channel is configured or a send is in progress.

**Stop the server:** `POST /api/shutdown` with `{}`, which is what `npm run stop` uses. Returns `{ "stopping": true }`; `404` when the server was not started from the command line (`npm start`, `start:bg`, autostart).

## Watch

Launch Watch ([watch.md](watch.md)): sites, heartbeats and wallet balances from the `watch` config block, checked whatever the stage of a project.

`GET /api/watch` returns `{ enabled, every, failAfter, recoverAfter, notify, lastTick, targets, incidents }`:

- `lastTick`: `{ at, ms, offline }` of the last round, or `null` before the first one. `offline` is `true` when no target answered and nothing was counted.
- `targets`: the configured targets with their settings (`name`, `kind`, `project`, `url`, `address`, `chain`, `unit`, `min`, `certDays`, `field`, `maxAgeMin`, `activeWhen`, `max`; `rpc` is where a balance's RPC comes from: `public`, `config`, `env` or `missing`, never the URL), `mutedUntil` (epoch ms or `null`) and `signals`: one per check (`up` and `cert` for a site, `beat`, `balance`), each `{ signal, status, result, detail, ts, since, incident }`. `status` is `ok` or `open`; `result` is the last check: `ok`, `fail`, `skip` (unknown) or `null` before the first round. `detail` is a list of parts like `{ "k": "http", "status": 502 }` or `{ "k": "balance", "value": 0.012, "min": 0.05, "unit": "SOL" }`.
- `incidents`: the last 100, open ones first: `{ id, target, signal, project, openedAt, closedAt, firstDetail, lastDetail, openSent, closeSent, muted, end }`. `end` is `recovered` or `removed` (the target left the config).

**Check now:** `POST /api/watch/check` with `{}` runs a round and returns the same as `GET /api/watch`; `409` when no targets are configured.

**Mute:** `POST /api/watch/mute` with `{ "target": "shop", "until": 1793540000000 }` (epoch ms, within 30 days) or `"until": null` to unmute. `404` for an unknown target, `400` for a time in the past or too far ahead.

## Settings

The Settings page reads and writes the config file the server was started with.

`GET /api/settings` returns:

- `file`, `exists`, `hash` (send it back with a write), `restart` (`true` when the config or the `.env.local` next to it changed since the server started), `restartCommand`, `error` (when the file does not load);
- `values`: the keys as written in the file (`projectsDir`, `reposDir`, `transcriptsDir`, `port`, `utcOffset`, `digestAt`, `digestLang`, `digestCommand`), `""` when not set;
- `effective`: what the server would use, with each folder's resolved `path` and `state` (`ok`, `missing`, `not a folder`), and the digest `channel` (`telegram`, `command`, `none`);
- `telegram`: `{ set, here }`, whether a bot token and chat id are set at all and whether they are in the `.env.local` next to the config (never the values);
- `watch`: the Launch Watch targets as written, with `rpc` replaced by `rpcSet: true`.

`POST /api/settings` changes what it names and keeps the rest of the file:

```json
{
  "hash": "from the GET",
  "set": { "projectsDir": "C:/Notes/Projects", "utcOffset": "+03:00", "digestLang": "ru", "digestCommand": null },
  "telegram": { "token": "123456:ABC...", "chatId": "123456789" },
  "watch": [
    { "op": "add", "target": { "name": "shop", "kind": "site", "url": "https://shop.example" } },
    { "op": "update", "name": "keeper", "target": { "name": "keeper", "kind": "heartbeat", "url": "https://api.example/health", "field": "lastRunAt", "maxAgeMin": 20 } },
    { "op": "remove", "name": "old-site" }
  ]
}
```

Every part is optional. `""` (or `null` for `digestCommand`) removes a key; the projects folder cannot be removed. Folders must exist (the transcripts folder may not). `telegram` writes `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` into the `.env.local` next to the config, keeping its other lines; `"telegram": null` removes them. An `update` keeps target keys the form does not show (`failAfter`, `activeWhen`, `max`, and `rpc` when none is sent) unless the kind changes. The new config is validated as a whole before anything is written; it is written atomically, and the previous file is kept as `tracker.config.json.bak-<time>` (the 10 newest of those are kept). Returns the same as the GET plus `backup`. `409` when the file changed since `hash` was read, `400` with the reason when the result would not load, `404` when the server was started without a config file path (tests).

## Example

```
curl -s http://127.0.0.1:3210/api/projects/orbit-swap
curl -s -X POST http://127.0.0.1:3210/api/projects/orbit-swap/task \
  -H "content-type: application/json" \
  -d '{"op":"add","task":{"text":"Check the leaderboard","p":"p2"},"fileId":"<fileId from the GET above>"}'
```
