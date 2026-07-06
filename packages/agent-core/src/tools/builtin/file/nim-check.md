Run `nim check` on a Nim source file in an isolated temporary directory, returning structured compilation diagnostics.

The tool copies the target file into a temp directory before checking, so no writes occur in the main repository. This is safe to run on any file.

Output is a JSON array of diagnostics. Each entry has `line`, `column`, `severity` (`"Error" | "Warning" | "Note"`), `message`, and optional `hint`.

When `--ic:on` is passed, incremental compilation is enabled for NIF generation.

If `nim` is not on PATH, the tool returns an error with installation guidance.
