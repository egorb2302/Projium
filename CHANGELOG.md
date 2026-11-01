# Changelog

Versions follow [semantic versioning](https://semver.org); each one is a git tag (`v0.4.0`). After pulling a new version, restart the server (`npm run --silent stop`, then `npm run --silent start:bg`, or log in again with autostart).

## 0.7.0 (2026-11-01)

- Tasks written by hand or by an agent can be checked off and edited from the dashboard. A trailing block id in any shape (`^t-1uz`, `^a1b2c3`) is now read as the task id and kept on edit. A line with no block id is addressed by its position `at` (API, MCP `toggle_task` and `edit_task`): a check flips only its box, and an edit rewrites it as `- [ ] text · due · p ^t-xxxx` with a new id. Task text may now contain ` · ` and `^`; it only must not end like a due date or priority it does not have.
- Items of `## Updates` get a checkbox on the project page: checking one writes it as `- [x] ` in the note. New `POST /api/projects/<name>/update` and MCP tool `mark_update`.
- Time page: spec to mainnet is a chart by start date (log scale, median line, hover for details, each dot links to its project), and a per-project breakdown by phase replaces the old bars; time not covered by a first push shows as its own part.
- A check of a task or update that the server refuses (not a conflict) puts the checkbox back as it is in the card; a refused edit keeps the form open with what you typed.
- Doctor no longer warns about tasks without an id, and does not count update checkboxes as stray tasks.

## 0.6.1 (2026-11-01)

- The project list opens on All when no project is in progress, instead of an empty In progress list. Until you pick a filter, it is chosen again each time the list opens, so it follows stage changes made on a project page.

## 0.6.0 (2026-11-01)

- The project list opens with **Needs attention**: projects with overdue tasks, tasks due within two days, p1 tasks or a down site while the project is in work, most urgent first, each with its most urgent task.
- Search (press `/`, Escape clears), sorting (most urgent, newest, by name) and a dense table view next to the cards; the view and sort are remembered in the browser.
- Cards are shorter and show signals (overdue, p1, due soon, site down, commits after the audit), open tasks, readiness and time to first push.
- Project page: card fields are shown as values and turn into an input on click (Enter or leaving the field saves, Escape cancels); dates read `2026-10-20 17:29` instead of the browser's format. A stage word Projium does not know can now be replaced from the dashboard. Tasks are sorted by overdue, priority and due date, with the priority and a coloured due date on the same line; done tasks fold under "Done (N)". The audit panel has a state badge and a readiness bar; prod flags are grouped by state.
- Time page: projects without transcripts are listed in one line instead of a row each.

## 0.5.1 (2026-11-01)

- On Windows, `start:bg` starts the server outside the job object of the process that runs it, when that job allows it. Agent apps that keep each session's processes in a job and end them with the session (the Claude desktop app does) no longer take the dashboard down when the session is closed or deleted. A job that forbids leaving it still contains the server. This takes one `CreateProcess` call through Windows PowerShell; where PowerShell cannot run it, the server starts as before.

## 0.5.0 (2026-10-31)

- Build time survives deleted transcripts. Deleting a session in the Claude app deletes its transcript (the app leaves a `<session>.desktop-released.json` marker); Projium now keeps the intervals it has read (start, end and kind, no text) in `data/tracker.db`, so the split stays after the transcript is gone and after a restart. `timeSplit.kept` counts such sessions, and `timeSplit.lost` counts sessions deleted before Projium read them; the dashboard shows that the split is incomplete.
- Writes can carry the Projium `instance`; the server refuses a write meant for another projects folder. The MCP server always sends it, which closes the window between its instance check and the write.
- `npm run start:bg -- --open` opens the dashboard in the browser; `start-tracker.cmd` uses it, so it follows the configured port.
- A number or boolean is written unquoted only when the new value is in its plain form (`7`, `true`); `007`, `0x10`, `1e3` or `True` are written as quoted text. Keys like `True:` or `Null:` no longer lock a card.
- `survey` names the first 20 notes without frontmatter (`withoutFrontmatter`).
- The systemd unit no longer orders after `network-online.target`, which a user manager cannot see. `--check` also leaves out commands for Windows paths with typographic quotes.
- Tests for `start:bg` when the server exits at once or never answers.

## 0.4.0 (2026-10-31)

- MCP server over stdio (`scripts/mcp.mjs`, [docs/mcp.md](docs/mcp.md)) so the owner's agents read and update projects from their own session: `list_projects`, `get_project`, `set_field`, `add_task`, `toggle_task`, `edit_task`, `refresh_project`, `digest_preview`, `doctor`. A thin client of the local HTTP API with the same `expected` and `fileId` checks. Speaks both the `initialize` era (2024-11-05 to 2025-11-25) and the stateless 2026-07-28 revision. `node scripts/mcp.mjs --check` prints the registration commands.
- Autostart on macOS (launchd user agent) and Linux (systemd user service), plus the Windows Startup shortcut: `npm run --silent autostart` prints the file, its content and the commands for this computer and writes nothing ([docs/autostart.md](docs/autostart.md)).
- This changelog and version tags.

## 0.3.2 (2026-10-31)

- A digest that fails to send is retried after 15 minutes, 30 minutes, an hour, then every two hours, ten tries a day at most (it was three tries 15 minutes apart, so a short network outage lost the day's digest).

## 0.3.1 (2026-10-31)

- Every frontmatter write is checked with a YAML parser (js-yaml 4.1.1, vendored in `lib/vendor`): before the write, a card whose YAML does not parse or hides a key inside another value is read-only; after it, the write is refused unless every other key reads the same and the field holds exactly the new value. Task changes may not touch the frontmatter.
- Dates, seconds times, numbers and booleans keep their YAML type when rewritten; a quoted value starting with `[` or `{` no longer locks the card.
- Card names that collide after duplicates are renamed by path no longer hide a card; `survey` suggests the recursive flat layout for any nested note; `fileId` is documented as required for flat-layout writes.

## 0.3.0 (2026-10-31)

- Owner layouts and field mapping (`cards` in the config): flat notes, recursive folders, frontmatter filters, names from file, folder or title, the owner's own field keys and stage words, task and update headings, repo hints. Writes go to the owner's key, in the owner's wording and time format.
- `npm run survey` lists the keys, values and checkbox headings of a notes folder.

## 0.2.0 (2026-10-31)

- Agent onboarding: `AGENTS.md` playbook, `llms.txt`, API docs, card template, config JSON schema, and JSON commands `init`, `doctor`, `start:bg` and `stop`.

## 0.1.0 (2026-10-31)

- First public version: dashboard over Markdown project cards with stages, tasks, milestone times, readiness-audit freshness, site uptime, prod feature flags, build time split from Claude Code transcripts and an optional daily digest. Owner settings live in `tracker.config.json`.
