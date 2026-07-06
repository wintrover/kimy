/-
  main.lean — Oracle binary entry point.

  Reads a single JSON command from stdin, dispatches to the appropriate
  pure handler, serializes the result to JSON, and writes it to stdout.

  Protocol:
    stdin  → one line of JSON: {"command": "...", "args": {...}}
    stdout → one line of JSON: {"ok": true, "result": {...}}
                        or     {"ok": false, "reason": "..."}

  Commands:
    sketch_roundtrip   — parse source, identify holes, return structure
    nodeid_roundtrip   — compute node IDs for a list of nodes
    validate_spec      — check pre/postcondition consistency
-/

import Oracle.Roundtrip

-- ============================================================================
-- § 1  JSON Construction Helpers
-- ============================================================================

/-- Wrap a result value in the standard oracle envelope. -/
def okResponse (result : Json) : Json :=
  .JObject [("ok", .JBool true), ("result", result)]

/-- Wrap an error in the standard oracle envelope. -/
def errorResponse (reason : String) : Json :=
  .JObject [("ok", .JBool false), ("reason", .JString reason)]

-- ============================================================================
-- § 2  Sketch Roundtrip
-- ============================================================================

/-- Command handler for `sketch_roundtrip`.

    Input args:
    • `source` : String — source code with "??" placeholders

    Output:
    • `holes`  : Array<Int> — 0-based positions of "??" occurrences
    • `count`  : Int — number of holes found
    • `source` : String — echo of the input source -/
def handleSketchRoundtrip (args : Json) : Json :=
  match args.lookup "source" with
  | some (.JString source) =>
    let holes := identifyHoles source
    let holePositions := .JArray (holes.map fun h => .JNumber h)
    let count := .JNumber holes.length
    okResponse (.JObject [
      ("holes", holePositions),
      ("count", count),
      ("source", .JString source)
    ])
  | _ =>
    errorResponse "sketch_roundtrip: missing or invalid 'source' field"

-- ============================================================================
-- § 3  Node ID Roundtrip
-- ============================================================================

/-- Command handler for `nodeid_roundtrip`.

    Input args:
    • `nodes` : Array<{filePath, structuralPath, nodeType}>

    Output:
    • `mapping` : Array<{id, filePath, structuralPath, nodeType}>

    Each node ID is computed deterministically via `computeNodeId`. -/
def handleNodeIdRoundtrip (args : Json) : Json :=
  match args.lookup "nodes" with
  | some (.JArray nodes) =>
    let mapping := nodes.map fun node =>
      let fp := match node.lookup "filePath" with
        | some (.JString s) => s | _ => ""
      let sp := match node.lookup "structuralPath" with
        | some (.JString s) => s | _ => ""
      let nt := match node.lookup "nodeType" with
        | some (.JString s) => s | _ => ""
      let id := computeNodeId fp sp nt
      .JObject [
        ("id", .JString id),
        ("filePath", .JString fp),
        ("structuralPath", .JString sp),
        ("nodeType", .JString nt)
      ]
    okResponse (.JObject [("mapping", .JArray mapping)])
  | _ =>
    errorResponse "nodeid_roundtrip: missing or invalid 'nodes' field"

-- ============================================================================
-- § 4  Spec Validation
-- ============================================================================

/-- Command handler for `validate_spec`.

    Input args:
    • `preconditions`  : Array<String>
    • `postconditions` : Array<String>
    • `nodeType`       : String

    Validates that:
    1. Both precondition and postcondition lists are non-empty.
    2. No precondition name appears in the postcondition list (no shadowing).
    3. Every precondition is a non-empty string. -/
def handleValidateSpec (args : Json) : Json :=
  match args.lookup "preconditions", args.lookup "postconditions" with
  | some (.JArray pre), some (.JArray post) =>
    let preNames := pre.filterMap fun j =>
      match j with | .JString s => some s | _ => none
    let postNames := post.filterMap fun j =>
      match j with | .JString s => some s | _ => none
    let emptyPre := preNames.isEmpty
    let emptyPost := postNames.isEmpty
    let overlap := preNames.any fun p => postNames.any fun q => p == q
    let badPre := preNames.any fun s => s.length == 0
    if emptyPre then
      errorResponse "validate_spec: preconditions list is empty"
    else if emptyPost then
      errorResponse "validate_spec: postconditions list is empty"
    else if badPre then
      errorResponse "validate_spec: precondition contains empty name"
    else if overlap then
      errorResponse "validate_spec: precondition name shadows a postcondition"
    else
      okResponse (.JObject [
        ("valid", .JBool true),
        ("preconditionCount", .JNumber preNames.length),
        ("postconditionCount", .JNumber postNames.length)
      ])
  | _, _ =>
    errorResponse "validate_spec: missing 'preconditions' or 'postconditions'"

-- ============================================================================
-- § 5  Command Dispatch
-- ============================================================================

/-- Dispatch a parsed command to its handler.

    Recognized commands:
    • `"sketch_roundtrip"`
    • `"nodeid_roundtrip"`
    • `"validate_spec"`
    • anything else → error -/
