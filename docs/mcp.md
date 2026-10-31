# MCP server

`scripts/mcp.mjs` is an [MCP](https://modelcontextprotocol.io) server over stdio, so the owner's agents (Claude Code, Codex, Claude Desktop, Cursor and other MCP clients) can read and update projects from their own session. It needs no packages: Node built-ins only.

It is a thin client of the running dashboard: every call goes to the local [HTTP API](api.md) of the Projium in this folder, so reads and writes follow the same rules (one field or task line per write, `expected` and `fileId` checks, the YAML check before and after). Projium itself must run (`npm run --silent start:bg` or autostart); otherwise every tool answers with an error that says how to start it.

## Check it

```
node scripts/mcp.mjs --check
```

Prints JSON: `ok`, the dashboard URL, the tools, the number of projects it sees, and ready-made registration snippets with this folder's absolute paths (`register.claudeCode`, `register.json`). `ok: false` comes with an `error` (most often: Projium is not running).

## Register it

Ask the owner first: the tools can write into their notes.

Claude Code (all projects of this user):

```
claude mcp add --transport stdio --scope user projium -- node --no-warnings /path/to/Projium/scripts/mcp.mjs
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.projium]
command = "node"
args = ["--no-warnings", "/path/to/Projium/scripts/mcp.mjs"]
```

Clients that read an `mcpServers` JSON (Claude Desktop, Cursor, a project `.mcp.json`):

```json
{ "mcpServers": { "projium": { "type": "stdio", "command": "node", "args": ["--no-warnings", "/path/to/Projium/scripts/mcp.mjs"] } } }
```

Use absolute paths; on Windows forward slashes work (`D:/tools/Projium/scripts/mcp.mjs`). When `node` is not on the client's PATH, use the full path that `--check` prints. A non-default config file is passed with `TRACKER_CONFIG` in the server's environment, as for the other commands. Start a new client session afterwards; most clients read MCP servers at startup.

## Tools

| Tool | Does | Writes |
|---|---|---|
| `list_projects` | Every project: stage, next step, open tasks, earliest due date, site state, audit freshness, readiness. `stage` filters; ignored projects only with `include_ignored`. | no |
| `get_project` | One project in full, as `GET /api/projects/<name>` returns it (without the uptime history), including `fileId`, `locked` fields and task ids. | no |
| `set_field` | One field (`stage`, `next_step`, `site`, `accepted_by`, dates and milestone times), with `expected` and `fileId`. | the note |
| `add_task` | An open task with optional `due` and `p`; the id is created. | the note |
| `toggle_task` | Checks or unchecks a task, with `expected` (the task as read). | the note |
| `edit_task` | Text, due date or priority of a task; left-out fields stay. | the note |
| `refresh_project` | Re-reads git, the audit, the live site config and the build time for one project. | no (makes the site check's network calls) |
| `digest_preview` | The digest text as it would be sent now. Sends nothing. | no |
| `doctor` | The doctor report. | no |

Writes: read with `get_project` first and pass `fileId` and the values exactly as read. A field or task that changed since then comes back as a tool error with the current value (`structuredContent.current`); read again rather than retrying blindly. Locked fields and invalid values come back as tool errors with the reason.

## Protocol

Both eras of MCP over stdio, one JSON message per line:

- `initialize` / `notifications/initialized` with protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`;
- the stateless `2026-07-28` revision: `server/discover`, and the version in each request's `_meta` (an unsupported one gets error `-32022` with the supported list).

Capabilities: `tools` only. Logs go to stderr; stdout carries only protocol messages.
