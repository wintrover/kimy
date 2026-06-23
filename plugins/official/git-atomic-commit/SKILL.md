---
name: git-atomic-commit
description: |
  Create atomic git commits with Conventional Commits format.
  Use this plugin when you need to stage specific files and commit them in a
  single atomic operation with a properly formatted commit message.
---

# git-atomic-commit

## Usage

Call the tool `atomic_commit` with a JSON payload via stdin:

```json
{
  "message": "feat: add user authentication module",
  "files": ["src/auth.ts", "src/auth.test.ts"]
}
```

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | yes | Commit message in Conventional Commits format |
| `files` | array of strings | no | Files to stage before committing |

## Behavior

1. Stages each file listed in `files` (via `git add`).
2. Prints a `git diff --cached --stat` summary.
3. Creates a single commit with the given `message`.

## Examples

- `{"message": "fix: resolve null pointer in parser", "files": ["src/parser.ts"]}`
- `{"message": "chore: update dependencies", "files": ["package.json", "pnpm-lock.yaml"]}`
