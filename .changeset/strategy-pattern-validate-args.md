---
"@moonshot-ai/kimi-code": minor
---

Replace duck-typed `inputSchema` on ExecutableTool with a strategy-pattern `validateArgs` method, so each tool owns its validation strategy (Zod-first via ZodToolBase or AJV via createAjvValidateArgs).
