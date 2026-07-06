Search the workspace structure to find relevant files and code identifiers matching a natural-language intent.

Use SearchWorkspace when you need to discover which files are most relevant to a task before reading them. The tool scores files by matching the intent against paths, filenames, and code identifiers (exports, classes, functions, etc.) inside text files. Results are returned as a compact tree with identifier tags.

Good intents:
- `authentication middleware` — finds files whose paths/names or exported identifiers match "auth"
- `database connection pool` — locates connection setup code
- `error handling middleware` — discovers error-related modules

The tool skips binary files and very large files (>100KB) to stay fast. Recently modified files receive a relevance boost.
