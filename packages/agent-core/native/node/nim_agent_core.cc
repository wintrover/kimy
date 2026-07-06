// nim_agent_core.cc — C++ N-API wrapper for Nim agent-core
// Bridges JavaScript ↔ Nim via zero-copy raw pointers
// Includes magic number validation and panic-to-exception conversion

#include <napi.h>
#include <cstdint>
#include <cstring>

// Nim-generated C function declarations (from cost_pure.nim + snapshot.nim)
extern "C" {
  int32_t scoreMove(const uint8_t* data, int32_t len);
  int32_t evaluateHeuristic(const uint8_t* data, int32_t len);
  int32_t checkInvariant(const uint8_t* data, int32_t len);
  int32_t traceConsequences(const uint8_t* data, int32_t len);
  int32_t computeStateHash(const uint8_t* data, int32_t len,
                           uint8_t* outHash, int32_t hashLen);
  int32_t validateSnapshot(const uint8_t* data, int32_t len);
  int32_t applyEvents(const uint8_t* snapshotData, int32_t snapshotLen,
                      const uint8_t* eventsData, int32_t eventsLen,
                      uint8_t* outData, int32_t outLen);
  int32_t migrateSnapshot(const uint8_t* data, int32_t len,
                          int32_t fromVersion, int32_t toVersion,
                          uint8_t* outData, int32_t outLen);
}

// Error code constants (must match cost_pure.nim + snapshot.nim)
static constexpr int32_t ERR_BUFFER_TOO_SHORT = -1;
static constexpr int32_t ERR_MAGIC_MISMATCH = -2;
static constexpr int32_t ERR_LENGTH_OVERFLOW = -3;
static constexpr int32_t ERR_INVALID_JSON = -4;
static constexpr int32_t ERR_UNSUPPORTED_VERSION = -5;
static constexpr int32_t ERR_OUTPUT_BUFFER_TOO_SMALL = -6;
static constexpr int32_t ERR_CATCHABLE = -998;
static constexpr int32_t ERR_PANIC = -999;
static constexpr uint32_t MAGIC_NUMBER = 0x4158494D;  // 'AXIM'

// Throw JS error for negative error codes
static void ThrowOnError(Napi::Env env, int32_t result) {
  if (result == ERR_BUFFER_TOO_SHORT) {
    Napi::Error::New(env, "Buffer too short (need >= 8 bytes for header)").ThrowAsJavaScriptException();
  } else if (result == ERR_MAGIC_MISMATCH) {
    Napi::Error::New(env, "Magic number mismatch (expected 0x4158494D 'AXIM')").ThrowAsJavaScriptException();
  } else if (result == ERR_LENGTH_OVERFLOW) {
    Napi::Error::New(env, "Length overflow (header length > buffer length)").ThrowAsJavaScriptException();
  } else if (result == ERR_INVALID_JSON) {
    Napi::Error::New(env, "Invalid JSON payload (expected { } braces)").ThrowAsJavaScriptException();
  } else if (result == ERR_UNSUPPORTED_VERSION) {
    Napi::Error::New(env, "Unsupported version (fromVersion must be <= toVersion, both >= 1)").ThrowAsJavaScriptException();
  } else if (result == ERR_OUTPUT_BUFFER_TOO_SMALL) {
    Napi::Error::New(env, "Output buffer too small").ThrowAsJavaScriptException();
  } else if (result == ERR_CATCHABLE) {
    Napi::Error::New(env, "Nim CatchableError").ThrowAsJavaScriptException();
  } else if (result == ERR_PANIC) {
    Napi::Error::New(env, "Nim Defect/Panic (division by zero, overflow, etc.)").ThrowAsJavaScriptException();
  }
}

// === Exported N-API functions ===

