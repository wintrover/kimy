---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Normalize tool argument aliases before AJV validation so the validator only ever sees canonical parameter names.