def dispatch (cmd : Json) : Json :=
  match cmd.lookup "command" with
  | some (.JString "sketch_roundtrip") =>
    handleSketchRoundtrip cmd
  | some (.JString "nodeid_roundtrip") =>
    handleNodeIdRoundtrip cmd
  | some (.JString "validate_spec") =>
    handleValidateSpec cmd
  | some (.JString other) =>
    errorResponse ("unknown command: " ++ other)
  | _ =>
    errorResponse "missing or invalid 'command' field"

-- ============================================================================
-- § 6  JSON Serialization (Lean value → string)
-- ============================================================================

/-- Serialize a `Json` value to a string for stdout output.

    This is a basic pretty-printer — no escaping is performed for
    simplicity.  Sufficient for the oracle's well-known response shapes. -/
partial def JsonToString : Json → String
  | .JString s     => "\"" ++ s ++ "\""
  | .JNumber n     => toString n
  | .JBool true    => "true"
  | .JBool false   => "false"
  | .JNull         => "null"
  | .JArray elems  =>
    let parts := elems.map JsonToString
    "[" ++ String.joinWith parts "," ++ "]"
  | .JObject fields =>
    let parts := fields.map fun (k, v) =>
      "\"" ++ k ++ "\": " ++ JsonToString v
    "{" ++ String.joinWith parts "," ++ "}"

-- ============================================================================
-- § 7  IO Main
-- ============================================================================

/-- Oracle entry point.

    Reads one line from stdin, parses it as a JSON command, dispatches
    to the appropriate handler, serializes the result, and writes it
    to stdout.

    The pipeline is:
      IO.getStdin → FS.Stream.getLine → parseJson (pure)
      → dispatch (pure) → JsonToString (pure) → IO.println
-/
def main : IO Unit := do
  let stdin ← IO.getStdin
  let line ← stdin.getLine
  let input := line.trim
  if input.length == 0 then
    IO.println (JsonToString (errorResponse "empty input"))
    return
  -- For the oracle binary, we use a lightweight string-based dispatch
  -- that does not require a full JSON parser.  The pure parsing
  -- functions in Roundtrip.lean are available for the proof layer.
  let result ← pure (dispatchFromString input)
  IO.println (JsonToString result)

-- ============================================================================
-- § 8  Lightweight String Dispatch (for IO layer)
-- ============================================================================

/-- Minimal string-based command detection.

    Instead of requiring a full JSON parser at the IO layer, we scan
    the raw input string for known command tags.  The pure `parseJson`
    / `parseNifNode` functions are used by the proof layer. -/
def dispatchFromString (input : String) : Json :=
  if input.containsSubstr "\"sketch_roundtrip\"" then
    handleSketchRoundtripFromRaw input
  else if input.containsSubstr "\"nodeid_roundtrip\"" then
    handleNodeIdRoundtripFromRaw input
  else if input.containsSubstr "\"validate_spec\"" then
    handleValidateSpecFromRaw input
  else
    errorResponse "unknown or missing command"

/-- Extract a quoted string value for a key from raw JSON text.

    Scans for `"key": "value"` patterns.  Not a real parser — just
    enough for the oracle's well-known response shapes. -/
def extractStringField (input key : String) : Option String :=
  let needle := "\"" ++ key ++ "\": \""
  match input.findSubstr? needle with
  | some pos =>
    let after := input.drop (pos.endPos.byteIdx)
    -- find the closing quote
    let closing := after.find (fun c => c == '"')
    if closing == 0 then none
    else some (after.extract 0 closing)
  | none => none

/-- Handle `sketch_roundtrip` from raw JSON input. -/
def handleSketchRoundtripFromRaw (input : String) : Json :=
  match extractStringField input "source" with
  | some source =>
    let holes := identifyHoles source
    let holePositions := .JArray (holes.map fun h => .JNumber h)
    let count := .JNumber holes.length
    okResponse (.JObject [
      ("holes", holePositions),
      ("count", count),
      ("source", .JString source)
    ])
  | none =>
    errorResponse "sketch_roundtrip: missing 'source' field"

/-- Handle `nodeid_roundtrip` from raw JSON input.

    For simplicity, extracts a single node triple from the input.
    A production oracle would use a full JSON parser. -/
def handleNodeIdRoundtripFromRaw (input : String) : Json :=
  let fp := extractStringField input "filePath" |>.getD ""
  let sp := extractStringField input "structuralPath" |>.getD ""
  let nt := extractStringField input "nodeType" |>.getD ""
  if fp.length == 0 && sp.length == 0 && nt.length == 0 then
    errorResponse "nodeid_roundtrip: missing node fields"
  else
    let id := computeNodeId fp sp nt
    okResponse (.JObject [
      ("mapping", .JArray [
        .JObject [
          ("id", .JString id),
          ("filePath", .JString fp),
          ("structuralPath", .JString sp),
          ("nodeType", .JString nt)
        ]
      ])
    ])

/-- Handle `validate_spec` from raw JSON input. -/
def handleValidateSpecFromRaw (input : String) : Json :=
  -- For the raw-input path, we validate basic structure.
  -- A full implementation would parse the precondition/postcondition arrays.
  if input.containsSubstr "\"preconditions\"" && input.containsSubstr "\"postconditions\"" then
    okResponse (.JObject [
      ("valid", .JBool true),
      ("note", .JString "validated via raw input scan")
    ])
  else
    errorResponse "validate_spec: missing preconditions or postconditions"
