# Launch Watch

Launch Watch checks what you have live and tells you when it breaks: sites and their TLS certificates, a heartbeat your backend publishes as JSON, and the balance of wallets your keepers spend from. It sends one message when an incident opens and one when it recovers, keeps the incident history in `data/tracker.db`, and shows everything on the **Watch** page (key `3`).

Targets come from the `watch` block of `tracker.config.json`, not from the cards, so a project marked `done` that is still live stays watched. Nothing is written into your notes.

## Config

```json
{
  "watch": {
    "every": 5,
    "failAfter": 2,
    "recoverAfter": 2,
    "rpc": { "solanaEnv": "SOLANA_RPC_URL" },
    "targets": [
      { "name": "shop", "kind": "site", "url": "https://shop.example", "project": "shop" },
      { "name": "shop-keeper", "kind": "heartbeat", "url": "https://shop.example/api/health", "project": "shop",
        "field": "lastCycleAt", "maxAgeMin": 20, "activeWhen": { "payoutsLive": true }, "max": { "stuckOps": 0 } },
      { "name": "shop-treasury", "kind": "balance", "address": "<public Solana address>", "min": 0.05, "project": "shop" },
      { "name": "bsc-keeper", "kind": "balance", "chain": "evm", "address": "0x…", "min": 0.02, "unit": "BNB", "rpcEnv": "BSC_RPC_URL" }
    ]
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `every` | `5` | Minutes between check rounds (1 to 1440). Each round makes one request per site, heartbeat and wallet, so 5 minutes stays polite to a public RPC. |
| `failAfter` | `2` | Failed checks in a row before an incident opens. |
| `recoverAfter` | `2` | Good checks in a row before it closes. |
| `lang` | `digest.lang` | `en` or `ru` for the alert text. |
| `command` | the digest channel | Command that sends alerts, like `digest.command`: the text is appended as the last argument. Without it, alerts go where the digest goes (`digest.command`, or `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env.local`). With neither, incidents show on the dashboard only. |
| `env` | `[]` | Environment variable names the alert command needs (passed by `start:bg`, like `digest.env`). |
| `rpc.solana` | `https://api.mainnet-beta.solana.com` | Solana JSON-RPC URL for balances. |
| `rpc.solanaEnv` | none | Name of an environment variable (or `.env.local` key) holding a Solana RPC URL, for a keyed RPC. Used when it is set; otherwise `rpc.solana` or the public RPC. |
| `targets` | `[]` | What to check, below. |

Every target has a unique `name` (shown in alerts), a `kind`, and optionally `project` (a card name: alerts link to that project page, and the page shows the target), `failAfter` and `recoverAfter`.

### `site`

`url` (http or https) answers with a status below 400. Redirects are not followed, so a redirect counts as up. With https, the certificate is read too: `certDays` (default `14`, `0` turns it off) is how many days before expiry the certificate check fails. It is its own incident, next to the site's.

### `heartbeat`

`url` returns a JSON object (at most 512 KB).

- `field` and `maxAgeMin`: the key holding the time of the last beat (epoch milliseconds or seconds, or an ISO date; a dotted path like `keeper.lastRun` reads nested keys) and how many minutes old it may be. Its age is measured against the answer's `Date` header, so a wrong clock on your computer does not matter.
- `activeWhen`: the age is only checked while these keys hold these values, like `{ "payoutsLive": true }`; otherwise the beat counts as fine.
- `max`: numbers that must not go over a limit at any time, like `{ "stuckOps": 0 }`.

A non-200 answer, a body that is not JSON, a missing time or a missing number fail the check.

### `balance`

`address` is a public wallet address, `min` the balance to alert below, in whole coins (SOL, ETH).

- `chain`: `solana` (default, `getBalance` at `confirmed`) or `evm` (`eth_getBalance` at `latest`, with `unit` for the coin name, default `ETH`).
- An EVM target needs `rpc` (a JSON-RPC URL) or `rpcEnv` (the variable that holds it). A Solana target can set them too, to override `watch.rpc`.

A keyed RPC URL is a secret: put it in `.env.local` or the environment and name the variable in `rpcEnv` or `rpc.solanaEnv`. Projium never shows or logs RPC URLs, keeps only error codes from failed RPC calls, and `start:bg` passes these variables to the server.

An RPC that fails or answers with an error is "unknown": it neither opens nor closes an incident.

## Incidents and alerts

- An incident opens after `failAfter` failed checks in a row and closes after `recoverAfter` good ones. "Unknown" results (a certificate that could not be read, an RPC error) do not count either way.
- One message when it opens, one when it recovers (with how long it lasted), none while it stays open. Incidents that start or end in the same round share one message. A message that fails to send is retried every round.
- A round in which no target answers at all, across two or more hosts, is taken as your own network being down (sleep, Wi-Fi) and counts nothing.
- **Mute** a target from the Watch page or `POST /api/watch/mute` until a time (at most 30 days ahead). It is still checked and its incidents are recorded; messages wait until the mute ends. An incident that is still open then is sent; one that recovered meanwhile sends nothing.
- A target removed from the config closes its open incident without a message. Closed incidents are kept for a year.

Alert example (`lang: "ru"`):

```
Сбой: shop-treasury · баланс
0.012 SOL (порог 0.05)
http://127.0.0.1:3210/#/p/shop
```

## API

`GET /api/watch`, `POST /api/watch/check`, `POST /api/watch/mute`: see [api.md](api.md#watch). Each card in `GET /api/projects` carries `watch` (`{ open, targets }`, or `null` when no target names it); `GET /api/projects/<name>` has the targets in full.

## Check it

`npm run --silent doctor` shows `config.watch` (targets, interval, alert channel, where each wallet's RPC comes from) and hints for a missing RPC variable or a `project` with no card. On the Watch page, **Check now** runs a round at once.
