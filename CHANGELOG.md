# Changelog

Versions follow [semantic versioning](https://semver.org); each one is a git tag (`v0.4.0`). After pulling a new version, restart the server (`npm run --silent stop`, then `npm run --silent start:bg`, or log in again with autostart).

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
