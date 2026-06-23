---
name: git-sync
description: |
  Two-Phase Rebase-Forward Sync for deterministic branch synchronization.
  Use this plugin to keep a feature branch up-to-date with a base branch by
  rebasing, then fast-forwarding the base so both refs are identical.
---

# git-sync

## Usage

Call the tool `sync_branch` with a JSON payload via stdin:

```json
{
  "base": "main",
  "secondary": "feature"
}
```

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `base` | string | yes | Base branch to fast-forward (e.g., `main`) |
| `secondary` | string | yes | Feature branch to rebase onto base |

## Behavior

1. **Detect order**: Automatically determines which branch is the ancestor via `git merge-base`. Swaps if needed.
2. **Snapshot**: Creates a backup branch before any destructive operation.
3. **Phase 1 — Rebase**: Rebases `secondary` onto `base`.
4. **Phase 2 — Fast-forward**: Checks out `base` and fast-forward merges `secondary` into it.
5. **Verify**: Confirms both refs point to the same commit.
6. **Push**: Pushes both branches to origin (force-with-lease for secondary).

## Options

| Flag | Description |
|------|-------------|
| `--auto-rebase` | Automatically rebase on divergence without prompting |
| `--dry-run` | Preview the sync plan without making changes |
| `--continue` | Resume an in-progress rebase |

## Safety Features

- **Dirty worktree check**: Refuses to sync with uncommitted changes.
- **Backup branch**: Creates `sync-backup-<branch>-<timestamp>` before rebasing.
- **Auto-detect order**: Determines base/secondary relationship via merge-base.
- **Divergence warning**: Warns when branches have diverged and requires `--auto-rebase` to proceed.

## Examples

- `{"base": "main", "secondary": "feature/auth"}` — sync feature branch
- `{"base": "main", "secondary": "release/v2"}` — sync release branch
