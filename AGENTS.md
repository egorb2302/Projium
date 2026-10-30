# AGENTS.md: setting up Projium for your owner

You are an AI agent and your owner asked you to install Projium and connect it to their project notes. This file is your playbook. Follow it in order; every step ends in a check you can run.

Projium is a local dashboard (Node 24, no dependencies) over Markdown project cards: one card per project with a YAML frontmatter `stage`, optional tasks, milestone times, a repo, a live site. It runs on `127.0.0.1` only. Card format: [docs/card-format.md](docs/card-format.md). HTTP API: [docs/api.md](docs/api.md).

All Projium commands print JSON. Run them as `npm run --silent <command>` (without `--silent`, npm prints a banner before the JSON).

## Ground rules

- **Existing notes:** read them freely, but do not edit, move or rename one without the owner's explicit yes.
- **New files:** creating cards in a new folder needs the owner's yes once, for that folder. Tell the owner the folder, so deleting it undoes everything.
- **Undo for edits:** before you edit an existing note (with a yes), make sure it can be undone: the notes are under git or a sync with history, or you keep a copy and say where.
- **Secrets:** a Telegram bot token goes only into `.env.local` in the Projium folder (git-ignored), and only if the owner gives it to you. Never put secrets in `tracker.config.json` or in cards.
- **Ask first:** autostart, the daily digest, the `streak` option, and adding a `site` to a card (it starts an outbound uptime and `/api/config` check every 10 minutes).
- **Network:** keep the server on `127.0.0.1`. Do not open it to the network or tunnel it without the owner's yes.
- **Transcripts:** never copy text from Claude Code transcripts anywhere. Projium reads message text in memory only for three fixed checks and stores only timestamps and event kinds.
- **The Projium folder:** clone it outside the notes folder. Never commit or push from it on the owner's behalf.

## 1. Install

Needs Node.js 24+ and git (`node -v`, `git --version`).

```
git clone https://github.com/egorb2302/Projium.git
cd Projium
npm test
```

Check: the summary at the end says `ℹ fail 0`. Some tests print failure-looking log lines (for example `streak failed`) on purpose; only the summary counts. The tests create and delete folders under the system temp folder and run git there; on Windows keep `TEMP` at its usual short path, or git may fail with "Filename too long". No `npm install` is needed.

If a `tracker.config.json` already exists in the folder, Projium is set up already: run `npm run --silent doctor` (step 5) and fix what it reports instead of starting over.

## 2. Connect the owner's notes

The goal is to read the owner's project notes **where they are, as they are**: Projium adapts to their layout and field names through `cards` in the config ([docs/card-format.md](docs/card-format.md)). Change or create notes only when the config cannot express what you need.

**Find the projects.** Ask the owner where their project notes live if you cannot see it. Open a few. A note is a project when it describes one piece of work with a status (frontmatter like `type: project`, a `project` tag or a `status:`, a projects or clients folder). Inboxes, daily notes, meeting notes and references are not. When unsure, ask, or leave it out and list it in your report.

**Survey them.**

```
npm run --silent survey -- --dir "<folder with the project notes>"
```

It prints every frontmatter key with how many notes use it, its value kinds (text, date, datetime with a space or a `T`, url, list) and, for short text keys, the values themselves; keys that look secret are never shown. It also prints `layoutHint` and the headings that hold checkboxes. Read-only.

**Choose the layout and the filter:**

| What you see | Config |
|---|---|
| One folder per project, with a note named like the folder (`Acme/Acme.md`) | `"layout": "folder"` (default) |
| One note per project in a folder (`Clients/Acme Shop.md`) | `"layout": "flat"` |
| Project notes spread over subfolders (`Clients/Acme/Acme Shop.md`, `Clients/Beta/Beta.md`) | `"layout": "flat", "recursive": true` |
| Projects mixed with other notes | add `"filter"` on a key that marks projects, from the survey: `{ "type": "client-project" }`, `{ "tags": "project" }` |
| One folder per project whose main note has another name (`Kestrel/kestrel-notes.md`) | `"layout": "flat", "recursive": true` with a filter, so the note is read wherever it sits |

**Map the fields.** For each Projium field, find the owner's key in the survey and put it into `cards.fields`; map only what exists, leave the rest out rather than guess.

