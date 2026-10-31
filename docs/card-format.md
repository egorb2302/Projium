# Card format

A card is one Markdown note per project. The card stays the source of truth: the dashboard writes one frontmatter field or one task line per request and refuses the write if that field or line changed since you opened the page.

## Where cards are found

`cards.layout` in the config:

- `folder` (default): `<projectsDir>/<name>/<name>.md`. The folder name and the file name must match.
- `flat`: every `.md` note directly in `projectsDir` is a candidate, and the file name (without `.md`) is the project name. With `cards.recursive: true`, notes in subfolders count too; hidden folders, `node_modules` and links are skipped, and when two notes share a name, both are named by their path (`Clients/Acme/Notes`); a note whose name equals such a path is then named by its own path too.

`cards.filter` keeps only notes whose frontmatter matches, for example `{ "type": "client-project" }` or `{ "tags": "project" }`. Matching is case-insensitive, a list field (`tags: [project, client]` or a `- item` list) matches when it contains the value, and an array in the filter means any of its values. With a filter, a matching note without a stage counts as `development`. Without a filter, a note needs a `stage` (or a `project` field) to be shown.

## Mapping the owner's fields

Projium uses the field names below. When the owner's notes already have their own, map them instead of renaming anything:

```json
"cards": {
  "layout": "flat",
  "filter": { "type": "client-project" },
  "fields": { "stage": "status", "spec_at": "started", "first_push_at": "first_deploy", "next_step": "next" },
  "stages": { "in progress": "development", "waiting for client review": "review", "shipped": "done" },
  "sections": { "tasks": "Todo" }
}
```

- `fields`: Projium field → the owner's frontmatter key. The value is read from that key and the dashboard writes it back there; no Projium key is added to the note. The dashboard labels such fields with the owner key. A Projium-named key the notes already have (`site`, `next_step` ...) is read without a mapping; `null` turns a field off entirely, for example `"site": null` when the notes have `site:` keys that should not be checked.
- `repos`: project name → repo folder (relative to `reposDir` or absolute) or `"none"`, for repos named differently from the project. A `repo:` key in the note wins. Without either, a project is matched to a folder in `reposDir` with the same name, ignoring case, spaces and punctuation (`Acme Shop` finds `acme-shop`).
- `name` (flat layout): `file` (default) names a project by its file name, `folder` by the folder the note sits in (for `Kestrel/kestrel-notes.md`), `title` by the note's first `#` heading.
- `stages`: the owner's words → Projium stages, case-insensitive. Writing a stage from the dashboard keeps the owner's current word when it already means that stage, otherwise writes the first word listed for it, or the Projium stage when none is listed. Words that are not mapped are shown as they are, and the doctor names them.
- Times: `2026-10-20 09:30`, `2026-10-20T09:30`, with seconds, and date-only `2026-10-20` (read as `00:00`) are all read. A write keeps the separator and the seconds the field already had; a date-only field stays date-only when the new time is `00:00` and becomes `YYYY-MM-DDTHH:MM` otherwise.
- A plain unquoted value stays unquoted when the dashboard rewrites it, as long as it is plain text; anything else is written quoted. A date or a time with seconds is written unquoted only into a date or time field (unless its old value was quoted) or over an unquoted date or time, so YAML tools keep reading text as text. Keys written as `status : x`, `"status": x` or with a tab before the colon are read and rewritten in place as `status: x`. Values that use YAML anchors, aliases, tags or flow lists and maps (`&a`, `*a`, `!!str`, `[...]`, `{...}`) are read-only in the dashboard.
- `sections`: the heading text (without `##`) of the tasks, updates and timeline sections.

Run `npm run --silent survey` to see which keys, values, date formats and checkbox headings the notes actually use before writing the mapping.

## Frontmatter

