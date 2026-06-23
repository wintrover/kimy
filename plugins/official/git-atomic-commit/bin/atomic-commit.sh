#!/bin/bash
# Atomic git commit with Conventional Commits format
# Reads parameters from stdin as JSON: {"message": "...", "files": ["..."]}
#
# This is a universal plugin ported from the Axiom project.
# Axiom-specific wrappers (axiom-launch, bin/git-commit-atomic) have been
# removed; the script is now self-contained.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
cd "$REPO_ROOT"

python3 -c "
import sys, json, subprocess

d = json.load(sys.stdin)
message = d.get('message', '')
files = d.get('files', [])

if not message:
    print('ERROR: message is required', file=sys.stderr)
    sys.exit(1)

for f in files:
    subprocess.run(['git', 'add', f], check=True)

print('=== Staged changes ===')
subprocess.run(['git', 'diff', '--cached', '--stat'])

print('')
print('=== Committing ===')
subprocess.run(['git', 'commit', '-m', message], check=True)
"
