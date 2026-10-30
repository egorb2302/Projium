# Card format

The tracker reads one Markdown file per project: `<projectsDir>/<name>/<name>.md`. The folder name and the file name must match. A folder whose card has no `stage` (and no `project` field) is skipped, so other notes can live next to your cards.

The card stays the source of truth. The dashboard writes one frontmatter field or one task line per request and refuses the write if that field or line changed since you opened the page.

## Frontmatter

Keep it flat: one `key: value` per line. Multi-line values, block scalars and duplicate keys are shown read-only, so edit them in Obsidian.

| Field | Value | What it drives |
|---|---|---|
| `stage` | `development`, `review`, `fixes`, `done` | Filters, the digest, health checks (stopped at `done`). A card with only `project:` shows as `development`. |
| `status` | free text | Shown under the name. Not editable from the dashboard. |
| `next_step` | one line | Card and digest. |
| `site` | `"https://domain"` | Uptime check every 10 minutes while the stage is not `done`, plus the prod flag read (below). Public https domains only. |
| `preview` | `"preview.jpg"`, `"alpha/shot.png"` or an Obsidian link `"[[Projects/alpha/preview.png]]"` | Cover image. A bare file name is looked up in the card's folder. png, jpg or webp, inside `projectsDir` only. Without it, the repo's `public/og.*` image is used. |
| `repo` | `"alpha"` or an absolute path | The git repo of the project, relative to `reposDir`. Without it, the tracker uses a `Repo: \`<absolute path>\`` line in the card body, then a folder in `reposDir` named like the card. |
| `spec_at`, `design_pick_at`, `first_push_at`, `mainnet_at` | `YYYY-MM-DDTHH:MM` | Milestone durations and the time split. Read in the `utcOffset` time zone. |
| `handed_over_at`, `accepted_at` | `YYYY-MM-DD` | Shown on the card. |
| `accepted_by` | text | Shown on the card. |

Durations are always computed and never stored.

## Body sections

All optional.

`## Tasks`: one task per line.

```
- [ ] Fix slippage rounding · due 2026-11-02 · p1 ^t-a1b2
```

`due` and the priority (`p1`, `p2`, `p3`) are optional. The block id `^t-xxxx` (four lowercase letters or digits) is how the dashboard finds the task again. Tasks without an id are shown read-only; tasks added from the dashboard get one.

`## Updates`: free lines, shown as written. A trailing `^u-N` block id is hidden.

`## Timeline`: a Markdown table, shown as written.

## Next to the card

`READINESS.md` (the name is set by `readinessFile`) in the card's folder, if present:

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
