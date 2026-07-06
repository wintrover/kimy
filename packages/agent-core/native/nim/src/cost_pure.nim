# cost_pure.nim — Pure cost/scoring logic for agent-core
# All functions follow:
# - Total Function Enforcement (no throw, explicit error codes)
# - Panic Isolation (try/except CatchableError, Defect -> error codes)
# - Magic Number Guard (0x4158494D 'AXIM' header validation)
# - Direct pointer arithmetic for payload access

{.push raises: [].}

const
  MAGIC_NUMBER: uint32 = 0x4158494D  # 'AXIM' in little-endian
  HEADER_SIZE: int32 = 8  # 4B magic + 4B length
  ERR_BUFFER_TOO_SHORT: int32 = -1
  ERR_MAGIC_MISMATCH: int32 = -2
  ERR_LENGTH_OVERFLOW: int32 = -3
  ERR_CATCHABLE: int32 = -998
  ERR_PANIC: int32 = -999

proc readInt32(data: ptr UncheckedArray[uint8], offset: int32): int32 =
  ## Read an int32 from data at the given byte offset.
  cast[ptr int32](addr data[offset])[]

proc readUint32(data: ptr UncheckedArray[uint8], offset: int32): uint32 =
  ## Read a uint32 from data at the given byte offset.
  cast[ptr uint32](addr data[offset])[]

proc validateHeader(data: ptr UncheckedArray[uint8], len: int32): int32 =
  ## Validate buffer header: magic number + length bounds.
  ## Returns 0 on success, negative error code on failure.
  if len < HEADER_SIZE:
    return ERR_BUFFER_TOO_SHORT
  let magic = readUint32(data, 0)
  if magic != MAGIC_NUMBER:
    return ERR_MAGIC_MISMATCH
  let totalLen = readInt32(data, 4)
  if totalLen > len or totalLen < HEADER_SIZE:
    return ERR_LENGTH_OVERFLOW
  return 0

proc scoreMove*(data: ptr UncheckedArray[uint8], len: int32): int32 {.cdecl, exportc.} =
  ## Evaluate a move's score from binary data.
  ## Returns score >= 0 on success, negative error code on failure.
  try:
    let err = validateHeader(data, len)
    if err != 0: return err
    let totalLen = readInt32(data, 4)
    let payloadLen = totalLen - HEADER_SIZE
    if payloadLen < 4: return ERR_BUFFER_TOO_SHORT
    # Read score from first 4 bytes of payload (at offset 8)
    let score = readInt32(data, 8)
    if score < 0: return 0  # Negative scores clamped to 0
    return score
  except CatchableError:
    return ERR_CATCHABLE
  except Defect:
    return ERR_PANIC

proc evaluateHeuristic*(data: ptr UncheckedArray[uint8], len: int32): int32 {.cdecl, exportc.} =
  ## Evaluate heuristic score from binary state data.
  try:
    let err = validateHeader(data, len)
    if err != 0: return err
    let totalLen = readInt32(data, 4)
    let payloadLen = totalLen - HEADER_SIZE
    if payloadLen < 8: return ERR_BUFFER_TOO_SHORT
    # Read two int32 values and compute weighted sum
    let a = readInt32(data, 8)
    let b = readInt32(data, 12)
    # Weighted heuristic: a * 3 + b (integer-only)
    return a * 3 + b
  except CatchableError:
    return ERR_CATCHABLE
  except Defect:
    return ERR_PANIC

proc checkInvariant*(data: ptr UncheckedArray[uint8], len: int32): int32 {.cdecl, exportc.} =
  ## Check invariant conditions from binary state data.
  ## Returns 0 if invariant holds, positive code for specific violation, negative for errors.
  try:
    let err = validateHeader(data, len)
    if err != 0: return err
    let totalLen = readInt32(data, 4)
    let payloadLen = totalLen - HEADER_SIZE
    if payloadLen < 4: return ERR_BUFFER_TOO_SHORT
    let value = readInt32(data, 8)
    # Invariant: value must be non-negative
    if value < 0: return 1  # invariant violation
    return 0  # invariant holds
  except CatchableError:
    return ERR_CATCHABLE
  except Defect:
    return ERR_PANIC

proc traceConsequences*(data: ptr UncheckedArray[uint8], len: int32): int32 {.cdecl, exportc.} =
  ## Trace consequences from binary state data.
  ## Returns count of consequences >= 0 on success.
  try:
    let err = validateHeader(data, len)
    if err != 0: return err
    let totalLen = readInt32(data, 4)
    let payloadLen = totalLen - HEADER_SIZE
    if payloadLen < 4: return ERR_BUFFER_TOO_SHORT
    let depth = readInt32(data, 8)
    if depth < 0: return 0
    # Trace count = depth * 2 (simple linear model)
    return depth * 2
  except CatchableError:
    return ERR_CATCHABLE
  except Defect:
    return ERR_PANIC
