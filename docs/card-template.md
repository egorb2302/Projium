# Card template

Copy into `<projectsDir>/<name>/<name>.md`, replace the values and delete the lines you cannot fill. Only `stage` is required. Field rules: [card-format.md](card-format.md).

```markdown
---
stage: development
status: "one line on where the project is"
next_step: "the next concrete action"
site: "https://example.com"
repo: "folder-in-reposDir"
spec_at: 2026-11-01T10:00
design_pick_at:
first_push_at:
mainnet_at:
handed_over_at:
accepted_at:
accepted_by:
---

# name

Source note: [[link to the owner's original note]]

## Tasks

- [ ] First task · due 2026-11-03 · p1 ^t-a1b2

## Updates

## Timeline

| Milestone | Time | Source | Accuracy |
|---|---|---|---|
| Spec received | 2026-11-01 10:00 | chat | exact |
```

Task ids are `^t-` plus four lowercase letters or digits, unique within the card. Tasks added from the dashboard or the API get one automatically.
