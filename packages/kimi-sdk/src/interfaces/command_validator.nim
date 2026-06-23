## ICommandValidator — SDK interface for command validation
##
## Implementations gate command execution through effect classification
## and circuit-breaking patterns. The platform provides the concrete
## implementation; projects consume only this interface.
##
## Extracted from the Axiom gate_admin four-pillar architecture:
##   1. Semantic Effect Classification (CommandEffect)
##   2. Contextual Epoch Verification (Git SHA hash)
##   3. Deterministic Bounded Ring Buffer (recent command history)
##   4. Derivation boundary hashing (build command input fingerprinting)

type
  CommandEffect* = enum
    oeIdempotent    ## Read-only, safe to retry (ls, cat, grep, pwd, ...)
    oeMutation      ## State-changing, requires confirmation (git, rm, mkdir, ...)
    oeTransient     ## Temporary side effects (cache, temp files, ...)
    oeDerivation    ## Produces derived artifacts (nim c, cargo build, make, ...)

  ValidationResult* = object
    allowed*: bool            ## Whether the command may execute
    reason*: string           ## Human-readable explanation when blocked
    effect*: CommandEffect    ## Classified effect category

  ICommandValidator* = concept v
    ## Core contract: classify, gate, and record command execution.
    v.validateCommand(string) is ValidationResult
    v.recordCommand(string, CommandEffect)
    v.recentCommands() is seq[string]
