---
"@moonshot-ai/agent-core": minor
"@moonshot-ai/kimi-code": minor
---

Isolate tools in swarm mode: the main agent only sees orchestration and collaboration tools while swarm is active, sub-agents no longer receive the AgentSwarm tool, and mixed AgentSwarm + leaf-tool batches are intercepted and self-corrected.
