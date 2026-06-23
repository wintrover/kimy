## IContextBudget — SDK interface for context window management
##
## Tracks token usage and triggers compaction before context overflow.
## Used by orchestration layers to manage long-running sessions.
##
## Derived from the Context Budget Discipline four-tier degradation model:
## - PEAK (0-30%): Full operations, parallel agents, inline results
## - GOOD (30-50%): Normal operations, prefer frontmatter reads
## - DEGRADING (50-70%): Economize, minimal inlining, warn the user
## - POOR (70%+): Emergency mode, checkpoint immediately, no new reads

type
  ContextTier* = enum
    ctPeak      ## < 40% context used — full capability
    ctGood      ## 40-60% — normal operation
    ctDegrading ## 60-80% — start compacting non-critical context
    ctPoor      ## > 80% — aggressive compaction, limit new tasks

  IContextBudget* = concept c
    c.currentTier() is ContextTier
    c.tokenBudget() is int              # remaining tokens
    c.shouldCompact() is bool           # true when compaction needed
