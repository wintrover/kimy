---
"@moonshot-ai/kimi-code": patch
---

Fix subagent 429 rate-limit fallback to the configured fallback model by replacing imperative callback state with a stateless LLM factory pattern.
