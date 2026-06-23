## IGateTelemetry — SDK interface for gate execution metrics
##
## Records timing, pass/fail rates, and generates summaries.
## Used by the reporting layer for dashboards and alerts.

type
  IGateTelemetry* = concept t
    t.record(string, bool, int)    # gateId, passed, durationMs
    t.generateSummary() is string