| Owner's key usually called | Projium field |
|---|---|
| `status`, `state`, `phase` | `stage`, plus `cards.stages` for each value from the survey: active work → `development`; waiting for review, a client or feedback → `review`; fixing after review → `fixes`; finished and no longer worked on, closed, paused for good → `done`. A live product that still gets work is `development` or `fixes`, not `done`: `done` also stops its uptime checks. The owner's word stays visible as `status`. |
| `next`, `next action` | `next_step` |
| `started`, `kickoff`, `brief`, `created` (when it marks the start of the work) | `spec_at` |
| `design approved` | `design_pick_at` |
| `first deploy`, `first_push`, `live since` | `first_push_at` |
| `launched`, `released`, `mainnet` | `mainnet_at` |
| `delivered`, `accepted`, `client` (who accepted) | `handed_over_at`, `accepted_at`, `accepted_by` |
| `url`, `site`, `prod` | `site`: **ask first**, it turns on uptime checks |

Keys with spaces cannot be mapped. Date and time formats are read as they are (`2026-10-20 09:30`, `2026-10-20T09:30`, date-only); writes keep each field's format. Times are in the owner's UTC offset (step 4).

**Tasks.** If the owner's to-dos are checkboxes under one heading (`## Todo`, `## Next`), set `"sections": { "tasks": "Todo" }`. Their own lines show as read-only tasks (no task id); tasks added from the dashboard get the Projium format `- [ ] text · due YYYY-MM-DD · p1 ^t-xxxx` in that section.

**Repo.** A `repo:` key in the owner's frontmatter is read as is (relative to `reposDir`, absolute, `~/...`, or `none`); `~` means the home folder of the user who runs Projium. Otherwise a project is matched to `<reposDir>/<project name>`. When names differ and you may not edit the notes, say so in the report; with a yes, add `repo:` to the frontmatter. For a GitHub URL in a note, find the local clone and confirm it with `git -C <clone> remote get-url origin` when it has a remote.

