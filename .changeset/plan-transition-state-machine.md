---
"@moonshot-ai/agent-core": minor
"@moonshot-ai/kosong": minor
---

feat: add deterministic state machine for SavePlan→ExitPlanMode transition

Adds a runtime state machine that tracks the SavePlan→ExitPlanMode transition to prevent premature `end_turn` from LLMs. When an incomplete transition is detected, the system auto-resumes via system prompt injection (micro-resume). Also adds `tool_choice` passthrough to force ExitPlanMode calls after SavePlan succeeds.
