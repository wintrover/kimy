Launch multiple subagents from one prompt template, existing agent resumes, or both.

**If `AgentSwarm` is called, that call MUST be the only tool call in the response.** Do not combine AgentSwarm with any other tool calls (Read, Write, Bash, etc.) in the same response. If you need other tools, call them before or after AgentSwarm — not alongside it.

Use AgentSwarm when many subagents should run the same kind of task over different inputs. The placeholder is exactly `{{item}}`. For example, with `prompt_template` set to `Review {{item}} for likely regressions.` and `items` set to `["src/a.ts", "src/b.ts"]`, AgentSwarm launches two new subagents with those two concrete prompts.

Use `resume_agent_ids` to continue subagents that already exist from earlier work, such as ones that failed or timed out: map each agent id to the prompt for that resumed subagent (usually `continue` if no extra information is needed). You may combine `resume_agent_ids` with `items` in the same call to resume existing subagents and launch new ones. Do not duplicate resumed work in `items`.

Use enough subagents to keep the work focused and parallel. AgentSwarm supports up to 128 subagents, and launches are queued automatically, so it is safe to split large tasks into many clear, independent items.

Output mode:
- `output_mode='text'` (default): each subagent returns a natural-language summary, and results are rendered as one `<subagent>` node per subagent.
- `output_mode='artifact'`: every spawned subagent must call `YieldArtifact(payload=..., finalize=true)`. Each payload is written atomically to its own isolated workspace ledger. Completed results include `artifact_id` and `schema_version` attributes so you can correlate structured outputs. If any subagent finishes without yielding, that subagent fails deterministically.
