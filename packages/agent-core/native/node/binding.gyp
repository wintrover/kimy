{
  "targets": [{
    "target_name": "nim_agent_core",
    "sources": [
      "nim_agent_core.cc"
    ],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")"
    ],
    "defines": ["NAPI_VERSION=8"],
    "cflags!": ["-fno-exceptions"],
    "cflags_cc!": ["-fno-exceptions"],
    "cflags_cc": ["-std=c++17", "-Wall", "-Wextra"],
    "xcode_settings": {
      "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
      "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
      "MACOSX_DEPLOYMENT_TARGET": "10.15"
    },
    "msvs_settings": {
      "VCCLCompilerTool": {"ExceptionHandling": 1}
    },
    "conditions": [
      ["OS=='linux'", {
        "libraries": ["-Wl,-rpath,'$$ORIGIN'", "-L../../nim", "-lagent_core"]
      }]
    ]
  }]
}
