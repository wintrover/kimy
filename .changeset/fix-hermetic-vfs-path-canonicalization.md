---
"@moonshot-ai/kimi-code": patch
---

Fix sub-agent file read failures on workspaces with non-ASCII paths by introducing path canonicalization at the hermetic VFS boundary.
