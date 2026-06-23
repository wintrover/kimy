## IEvidenceStore — SDK interface for subagent evidence persistence
##
## Stores and verifies post-condition receipts from subagent tasks.
## Part of the Hypothesis-Attempt-Evidence verification pipeline.
##
## Derived from the Evidence-Based Deterministic Convergence (EDC) protocol:
## - Replaces narrative trust with deterministic, shell-checkable evidence
## - Every delegate_task that modifies code MUST include post_condition commands
## - Evidence receipts capture: agent ID, claimed outcomes, verification commands,
##   git HEAD hash, and timestamp for auditability
## - Verification binds to a specific commit to prevent stale receipt reuse

type
  EvidenceReceipt* = object
    agentId*: string                    ## Unique subagent identifier
    postConditions*: seq[string]        ## Claimed outcomes
    verificationCommands*: seq[string]  ## Commands to verify claims
    headHash*: string                   ## Git HEAD at time of execution
    timestamp*: string                  ## ISO-8601

  IEvidenceStore* = concept e
    e.store(EvidenceReceipt)
    e.verify(string) is bool            # agentId → verified?
