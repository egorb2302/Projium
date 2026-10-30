# AGENTS.md: setting up Projium for your owner

You are an AI agent and your owner asked you to install Projium and connect it to their project notes. This file is your playbook. Follow it in order; every step ends in a check you can run.

Projium is a local dashboard (Node 24, no dependencies) over Markdown project cards: one card per project with a YAML frontmatter `stage`, optional tasks, milestone times, a repo, a live site. It runs on `127.0.0.1` only. Card format: [docs/card-format.md](docs/card-format.md). HTTP API for agents: [docs/api.md](docs/api.md).

## Ground rules

- Read the owner's notes freely, but **do not edit, move or rename an existing note without the owner's explicit yes**. Creating new files in a new folder also needs a yes, once, for the folder.
- Before writing to a card, make sure the owner can undo it: the notes folder is under git or a sync with history, or you keep a copy.
- Secrets: a Telegram bot token goes only into `.env.local` in the Projium folder (git-ignored), and only if the owner gives it to you. Never put secrets in `tracker.config.json` or in cards.
- Ask before you set up autostart, the daily digest, or the `streak` option. Leave `streak` off unless the owner names it.
- Keep the server on `127.0.0.1`. Do not open it to the network or tunnel it without the owner's yes.
- Never copy text from Claude Code transcripts anywhere. Projium only reads their timestamps.

## 1. Install

Needs Node.js 24+ and git (`node -v`, `git --version`).

```
git clone https://github.com/egorb2302/Projium.git
cd Projium
npm test
```

Check: `npm test` ends with `fail 0`. No `npm install` is needed.

## 2. Find the owner's project notes

Ask the owner where they keep notes about their projects if you cannot see it. Open two or three of those notes and decide which case applies:

| What you see | What to do |
|---|---|
| One folder per project, with a note named like the folder (`Projects/alpha/alpha.md`) | Use that folder as `projectsDir`. Add `stage:` to each note's frontmatter, with the owner's yes. |
| One note per project, all in one folder (`Projects/alpha.md`) | Projium does not read that layout yet. Create a separate cards folder (for example `<vault>/Projium/alpha/alpha.md`), one card per project, and put a link back to the source note in each card body. Owner's yes first. |
| Projects spread across notes, a database, a tracker or a list | Same as above: generate cards in a new folder from what you find, owner's yes first. |

Map the owner's status words to `stage`: active work → `development`, waiting for review or a client → `review`, fixing after review → `fixes`, shipped or closed → `done`. Use [docs/card-template.md](docs/card-template.md) for new cards. Fill only fields you can source; leave the rest out.

## 3. Find the repos

Find the folder where the owner clones project repos. A card is matched to `<reposDir>/<card name>` by folder name; when names differ, set `repo: "relative/or/absolute/path"` in the card's frontmatter.

## 4. Write the config

```
npm run init -- --projects "<projectsDir>" --repos "<reposDir>" --offset=+03:00
```

`--offset` is the owner's UTC offset for the times written in cards (ask, or take it from their clock; set it explicitly where daylight saving applies). Keep the `=` form: `--offset -05:00` with a space is rejected, `--offset=-05:00` works. Other options: `--transcripts`, `--readiness`, `--lang en|ru`, `--port`, `--ignore word1,word2`, `--force`. It prints JSON with `ok` and the written path. All keys: [tracker.config.schema.json](tracker.config.schema.json).

Use `--ignore` for projects the owner wants hidden from site checks and repo reads (a word matched against the project name and repo path).

## 5. Check with the doctor

```
npm run doctor
```

It prints a JSON report and exits 0 only when the setup is complete. Fix things until `ok` is `true`:

| Report field | Meaning | Fix |
|---|---|---|
| `problems[]` | Setup-level issues, in plain words | Do what each says. |
| `cards[].status: "skipped"` + `reason` | A folder in `projectsDir` that is not shown | No `<name>/<name>.md`, no frontmatter, no `stage`, or an unsupported folder name. |
| `cards[].status: "error"` | A card that could not be read | Read `reason`. |
| `cards[].warnings[]` | Shown, but something is off | Invalid field values, read-only fields or tasks, no repo found. |
| `config.unknownKeys` | Typos in the config | Fix the key names. |
| `looseNotes` | `.md` files directly in `projectsDir` | They are not read; see step 2. |
| `server.running` | Whether a Projium server answers on the port | Start it (step 6). |

Every project the owner cares about should appear with `status: "ok"`. Warnings like "no git repo found" are fine for projects without code.

## 6. Run it

```
npm start
```

Leave it running in the background, then check `http://127.0.0.1:3210/api/projects` returns the cards (send `Host: 127.0.0.1:3210`; curl does that by default). Open `http://127.0.0.1:3210` for the owner. A second `npm run doctor` shows `server.running: true`.

Autostart, only with the owner's yes: on Windows, a shortcut in `shell:startup` to `wscript.exe "<Projium>\autostart.vbs"` (runs hidden, logs in `data\`). On macOS or Linux, a launchd agent or a systemd user service running `node --no-warnings server.mjs` in the Projium folder.

## 7. Optional extras

- **Daily digest:** Telegram (`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env.local`) or any command (`digest.command` in the config; the text is appended as the last argument). Preview at `/api/digest` before turning it on.
- **Readiness:** a `READINESS.md` next to a card with `audit_commit:` and `Ready: X of Y`. Projium shows whether the code changed after that commit.
- **Time split:** works automatically for repos built with Claude Code (transcripts in `~/.claude/projects`).

## 8. Report to the owner

Tell them: the URL, how many projects are shown, what you created or changed in their notes (file list), which projects have no repo, and how to stop or remove Projium (stop the `node server.mjs` process, delete the folder, remove the autostart entry if you added one).

## Working with Projium day to day

- Agents can edit cards directly as files; the dashboard re-reads them on every request. Keep the task line format `- [ ] text · due YYYY-MM-DD · p1 ^t-xxxx`.
- Or use the HTTP API ([docs/api.md](docs/api.md)), which refuses to overwrite a field that changed since you read it.
- Times in cards are `YYYY-MM-DDTHH:MM` in the configured `utcOffset`.

## Changing Projium's code

- No dependencies: Node built-ins only (`node:http`, `node:sqlite`, `node:test`). Plain JS UI in `public/`.
- `server.mjs`: HTTP server and background jobs. `lib/`: card parsing and writing (`card.mjs`, `store.mjs`), config (`config.mjs`), repo and audit checks (`repo.mjs`), site checks (`health.mjs`, `prod.mjs`, `net.mjs`), time split (`timesplit.mjs`), digest (`digest.mjs`), doctor and init (`doctor.mjs`, `init.mjs`). `test/`: `node:test` suites.
- `npm test` must pass. No comments in code. Keep every privacy guarantee in the README's "Privacy and safety" section.
