## IAuditStorage — SDK interface for gate audit persistence
##
## The Domain layer depends ONLY on this interface.
## Actual JSONL file I/O is implemented by the platform.

type
  AuditEntry* = object
    gateId*: string
    passed*: bool
    durationMs*: int
    timestamp*: string      ## ISO-8601 format
    metadata*: string       ## JSON-encoded additional data

  HealthLevel* = enum
    hlHealthy    ## Gate operating normally
    hlWarning    ## Occasional failures, within tolerance
    hlDegraded   ## Consistent failures, needs attention
    hlCritical   ## Gate is broken, immediate action required

  IAuditStorage* = concept s
    s.append(AuditEntry)
    s.recentEntries(int) is seq[AuditEntry]
    s.assessHealth(string) is HealthLevel
