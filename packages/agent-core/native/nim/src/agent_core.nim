# agent_core.nim — N-API bridge entry point
# Re-exports all cost_pure and snapshot functions with C calling convention
# All functions use {.cdecl, exportc.} for N-API compatibility

{.push raises: [].}

import cost_pure
import snapshot

# Re-export all functions so they appear in the compiled .so/.dll
# The C++ N-API wrapper calls these via extern "C"
export cost_pure
export snapshot
