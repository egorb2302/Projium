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

Check: the summary at the end says `ℹ fail 0`. Some tests print failure-looking log lines (for example `streak failed`) on purpose; only the summary counts. No `npm install` is needed.

If a `tracker.config.json` already exists in the folder, Projium is set up already: run `npm run --silent doctor` (step 5) and fix what it reports instead of starting over.

## 2. Turn the owner's notes into cards

Projium reads `<projectsDir>/<name>/<name>.md`: a folder per project and a card named like its folder.

**Find the projects.** Ask the owner where their project notes live if you cannot see it. Open a few. A note is a project when it describes one piece of work with a status (frontmatter like `type: project` or `status:`, a projects or clients folder). Inboxes, daily notes, meeting notes and references are not. When unsure, ask, or leave it out and list it in your report.

**Choose a layout:**

| What you see | What to do |
|---|---|
| One folder per project, with a note named like the folder | Use that folder as `projectsDir`. Add `stage:` to each note's frontmatter, with the owner's yes. |
| One note per project in one folder, or projects spread across notes, a database or a list | Create a new folder (for example `<vault>/Projium/`) with one card per project, owner's yes first. Cards are new files; the source notes stay as they are. |

**Map the fields.** Fill only what you can source; leave a field out rather than guess.

| In the owner's note | In the card |
|---|---|
| Status words | `stage`: active work → `development`; waiting for review, a client or feedback → `review`; fixing after review → `fixes`; shipped, closed, paused for good → `done`. Copy the owner's own wording into `status`. |
| What happens next | `next_step` (one line). Leave it out if the note does not say. |
| When the work or brief started | `spec_at` |
| Design approved | `design_pick_at` |
| First deploy, first push, first version live | `first_push_at` |
| Launch on the real network or production release | `mainnet_at` |
| Handed over, accepted, by whom | `handed_over_at`, `accepted_at`, `accepted_by` |
| A production URL | `site` (ask first, see ground rules) |
| A repo path or name, in any form (`~/code/x`, "Repo: x", a link) | `repo`, relative to `reposDir` or absolute; `~` works. `repo: none` for a project without code. |
| Deadline, client, budget, anything else | The card body, as text. A deadline can also be a task's `due`. |

Times are `YYYY-MM-DDTHH:MM` in the owner's time zone (step 4); dates are `YYYY-MM-DD`. A date without a year: use the year the note was written in and say so in the card's `## Timeline` table (Accuracy column) and in your report. Record where each time came from in that table.

**Tasks.** One per line under `## Tasks`:

```
- [ ] Checkout page · due 2026-11-08 · p1 ^t-a1b2
```

The separator is ` · ` (space, U+00B7 middle dot, space). `due` and the priority (`p1`, `p2`, `p3`) are optional. `^t-` plus four lowercase letters or digits is the task id, unique within the card. Write the file with a file-writing tool, not through a shell that may mangle non-ASCII characters. Tasks without a valid id still show, but read-only; the doctor counts them.

**Link back.** Put the source note's path in the card body with a full vault path, because the card and the note often share a name: `Source note: [[Work/Clients/Acme Shop|Acme Shop]]`. Template: [docs/card-template.md](docs/card-template.md).

**One place of truth.** After you create cards, tell the owner that status and tasks now live in the cards, and offer to add a link to the card in each source note. That is an edit to their notes: only with a yes.

## 3. Find the repos

Find the folder where the owner clones project repos: that is `reposDir`. A card is matched to `<reposDir>/<card name>` unless it sets `repo`. Projects without code: `repo: none`.

## 4. Write the config

Pick a port: 3210 by default. If it is taken (`npm run --silent doctor` later shows `server.portBusy`, or the server says the port is in use), pass another one.

```
npm run --silent init -- --projects "<absolute projectsDir>" --repos "<absolute reposDir>" --offset=+03:00
```

- `--offset` is the owner's UTC offset for the times in cards. Ask, or take it from their clock; set it explicitly where daylight saving applies. Keep the `=` form: `--offset -05:00` with a space is rejected, `--offset=-05:00` works.
- `--transcripts "<folder>"` when Claude Code transcripts are not in `~/.claude/projects` of the user running Projium.
- Also: `--port`, `--readiness`, `--lang en|ru`, `--ignore word1,word2` (projects whose name or repo path contains a word: no repo reads, no site checks), `--force` (replaces an existing config with only these flags; the old file is kept as `tracker.config.json.bak`).

