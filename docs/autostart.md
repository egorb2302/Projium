# Autostart

Start the dashboard server at login, so it is back after a restart. `npm run --silent autostart` prints the exact plan for this computer's OS; the owner's agent applies it. The helper writes nothing.

## Steps

1. **Ask the owner first.** Say what it adds: one file (macOS: a launchd agent; Linux: a systemd user service; Windows: a shortcut in the Startup folder), that it starts the server at login, and that it can be removed (below). Continue only on a yes.
2. **Get the plan:** `npm run --silent autostart`. JSON on stdout, exit code 0 when `ok`, else 1 with `error`. `--platform=darwin|linux|win32` previews another OS (paths are from this machine, so never apply a preview).

   | Key | Content |
   |---|---|
   | `kind`, `label` | `launchd` / `systemd` / `startup-shortcut` and the entry's name. It includes an id of the projects folder, so two Projium installs never collide. |
   | `file` | Where the entry lives. |
   | `content` | The file's text (macOS, Linux). `null` on Windows: the shortcut is made by the `enable` command. |
   | `enable`, `disable`, `check` | Commands, run in order. macOS and Linux: a shell. Windows: Windows PowerShell. |
   | `logs` | Where the server's output goes: `out`, `err`. |
   | `notes` | Read them; they carry the caveats for this OS. |

3. **Stop a running server** with `npm run --silent stop`. On macOS and Linux enabling starts the server at once, and a second one on the same port fails and is retried.
4. **Apply.**
   - macOS, Linux: create the folder of `file` if it is missing, write `content` to `file` exactly as given (Write tool, no shell redirection), then run the `enable` commands in order.
   - Windows: run the one `enable` command in PowerShell. The shortcut starts the server at the next login; run `npm run --silent start:bg` for now.
5. **Verify.** Run the `check` command (macOS: the agent is listed and running; Linux: `Active: active (running)`; Windows: `True`), then `npm run --silent doctor` and look for `server.running: true`. If it fails, read the `logs` files and the error, fix the entry, and do not improvise a different mechanism.
6. **Tell the owner** the `file` you created, the logs, how to stop the server for a session (`npm run --silent stop`; the entry starts it again at the next login) and how to remove it.

## Remove

Run the `disable` commands in order. They stop the service, delete the entry's file (Windows: the shortcut) and, on Linux, reload systemd. The Projium folder and its data stay.

## Things to know

- A clean `npm run --silent stop` does not restart the server (macOS `KeepAlive` with `SuccessfulExit` false, Linux `Restart=on-failure`); a crash does.
- macOS and Linux entries pin the `node` that ran the helper. After switching or upgrading node, run the helper again and replace the entry: disable, write, enable. On Windows, `autostart.vbs` starts `node` from PATH at login and writes `data\out.log` and `data\err.log` (not the `server.out.log` and `server.err.log` of `start:bg`).
- macOS and Linux entries pass `TRACKER_CONFIG` when the config file is not `tracker.config.json` in the Projium folder. Windows cannot: `autostart.vbs` always uses the default config, so the helper answers `ok: false` there.
- The entry sets only `PATH` (and `TRACKER_CONFIG`). Variables listed in `digest.env` are not copied (they may be secrets); add them to the entry only if the digest command needs them and the owner agrees.
- Linux: a user service runs while the owner has a login session. `loginctl enable-linger $USER` keeps it running without one and starts it at boot. Run it only if the owner says yes. `StandardOutput=append:` needs systemd 240 or newer.
- macOS: `launchctl bootstrap gui/<uid>` needs the owner logged in at the desktop. To replace a loaded entry, run `disable` first.

## What is verified

`test/autostart.test.mjs` checks the generated plist, unit and PowerShell strings on paths with spaces, `&`, `'`, `%` and `$`, and the plist and PowerShell output were parsed with real XML and PowerShell parsers. The launchd and systemd entries were checked against Apple's launchd.plist(5) and launchctl(1) pages and the systemd man pages, and by unit tests only. They were not run on a real Mac or Linux box.