**When the config is not enough** (projects live in a database or a single list note, or the owner wants Projium's own cards): create a new folder, for example `<vault>/Projium/`, with one card per project from [docs/card-template.md](docs/card-template.md), owner's yes first. Link each card to its source note with a full vault path (`Source note: [[Work/Clients/Acme Shop|Acme Shop]]`), record where each time came from in its `## Timeline`, and tell the owner that status and tasks now live in the cards.

## 3. Find the repos

Find the folder where the owner clones project repos: that is `reposDir`.

## 4. Write the config

Pick a port: 3210 by default. Before the config exists, `npm run --silent doctor` already probes 3210 and shows `server.portBusy: true` when something else answers there; then pass another port with `--port`.

```
npm run --silent init -- --projects "<absolute projectsDir>" --repos "<absolute reposDir>" --offset=+03:00
```

- `--offset` is the owner's UTC offset for the times in cards. Ask, or take it from their clock; set it explicitly where daylight saving applies. Keep the `=` form: `--offset -05:00` with a space is rejected, `--offset=-05:00` works.
- `--transcripts "<folder>"` when Claude Code transcripts are not in `~/.claude/projects` of the user running Projium.
- The `cards` part from step 2: `--layout flat`, `--recursive`, `--filter type=client-project` (repeat for more values), `--field stage=status` (repeat per field), `--stage "in progress=development"` (repeat per word), `--tasks-heading Todo`. Or write `cards` into the JSON by hand afterwards.
- Also: `--port`, `--readiness` (`"{name} readiness.md"` for the flat layout), `--lang en|ru`, `--ignore word1,word2` (projects whose name or repo path contains a word: no repo reads, no site checks), `--force` (replaces an existing config with only these flags; the old file is kept as `tracker.config.json.bak-<time>`, never overwritten).

Example for flat client notes:

```
npm run --silent init -- --projects "C:/Users/me/Vault/Work/Clients" --repos "C:/Users/me/code" --offset=-05:00 --layout flat --filter type=client-project --field stage=status --field spec_at=started --stage "in progress=development" --stage "waiting for client review=review" --stage "shipped=done" --tasks-heading Todo
```

It prints `{ "ok": true, "written": ... }` or `{ "ok": false, "error": ... }`. All config keys: [tracker.config.schema.json](tracker.config.schema.json). `PORT` in the environment or in `.env.local` overrides the config's `port`.

## 5. Check with the doctor

```
npm run --silent doctor
```

It exits 0 with `ok: true` when `problems` is empty and at least one card is shown.

| Report field | Meaning | Fix |
|---|---|---|
| `problems[]` | Blocking issues | Do what each says, run the doctor again. |
| `hints[]` | Non-blocking notes (skipped folders or notes, notes outside the filter, loose `.md` files, no transcripts, port used by another program) | Read them; fix the ones that matter to the owner. |
| `filteredOut` | Notes that do not match `cards.filter` | Check the number makes sense. |
| `cards[].status: "skipped"` + `reason` | A folder or note in `projectsDir` that is not shown | Fine if it is not a project. |
| `cards[].status: "error"` | A card that could not be read | Read `reason`. |
| `cards[].warnings[]` | Shown, but something is off | An owner stage word missing from `cards.stages` (the warning says which), invalid values, read-only fields or tasks, checkboxes outside the tasks heading, no repo (`repo: none` if there is none), mixed line endings. |
| `config.unknownKeys` | Typos in the config | Fix the key names. |
| `server.running` | A Projium with this `projectsDir` answers on the port | Start it (step 6). |
| `server.portBusy` | Something else answers on the port | Change `port`. |

`ok: true` means the setup works. It does not know which projects the owner has: compare `cards[]` with your list from step 2 yourself.

## 6. Run it

```
npm run --silent start:bg
```

Starts the server detached (logs `server.out.log` and `server.err.log` next to the database, `data/` by default), waits until it answers and prints `{ "ok": true, "url", "pid" }`. Running it again while the server is up prints `already: true` (with a `note` if the running server is an older version: stop and start it). Stop it with `npm run --silent stop`, which stops only a Projium serving the same projects folder. `npm start` runs it in the foreground instead.

If doctor shows `server.legacy: true`, an older Projium (before `/api/meta`) holds the port: end its `node server.mjs` process by hand, once, then use `start:bg`.

Check: `npm run --silent doctor` shows `server.running: true`, and `GET <server.url>/api/projects` returns the cards. Open `server.url` for the owner. If the server is gone after your session ends (some agent harnesses kill every process they started), use autostart below or ask the owner to run `npm run start:bg` once.

Autostart, only with the owner's yes: on Windows, a shortcut in `shell:startup` to `wscript.exe "<Projium>\autostart.vbs"` (runs hidden, logs in `data\`). On macOS or Linux, a launchd agent or a systemd user service that runs `node --no-warnings server.mjs` in the Projium folder.

## 7. Optional extras

- **Daily digest:** Telegram (`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env.local`) or any command (`digest.command` in the config; the text is appended as the last argument; list the environment variables it needs in `digest.env`, because `start:bg` passes the server a filtered environment). Preview at `<server.url>/api/digest` before turning it on.
- **Readiness:** a `READINESS.md` next to a card with `audit_commit:` and `Ready: X of Y`. Projium shows whether the code changed after that commit.
- **Time split:** automatic for repos built with Claude Code when `transcriptsDir` is right.

## 8. Report to the owner

Tell them:
- the URL;
- how many projects are shown, and which notes you treated as non-projects;
- every file you created or changed (with the config approach, usually none), and how to undo it;
- the `cards` mapping you chose, and that changing a stage or a mapped field in the dashboard writes into their own notes, in their own keys and words;
- your judgment calls: field and stage mappings, assumed years, approximated times;
- which projects have no repo;
- how to stop it (`npm run --silent stop`) and remove it (delete the Projium folder, and the autostart entry if you added one).

## Working with Projium day to day

- Once the owner has approved it, agents can edit cards directly as files; the dashboard re-reads them on every request. Keep the task line format and the card's existing line endings (a card mixing CRLF and LF cannot be written by the dashboard).
- Or use the HTTP API ([docs/api.md](docs/api.md)), which refuses to overwrite a field or task that changed since you read it, and creates task ids for you.

## Changing Projium's code

- No dependencies: Node built-ins only (`node:http`, `node:sqlite`, `node:test`). Plain JS UI in `public/`.
- `server.mjs`: HTTP server and background jobs. `lib/`: card parsing and writing (`card.mjs`, `store.mjs`), config (`config.mjs`), repo and audit checks (`repo.mjs`), site checks (`health.mjs`, `prod.mjs`, `net.mjs`), time split (`timesplit.mjs`), digest (`digest.mjs`), doctor, init and start/stop (`doctor.mjs`, `init.mjs`, `control.mjs`). `scripts/`: command entry points. `test/`: `node:test` suites.
- `npm test` must pass. No comments in code. Keep every guarantee in the README's "Privacy and safety" section.
