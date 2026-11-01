# Card template

Save as `<projectsDir>/<name>/<name>.md`. Only `stage` is required; keep the lines you can fill and delete the rest. Field rules: [card-format.md](card-format.md).

```markdown
---
stage: development
status: ""
next_step: ""
repo: ""
spec_at:
design_pick_at:
first_push_at:
mainnet_at:
handed_over_at:
accepted_at:
accepted_by: ""
---

# name

Source note: [[full/vault/path/to/the source note|name]]

## Tasks

## Updates

## Timeline

| Milestone | Time | Source | Accuracy |
|---|---|---|---|
```

| Field | Fill with |
|---|---|
| `stage` | `development`, `review`, `fixes` or `done`. |
| `status` | The owner's own words for where the project is. |
| `next_step` | The next concrete action, one line. |
| `repo` | Repo folder relative to `reposDir`, an absolute path, `~/...`, or `none`. Empty: the folder named like the card. |
| `spec_at` ... `mainnet_at` | `YYYY-MM-DDTHH:MM` in the configured UTC offset. |
| `handed_over_at`, `accepted_at` | `YYYY-MM-DD`. |
| `site` | Add `site: "https://domain"` only with the owner's yes: it turns on uptime checks. |

Task lines go under `## Tasks`:

```
- [ ] Checkout page · due 2026-11-08 · p1 ^t-a1b2
```

The separator is ` · ` (U+00B7 with a space on each side). Task ids are `^t-` plus four lowercase letters or digits, unique within the card; tasks added from the dashboard or the API get one automatically, and a task without one gets one the first time it is edited there. Timeline rows record where each time came from: `| Spec received | 2026-11-01 10:00 | source note | exact |`.