It prints `{ "ok": true, "written": ... }` or `{ "ok": false, "error": ... }`. All config keys: [tracker.config.schema.json](tracker.config.schema.json). `PORT` in the environment or in `.env.local` overrides the config's `port`.

## 5. Check with the doctor

```
npm run --silent doctor
```

It exits 0 with `ok: true` when `problems` is empty and at least one card is shown.

| Report field | Meaning | Fix |
|---|---|---|
| `problems[]` | Blocking issues | Do what each says, run the doctor again. |
| `hints[]` | Non-blocking notes (skipped folders, loose `.md` files, no transcripts, port used by another program) | Read them; fix the ones that matter to the owner. |
| `cards[].status: "skipped"` + `reason` | A folder in `projectsDir` that is not shown | Fine if it is not a project. |
| `cards[].status: "error"` | A card that could not be read | Read `reason`. |
| `cards[].warnings[]` | Shown, but something is off | Invalid values, read-only fields or tasks, no repo (use `repo: none` if there is none), mixed line endings. |
| `config.unknownKeys` | Typos in the config | Fix the key names. |
| `server.running` | A Projium with this `projectsDir` answers on the port | Start it (step 6). |
| `server.portBusy` | Something else answers on the port | Change `port`. |

`ok: true` means the setup works. It does not know which projects the owner has: compare `cards[]` with your list from step 2 yourself.

## 6. Run it

```
npm run --silent start:bg
```

Starts the server detached (logs in `data/server.out.log` and `data/server.err.log`), waits until it answers and prints `{ "ok": true, "url", "pid" }`. Running it again while the server is up prints `already: true`. Stop it with `npm run --silent stop`, which stops only the Projium that serves this config. `npm start` runs it in the foreground instead.

Check: `npm run --silent doctor` shows `server.running: true`, and `GET <server.url>/api/projects` returns the cards. Open `server.url` for the owner.

Autostart, only with the owner's yes: on Windows, a shortcut in `shell:startup` to `wscript.exe "<Projium>\autostart.vbs"` (runs hidden, logs in `data\`). On macOS or Linux, a launchd agent or a systemd user service that runs `node --no-warnings server.mjs` in the Projium folder.

## 7. Optional extras

- **Daily digest:** Telegram (`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env.local`) or any command (`digest.command` in the config; the text is appended as the last argument). Preview at `<server.url>/api/digest` before turning it on.
- **Readiness:** a `READINESS.md` next to a card with `audit_commit:` and `Ready: X of Y`. Projium shows whether the code changed after that commit.
- **Time split:** automatic for repos built with Claude Code when `transcriptsDir` is right.

## 8. Report to the owner

Tell them:
- the URL;
- how many projects are shown, and which notes you treated as non-projects;
- every file you created or changed, and the folder to delete to undo it;
- your judgment calls: field mappings, assumed years, approximated times;
- which projects have no repo;
- how to stop it (`npm run --silent stop`) and remove it (delete the Projium folder, and the autostart entry if you added one).

## Working with Projium day to day

- Once the owner has approved it, agents can edit cards directly as files; the dashboard re-reads them on every request. Keep the task line format and the card's existing line endings (a card mixing CRLF and LF cannot be written by the dashboard).
- Or use the HTTP API ([docs/api.md](docs/api.md)), which refuses to overwrite a field or task that changed since you read it, and creates task ids for you.

## Changing Projium's code

- No dependencies: Node built-ins only (`node:http`, `node:sqlite`, `node:test`). Plain JS UI in `public/`.
- `server.mjs`: HTTP server and background jobs. `lib/`: card parsing and writing (`card.mjs`, `store.mjs`), config (`config.mjs`), repo and audit checks (`repo.mjs`), site checks (`health.mjs`, `prod.mjs`, `net.mjs`), time split (`timesplit.mjs`), digest (`digest.mjs`), doctor, init and start/stop (`doctor.mjs`, `init.mjs`, `control.mjs`). `scripts/`: command entry points. `test/`: `node:test` suites.
- `npm test` must pass. No comments in code. Keep every guarantee in the README's "Privacy and safety" section.
