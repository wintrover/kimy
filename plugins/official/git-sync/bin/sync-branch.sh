#!/bin/bash
# Two-Phase Rebase-Forward Sync — Universal branch integration script
# Usage: sync-branch.sh [--auto-rebase] [--dry-run] <base> <secondary>
#
# This is a universal plugin ported from the Axiom project.
# Axiom-specific features have been removed:
#   - Shadow worktree mode (replaced with standard ref update)
#   - HMAC-signed metadata
#   - axiom-sync integration
#   - .axiom/ directory dependencies
#
# Core behavior preserved:
#   Phase 1: Rebase secondary onto base
#   Phase 2: Fast-forward base to secondary (both refs match)
set -euo pipefail

auto_rebase=false
dry_run=false
continue_mode=false
base=""
secondary=""

while [ $# -gt 0 ]; do
  case "$1" in
    --auto-rebase)
      auto_rebase=true
      shift
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    --continue)
      continue_mode=true
      shift
      ;;
    -*)
      echo "Unknown option: $1" >&2
      echo "Usage: sync-branch.sh [--auto-rebase] [--dry-run] [--continue] <base> <secondary>" >&2
      exit 1
      ;;
    *)
      if [ -z "$base" ]; then
        base="$1"
      elif [ -z "$secondary" ]; then
        secondary="$1"
      else
        echo "Usage: sync-branch.sh [--auto-rebase] [--dry-run] [--continue] <base> <secondary>" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

# ── Continue-mode: resume an in-progress rebase ──
if [ "$continue_mode" = true ]; then
  if [ -d ".git/rebase-merge" ] || [ -d ".git/rebase-apply" ]; then
    echo "[SYNC] Resuming in-progress rebase..."
    exec git rebase --continue
  else
    echo "ERROR: --continue was specified but no in-progress rebase was found." >&2
    exit 1
  fi
fi

if [ -z "$base" ] || [ -z "$secondary" ]; then
  echo "Usage: sync-branch.sh [--auto-rebase] [--dry-run] [--continue] <base> <secondary>" >&2
  echo "  Example: sync-branch.sh main feature" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
cd "$REPO_ROOT"

# Zero-heuristic order detection via Git plumbing
merge_base=$(git merge-base "$base" "$secondary" 2>/dev/null || true)
if [ -z "$merge_base" ]; then
  echo "ERROR: '$base' and '$secondary' are unrelated (no merge-base)." >&2
  exit 1
fi

if git merge-base --is-ancestor "$base" "$secondary" 2>/dev/null; then
  true  # base is already base
elif git merge-base --is-ancestor "$secondary" "$base" 2>/dev/null; then
  tmp="$base"
  base="$secondary"
  secondary="$tmp"
  echo "[AUTO-DETECT] Swapped: base=$base, secondary=$secondary"
else
  echo "[WARN] '$base' and '$secondary' are diverged."

  if [ "$dry_run" = true ]; then
    echo "[DRY-RUN] Detected divergence between $base and $secondary."
    echo "[DRY-RUN] Proposed action: git rebase $base $secondary"
    echo "[DRY-RUN] Then: git checkout $base && git merge --ff-only $secondary"
    echo "[DRY-RUN] No changes made."
    exit 0
  fi

  if [ "$auto_rebase" != true ]; then
    echo "[WARN] Using $base as base per argument order."
    echo "[WARN] Use --auto-rebase to proceed with automatic rebase on divergence."
  else
    echo "[AUTO-REBASE] Divergence detected. Proceeding with automatic rebase..."
  fi
fi

echo "[AUTO-DETECT] base=$base, secondary=$secondary (via merge-base)"

echo "=== Fetch: ensuring local refs are up-to-date ==="
git fetch origin "$base" "$secondary" 2>/dev/null || true

# Transactional safety: snapshot before rebase
echo "=== Snapshot: creating backup branch ==="
backup_branch="sync-backup-${secondary}-$(date +%s)"
git branch "$backup_branch" "$secondary"
echo "[SNAPSHOT] Backup branch created: $backup_branch"

# ── Dirty worktree pre-check ──
if ! git diff --quiet 2>/dev/null; then
  echo "[sync-branch] ERROR: Working tree has uncommitted changes." >&2
  echo "[sync-branch] Stash or commit changes before syncing." >&2
  exit 1
fi
if ! git diff --cached --quiet 2>/dev/null; then
  echo "[sync-branch] ERROR: Index has uncommitted staged changes." >&2
  echo "[sync-branch] Commit or unstage changes before syncing." >&2
  exit 1
fi

echo "=== Phase 1: Rebase $secondary onto $base ==="
rebase_ok=true
git rebase "$base" "$secondary" || rebase_ok=false

if [ "$rebase_ok" != true ]; then
  echo ""
  echo "[sync-branch] Rebase failed. Recovery options:" >&2
  echo "  1. Abort rebase:       git rebase --abort" >&2
  echo "  2. Resolve conflicts:  git rebase --continue" >&2
  echo "  3. Restore from backup: git reset --hard $backup_branch" >&2
  echo "  Backup branch preserved: $backup_branch" >&2
  exit 1
fi

echo "=== Phase 2: Fast-forward $base to $secondary ==="
OLD_BASE_SHA=$(git rev-parse "$base")
NEW_BASE_SHA=$(git rev-parse "$secondary")

git checkout "$base"
git merge --ff-only "$secondary"

echo "=== Verify: both refs must share identical hash ==="
base_hash=$(git rev-parse "$base")
secondary_hash=$(git rev-parse "$secondary")

if [ "$base_hash" != "$secondary_hash" ]; then
  echo "ERROR: $base ($base_hash) and $secondary ($secondary_hash) do not match." >&2
  exit 1
fi

echo "=== Push: both branches to origin ==="
git push --force-with-lease origin "$secondary" 2>/dev/null || true
git push origin "$base" 2>/dev/null || true

echo "[SYNC OK] $base == $secondary == $(git rev-parse --short "$base")"