Napi::Value ScoreMove(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsTypedArray()) {
    Napi::TypeError::New(env, "Expected Uint8Array argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto arr = info[0].As<Napi::TypedArrayOf<uint8_t>>();
  auto ptr = arr.Data();  // Zero-Copy raw pointer
  auto len = static_cast<int32_t>(arr.ElementLength());
  int32_t result = scoreMove(ptr, len);
  if (result < 0) {
    ThrowOnError(env, result);
    return env.Undefined();
  }
  return Napi::Number::New(env, result);
}

Napi::Value EvaluateHeuristic(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsTypedArray()) {
    Napi::TypeError::New(env, "Expected Uint8Array argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto arr = info[0].As<Napi::TypedArrayOf<uint8_t>>();
  auto ptr = arr.Data();
  auto len = static_cast<int32_t>(arr.ElementLength());
  int32_t result = evaluateHeuristic(ptr, len);
  if (result < 0) {
    ThrowOnError(env, result);
    return env.Undefined();
  }
  return Napi::Number::New(env, result);
}

Napi::Value CheckInvariant(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsTypedArray()) {
    Napi::TypeError::New(env, "Expected Uint8Array argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto arr = info[0].As<Napi::TypedArrayOf<uint8_t>>();
  auto ptr = arr.Data();
  auto len = static_cast<int32_t>(arr.ElementLength());
  int32_t result = checkInvariant(ptr, len);
  if (result < 0) {
    ThrowOnError(env, result);
    return env.Undefined();
  }
  return Napi::Number::New(env, result);
}

Napi::Value TraceConsequences(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsTypedArray()) {
    Napi::TypeError::New(env, "Expected Uint8Array argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto arr = info[0].As<Napi::TypedArrayOf<uint8_t>>();
  auto ptr = arr.Data();
  auto len = static_cast<int32_t>(arr.ElementLength());
  int32_t result = traceConsequences(ptr, len);
  if (result < 0) {
    ThrowOnError(env, result);
    return env.Undefined();
  }
  return Napi::Number::New(env, result);
}

// === Snapshot N-API functions ===

Napi::Value ComputeStateHash(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsTypedArray()) {
    Napi::TypeError::New(env, "Expected two Uint8Array arguments (input, output)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto inputArr = info[0].As<Napi::TypedArrayOf<uint8_t>>();
  auto outputArr = info[1].As<Napi::TypedArrayOf<uint8_t>>();
  auto inputPtr = inputArr.Data();
  auto inputLen = static_cast<int32_t>(inputArr.ElementLength());
  auto outputPtr = outputArr.Data();
  auto outputLen = static_cast<int32_t>(outputArr.ElementLength());
  int32_t result = computeStateHash(inputPtr, inputLen, outputPtr, outputLen);
  if (result < 0) {
    ThrowOnError(env, result);
    return env.Undefined();
  }
  return Napi::Number::New(env, result);
}

Napi::Value ValidateSnapshot(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsTypedArray()) {
    Napi::TypeError::New(env, "Expected Uint8Array argument").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto arr = info[0].As<Napi::TypedArrayOf<uint8_t>>();
  auto ptr = arr.Data();
  auto len = static_cast<int32_t>(arr.ElementLength());
  int32_t result = validateSnapshot(ptr, len);
  if (result < 0) {
    ThrowOnError(env, result);
    return env.Undefined();
  }
  return Napi::Number::New(env, result);
}

Napi::Value ApplyEvents(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsTypedArray() || !info[1].IsTypedArray() || !info[2].IsTypedArray()) {
    Napi::TypeError::New(env, "Expected three Uint8Array arguments (snapshot, events, output)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto snapArr = info[0].As<Napi::TypedArrayOf<uint8_t>>();
  auto eventsArr = info[1].As<Napi::TypedArrayOf<uint8_t>>();
  auto outArr = info[2].As<Napi::TypedArrayOf<uint8_t>>();
  auto snapPtr = snapArr.Data();
  auto snapLen = static_cast<int32_t>(snapArr.ElementLength());
  auto eventsPtr = eventsArr.Data();
  auto eventsLen = static_cast<int32_t>(eventsArr.ElementLength());
  auto outPtr = outArr.Data();
  auto outLen = static_cast<int32_t>(outArr.ElementLength());
  int32_t result = applyEvents(snapPtr, snapLen, eventsPtr, eventsLen, outPtr, outLen);
  if (result < 0) {
    ThrowOnError(env, result);
    return env.Undefined();
  }
  return Napi::Number::New(env, result);
}

Napi::Value MigrateSnapshot(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4 || !info[0].IsTypedArray() || !info[1].IsNumber() || !info[2].IsNumber() || !info[3].IsTypedArray()) {
    Napi::TypeError::New(env, "Expected (Uint8Array, number, number, Uint8Array) arguments").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto dataArr = info[0].As<Napi::TypedArrayOf<uint8_t>>();
  auto fromVersion = static_cast<int32_t>(info[1].As<Napi::Number>().Int32Value());
  auto toVersion = static_cast<int32_t>(info[2].As<Napi::Number>().Int32Value());
  auto outArr = info[3].As<Napi::TypedArrayOf<uint8_t>>();
  auto dataPtr = dataArr.Data();
  auto dataLen = static_cast<int32_t>(dataArr.ElementLength());
  auto outPtr = outArr.Data();
  auto outLen = static_cast<int32_t>(outArr.ElementLength());
  int32_t result = migrateSnapshot(dataPtr, dataLen, fromVersion, toVersion, outPtr, outLen);
  if (result < 0) {
    ThrowOnError(env, result);
    return env.Undefined();
  }
  return Napi::Number::New(env, result);
}

// === Module initialization ===

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("scoreMove", Napi::Function::New(env, ScoreMove));
  exports.Set("evaluateHeuristic", Napi::Function::New(env, EvaluateHeuristic));
  exports.Set("checkInvariant", Napi::Function::New(env, CheckInvariant));
  exports.Set("traceConsequences", Napi::Function::New(env, TraceConsequences));
  exports.Set("computeStateHash", Napi::Function::New(env, ComputeStateHash));
  exports.Set("validateSnapshot", Napi::Function::New(env, ValidateSnapshot));
  exports.Set("applyEvents", Napi::Function::New(env, ApplyEvents));
  exports.Set("migrateSnapshot", Napi::Function::New(env, MigrateSnapshot));
  return exports;
}

NODE_API_MODULE(nim_agent_core, Init)
