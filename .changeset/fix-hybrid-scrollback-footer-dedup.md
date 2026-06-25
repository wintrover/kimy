---
"@moonshot-ai/kimi-code": patch
---

Fix footer duplication during long streaming sessions by capping transcript buffer with a sliding window (rows + 1000 lines).