Keep it flat: one `key: value` per line. Multi-line values, block scalars and duplicate keys are shown read-only, so edit them in Obsidian. Projium also parses the frontmatter as YAML: when it does not parse, or a key sits inside another value or is written in a form Projium does not read (an explicit `? key`, an anchored key, a quoted string or list that runs over the next key), the whole card is read-only. Every write is parsed again and refused unless the other keys read exactly as before.

| Field | Value | What it drives |
|---|---|---|
| `stage` | `development`, `review`, `fixes`, `done` | Filters, the digest, health checks (stopped at `done`). A card with only `project:` shows as `development`. |
| `status` | free text | Shown under the name. Not editable from the dashboard. |
| `next_step` | one line | Card and digest. |
| `site` | `"https://domain"` | Uptime check every 10 minutes while the stage is not `done`, plus the prod flag read (below). Public https domains only. |
| `preview` | `"preview.jpg"`, `"alpha/shot.png"` or an Obsidian link `"[[Projects/alpha/preview.png]]"` | Cover image. A bare file name is looked up in the card's folder. png, jpg or webp, inside `projectsDir` only. Without it, the repo's `public/og.*` image is used. |
| `repo` | `"alpha"`, `"~/code/alpha"`, an absolute path, or `none` | The git repo of the project, relative to `reposDir`. Without it, the tracker uses `cards.repos`, then a `Repo: \`<path>\`` line in the card body (a backticked absolute path, `C:\...`, `C:/...`, `/...` or `~/...`), then a folder in `reposDir` named like the card, ignoring case, spaces and punctuation. `none` marks a project without code: no repo lookup, no warning. |
| `spec_at`, `design_pick_at`, `first_push_at`, `mainnet_at` | `YYYY-MM-DDTHH:MM` | Milestone durations and the time split. Read in the `utcOffset` time zone. |
| `handed_over_at`, `accepted_at` | `YYYY-MM-DD` | Shown on the card. |
| `accepted_by` | text | Shown on the card. |

Durations are always computed and never stored.

## Body sections

All optional.

`## Tasks` (or the heading set in `cards.sections.tasks`): one task per line.

```
- [ ] Fix slippage rounding · due 2026-11-02 · p1 ^t-a1b2
```

`due` and the priority (`p1`, `p2`, `p3`) are optional. The block id `^t-xxxx` (four lowercase letters or digits) is how the dashboard finds the task again. Tasks without an id are shown read-only; tasks added from the dashboard get one.

`## Updates`: free lines, shown as written. A trailing `^u-N` block id is hidden.

`## Timeline`: a Markdown table, shown as written.

## Next to the card

`READINESS.md` (the name is set by `readinessFile`) in the card's folder, if present. `{name}` in `readinessFile` is replaced by the card name, so `"{name} readiness.md"` works for the flat layout, where cards share a folder; there a name without `{name}` turns readiness off.

```
---
audit: 2026-10-29
audit_commit: 3f2a9c1
---

Ready: 18 of 21 acceptance items proven.
```

The dashboard shows the proven count and compares `audit_commit` with the repo: local HEAD, `origin/main` and uncommitted files. It never runs an audit itself.

## In the repo (optional)

- `.local/release.json` with `{ "updates": { "1": { "FEATURE_X": "1" } } }` names the feature flags of each numbered update.
- Branches named `update-N-*` are matched to update N and checked against `origin/main` as of your last fetch. The tracker never fetches.
- `FEATURE_*` names in `.env.example` or `README-updates.md` are listed when there is no release plan.
- A live site that answers `GET /api/config` with JSON booleans (top level or under `features`) shows which flags are on in prod.

## Time split

If you build with Claude Code, the tracker reads the session transcripts of the repo folder and its worktrees from `transcriptsDir` (default `~/.claude/projects`). Only timestamps and event kinds leave the parser; message text is never stored, sent or shown. Each phase between two milestones is split into: Claude working, review (agents named in `reviewAgents` and `codex exec` runs), waiting for you, pause (gaps over 3 hours) and no transcript.
