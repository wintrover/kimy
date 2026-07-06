Call this tool to transition from the Planning phase to the Execution phase while
carrying swarm parameters forward. It stores the swarm arguments and switches
the agent into Execution mode so that AgentSwarm becomes the only available tool
on the next turn.

Use this when you need to do planning work — such as updating a TodoList,
setting goals, or any other preparation — alongside swarm preparation, and want
to guarantee that the very next action is a deterministic AgentSwarm call with
the exact parameters you provide here.

Once committed, the agent cannot start another tool besides AgentSwarm until the
swarm finishes and the phase resets. If the swarm should not run after all, you
may call ExitPlanMode or a comparable mechanism to reset the phase.
