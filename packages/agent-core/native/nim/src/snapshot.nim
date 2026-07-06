## Snapshot integrity verification and delta replay for LSM-Tree event sourcing.
## All functions follow the same conventions as cost_pure.nim:
## - Total Function Enforcement (explicit error codes, never throws)
## - Panic Isolation (try/except CatchableError, Defect -> error codes)
## - Magic Number Guard (AXIM header validation)
## - Direct pointer arithmetic for payload access

{.push raises: [].}

const
  MAGIC_NUMBER: uint32 = 0x4158494D  # 'AXIM' in little-endian
  HEADER_SIZE: int32 = 8  # 4B magic + 4B length
  ERR_BUFFER_TOO_SHORT: int32 = -1
  ERR_MAGIC_MISMATCH: int32 = -2
  ERR_LENGTH_OVERFLOW: int32 = -3
  ERR_INVALID_JSON: int32 = -4
  ERR_UNSUPPORTED_VERSION: int32 = -5
  ERR_OUTPUT_BUFFER_TOO_SMALL: int32 = -6
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

proc computeStateHash*(data: ptr UncheckedArray[uint8], len: int32,
    outHash: ptr UncheckedArray[uint8], hashLen: int32): int32 {.cdecl, exportc.} =
  ## Compute a deterministic 40-byte hash over the AXIM payload.
  ## Uses FNV-1a seed expanded to 40 bytes via position-dependent mixing.
  ## Returns 0 on success.
  try:
    let err = validateHeader(data, len)
    if err != 0: return err
    if hashLen < 40: return ERR_OUTPUT_BUFFER_TOO_SMALL
    let totalLen = readInt32(data, 4)
    let payloadLen = totalLen - HEADER_SIZE
    if payloadLen <= 0: return ERR_BUFFER_TOO_SHORT
    # FNV-1a over payload bytes
    var h: uint64 = 0xcbf29ce484222325'u64
    for i in HEADER_SIZE ..< totalLen:
      h = h xor uint64(data[i])
      h = h * 0x100000001b3'u64
      h = h xor (h shr 16)
    # Expand single hash to 40 bytes via golden-ratio mixing
    for i in 0'i32 ..< 40:
      let mixed = h xor (uint64(i) * 0x9e3779b97f4a7c15'u64)
      outHash[i] = uint8(mixed and 0xFF)
    return 0'i32
  except CatchableError:
    return ERR_CATCHABLE
  except Defect:
    return ERR_PANIC

proc validateSnapshot*(data: ptr UncheckedArray[uint8], len: int32): int32 {.cdecl, exportc.} =
  ## Validate a snapshot buffer: checks AXIM header + JSON braces in payload.
  ## Returns 0 if valid, negative error code on failure.
  try:
    let err = validateHeader(data, len)
    if err != 0: return err
    let totalLen = readInt32(data, 4)
    let payloadLen = totalLen - HEADER_SIZE
    if payloadLen <= 0: return ERR_BUFFER_TOO_SHORT
    # Check first and last payload bytes are JSON braces
    if data[HEADER_SIZE] != uint8('{') or data[totalLen - 1] != uint8('}'):
      return ERR_INVALID_JSON
    return 0'i32
  except CatchableError:
    return ERR_CATCHABLE
  except Defect:
    return ERR_PANIC

proc applyEvents*(snapshotData: ptr UncheckedArray[uint8], snapshotLen: int32,
    eventsData: ptr UncheckedArray[uint8], eventsLen: int32,
    outData: ptr UncheckedArray[uint8], outLen: int32): int32 {.cdecl, exportc.} =
  ## Apply event delta to a snapshot. Produces a new AXIM frame containing
  ## the snapshot payload (events application is a placeholder for now).
  ## Returns bytes written on success, negative error code on failure.
  try:
    let err1 = validateHeader(snapshotData, snapshotLen)
    if err1 != 0: return err1
    let err2 = validateHeader(eventsData, eventsLen)
    if err2 != 0: return err2
    let totalLen = readInt32(snapshotData, 4)
    let payloadLen = totalLen - HEADER_SIZE
    if payloadLen <= 0: return ERR_BUFFER_TOO_SHORT
    let frameSize = payloadLen + HEADER_SIZE
    if outLen < frameSize: return ERR_OUTPUT_BUFFER_TOO_SMALL
    # Write AXIM header
    cast[ptr uint32](addr outData[0])[] = MAGIC_NUMBER
    cast[ptr int32](addr outData[4])[] = frameSize
    # Copy snapshot payload as output
    for i in 0'i32 ..< payloadLen:
      outData[HEADER_SIZE + i] = snapshotData[HEADER_SIZE + i]
    return frameSize
  except CatchableError:
    return ERR_CATCHABLE
  except Defect:
    return ERR_PANIC

proc migrateSnapshot*(data: ptr UncheckedArray[uint8], len: int32,
    fromVersion: int32, toVersion: int32,
    outData: ptr UncheckedArray[uint8], outLen: int32): int32 {.cdecl, exportc.} =
  ## Migrate a snapshot from one version to another.
  ## Currently a passthrough (identity migration) for same/higher versions.
  ## Returns bytes written on success, negative error code on failure.
  try:
    let err = validateHeader(data, len)
    if err != 0: return err
    if fromVersion < 1 or toVersion < 1 or fromVersion > toVersion:
      return ERR_UNSUPPORTED_VERSION
    let totalLen = readInt32(data, 4)
    let payloadLen = totalLen - HEADER_SIZE
    if payloadLen <= 0: return ERR_BUFFER_TOO_SHORT
    let frameSize = payloadLen + HEADER_SIZE
    if outLen < frameSize: return ERR_OUTPUT_BUFFER_TOO_SMALL
    # Write AXIM header
    cast[ptr uint32](addr outData[0])[] = MAGIC_NUMBER
    cast[ptr int32](addr outData[4])[] = frameSize
    # Copy payload as-is (identity migration)
    for i in 0'i32 ..< payloadLen:
      outData[HEADER_SIZE + i] = data[HEADER_SIZE + i]
    return frameSize
  except CatchableError:
    return ERR_CATCHABLE
  except Defect:
    return ERR_PANIC
