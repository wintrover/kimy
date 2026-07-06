## Tests for nif_extractor
##
## Run: nim c -r test/test_nif_extractor.nim
## Or:  nimble test

import std/[unittest, strutils, sequtils, json, os, tables, options]
import ../nif_extractor

const fixturesDir = currentSourcePath().parentDir() / "fixtures"

# ─── Lexer Tests ─────────────────────────────────────────────────────────────

suite "Lexer":
  test "tokenizes empty input":
    var lex = initLexer("")
    let tokens = lex.tokenize()
    check tokens.len == 1
    check tokens[0].kind == tkEOF

  test "tokenizes parens":
    var lex = initLexer("()")
    let tokens = lex.tokenize()
    check tokens.len == 3  # ( ) EOF
    check tokens[0].kind == tkLParen
    check tokens[1].kind == tkRParen

  test "tokenizes identifiers":
    var lex = initLexer("hello world")
    let tokens = lex.tokenize()
    check tokens.len == 3  # hello world EOF
    check tokens[0].kind == tkIdent
    check tokens[0].value == "hello"
    check tokens[1].kind == tkIdent
    check tokens[1].value == "world"

  test "tokenizes strings":
    var lex = initLexer("\"hello world\"")
    let tokens = lex.tokenize()
    check tokens.len == 2
    check tokens[0].kind == tkString
    check tokens[0].value == "hello world"

  test "tokenizes integers":
    var lex = initLexer("42")
    let tokens = lex.tokenize()
    check tokens.len == 2
    check tokens[0].kind == tkInt
    check tokens[0].value == "42"

  test "tokenizes floats":
    var lex = initLexer("3.14")
    let tokens = lex.tokenize()
    check tokens.len == 2
    check tokens[0].kind == tkFloat
    check tokens[0].value == "3.14"

  test "tokenizes S-expression":
    var lex = initLexer("(proc (name \"foo\"))")
    let tokens = lex.tokenize()
    check tokens.len == 8  # ( proc ( name "foo" ) ) EOF
    check tokens[0].kind == tkLParen
    check tokens[1].kind == tkIdent
    check tokens[1].value == "proc"
    check tokens[2].kind == tkLParen
    check tokens[3].kind == tkIdent
    check tokens[3].value == "name"
    check tokens[4].kind == tkString
    check tokens[4].value == "foo"
    check tokens[5].kind == tkRParen
    check tokens[6].kind == tkRParen

  test "skips line comments":
    var lex = initLexer("; this is a comment\nhello")
    let tokens = lex.tokenize()
    check tokens.len == 2
    check tokens[0].kind == tkIdent
    check tokens[0].value == "hello"

  test "tokenizes escaped strings":
    var lex = initLexer("\"hello\\nworld\"")
    let tokens = lex.tokenize()
    check tokens.len == 2
    check tokens[0].kind == tkString
    check tokens[0].value == "hello\nworld"

  test "tracks line numbers":
    var lex = initLexer("line1\nline2\nline3")
    let tokens = lex.tokenize()
    check tokens[0].line == 1
    check tokens[1].line == 2
    check tokens[2].line == 3

# ─── Parser Tests ────────────────────────────────────────────────────────────

suite "Parser":
  test "parses empty input":
    let nodes = parseNifString("")
    check nodes.len == 0

  test "parses simple identifier":
    let nodes = parseNifString("hello")
    check nodes.len == 1
    check nodes[0].nodeKind == nkIdent
    check nodes[0].identVal == "hello"

  test "parses string literal":
    let nodes = parseNifString("\"hello world\"")
    check nodes.len == 1
    check nodes[0].nodeKind == nkString
    check nodes[0].strVal == "hello world"

  test "parses integer literal":
    let nodes = parseNifString("42")
    check nodes.len == 1
    check nodes[0].nodeKind == nkInt
    check nodes[0].intVal == 42

  test "parses S-expression":
    let nodes = parseNifString("(proc (name \"foo\"))")
    check nodes.len == 1
    check nodes[0].nodeKind == nkSExpr
    check nodes[0].tag == "proc"
    check nodes[0].children.len == 1  # (name "foo")
    check nodes[0].children[0].nodeKind == nkSExpr
    check nodes[0].children[0].tag == "name"

  test "parses nested S-expressions":
    let input = """(type
  (name "MyType")
  (object
    (field "x" (typeRef "int"))
    (field "y" (typeRef "float"))
  )
)"""
    let nodes = parseNifString(input)
    check nodes.len == 1
    check nodes[0].nodeKind == nkSExpr
    check nodes[0].tag == "type"
    check nodes[0].children.len == 2  # name, object (with nested fields)

  test "parses qualified name":
    let nodes = parseNifString("std.math.sqrt")
    check nodes.len == 1
    # Dots are part of identifier tokens in this lexer
    check nodes[0].nodeKind == nkIdent
    check nodes[0].identVal == "std.math.sqrt"

  test "handles comments in S-expressions":
    let input = """(proc
  ; this is a comment
  (name "foo")
)"""
    let nodes = parseNifString(input)
    check nodes.len == 1
    check nodes[0].tag == "proc"

  test "parses multiple top-level expressions":
    let input = """(proc (name "foo"))
(func (name "bar"))
(type (name "Baz"))"""
    let nodes = parseNifString(input)
    check nodes.len == 3
    check nodes[0].tag == "proc"
    check nodes[1].tag == "func"
    check nodes[2].tag == "type"

# ─── NifNode API Tests ──────────────────────────────────────────────────────

suite "NifNode API":
  test "findChild finds matching tag":
    let input = """(proc
      (name "foo")
      (params (param "x" (typeRef "int")))
      (ret (typeRef "bool"))
    )"""
    let nodes = parseNifString(input)
    let procNode = nodes[0]

    let nameNode = procNode.findChild("name")
    check nameNode.isSome()
    check nameNode.get().getText() == "foo"

    let paramsNode = procNode.findChild("params")
    check paramsNode.isSome()

    let retNode = procNode.findChild("ret")
    check retNode.isSome()
    check retNode.get().getText() == "bool"

  test "findChild returns None for missing tag":
    let nodes = parseNifString("(proc (name \"foo\"))")
    let missing = nodes[0].findChild("nonexistent")
    check missing.isNone()

  test "findAll returns all matches":
    let input = """(type
      (field "x" (typeRef "int"))
      (field "y" (typeRef "float"))
      (field "z" (typeRef "string"))
    )"""
    let nodes = parseNifString(input)
    let fields = nodes[0].findAll("field")
    check fields.len == 3

  test "findDeep searches recursively":
    let input = """(type
      (name "MyType")
      (object
        (field "x" (typeRef "int"))
        (field "y" (typeRef "float"))
      )
    )"""
    let nodes = parseNifString(input)
    let typeRefs = nodes[0].findDeep("typeRef")
    check typeRefs.len == 2

  test "getText extracts text content":
    let ident = newIdent("hello")
    check ident.getText() == "hello"

    let str = newString("world")
    check str.getText() == "world"

    let num = newInt(42)
    check num.getText() == "42"

  test "getQualifiedName extracts qualified names":
    let q = newQualified(@["std", "math", "sqrt"])
    check q.getQualifiedName() == "std.math.sqrt"

# ─── Extraction Tests ────────────────────────────────────────────────────────

suite "Symbol Extraction":
  test "extracts proc type signature":
    let input = """(proc
      (name (exportedSym "z3.solve"))
      (params
        (param "x" (typeRef "int"))
        (param "y" (typeRef "float") (default (floatVal 1.0)))
      )
      (ret (typeRef "bool"))
      (pragma (efx "gcsafe"))
    )"""
    let nodes = parseNifString(input)
    let sym = nodes[0].extractSymbol()

    check sym.symbol == "z3.solve"
    check sym.symbolKind == skProc
    check sym.typeSignature.raw != ""
    check sym.typeSignature.params.len == 2
    check sym.typeSignature.params[0].name == "x"
    check sym.typeSignature.params[0].typeStr == "int"
    check sym.typeSignature.params[1].name == "y"
    check sym.typeSignature.params[1].typeStr == "float"
    check sym.typeSignature.params[1].defaultVal == "1.0"
    check sym.typeSignature.returnType == "bool"
    check sym.isExported == true

  test "extracts effect pragmas":
    let input = """(proc
      (name "test")
      (pragma (efx "gcsafe") (efx "noSideEffect") (efx "tags" "ReadIOEffect"))
    )"""
    let nodes = parseNifString(input)
    let sym = nodes[0].extractSymbol()

    check sym.effectPragma.tags.len == 4  # gcsafe, noSideEffect, tags, ReadIOEffect
    check "gcsafe" in sym.effectPragma.tags
    check "noSideEffect" in sym.effectPragma.tags

  test "extracts dependencies":
    let input = """(proc
      (name "test")
      (import "z3/Solver")
      (import "z3/Model")
      (include "utils.nim")
      (call (sym "z3.Solver.init"))
    )"""
    let nodes = parseNifString(input)
    let sym = nodes[0].extractSymbol()

    let imports = sym.dependencies.filterIt(it.kind == "import")
    check imports.len == 2

    let includes = sym.dependencies.filterIt(it.kind == "include")
    check includes.len == 1

    let calls = sym.dependencies.filterIt(it.kind == "call")
    check calls.len == 1
    check calls[0].symbol == "z3.Solver.init"

  test "extracts macro expansions":
    let input = """(macro
      (name "testMacro")
      (expandedFrom "realMacro" "file.nim:10" (sExpr "body" "content"))
    )"""
    let nodes = parseNifString(input)
    let sym = nodes[0].extractSymbol()

    check sym.macroExpansions.len == 1
    check sym.macroExpansions[0].macroName == "realMacro"
    check sym.macroExpansions[0].expansionSite == "file.nim:10"

  test "extracts type definition":
    let input = """(type
      (name (exportedSym "MyType"))
      (object
        (field "x" (typeRef "int"))
        (field "y" (typeRef "float"))
      )
    )"""
    let nodes = parseNifString(input)
    let sym = nodes[0].extractSymbol()

    check sym.symbol == "MyType"
    check sym.symbolKind == skType
    check sym.isExported == true

  test "extracts const definition":
    let input = """(const
      (name (exportedSym "MAX_SIZE"))
      (type (typeRef "int"))
      (intVal 1024)
    )"""
    let nodes = parseNifString(input)
    let sym = nodes[0].extractSymbol()

    check sym.symbol == "MAX_SIZE"
    check sym.symbolKind == skConst
    check sym.isExported == true

  test "extracts template definition":
    let input = """(template
      (name (exportedSym "debugLog"))
      (params
        (param "msg" (typeRef "string"))
      )
      (ret (typeRef "void"))
    )"""
    let nodes = parseNifString(input)
    let sym = nodes[0].extractSymbol()

    check sym.symbol == "debugLog"
    check sym.symbolKind == skTemplate
    check sym.isExported == true

  test "extracts generic params":
    let input = """(proc
      (name (exportedSym "convert"))
      (genericParams (param "T") (param "U"))
      (params (param "val" (typeRef "T")))
      (ret (typeRef "U"))
    )"""
    let nodes = parseNifString(input)
    let sym = nodes[0].extractSymbol()

    check sym.isGeneric == true
    check sym.genericParams.len == 2
    check "T" in sym.genericParams
    check "U" in sym.genericParams

  test "symbolMatches exact match":
    check symbolMatches("z3.solveConstraint", "z3.solveConstraint")
    check not symbolMatches("z3.solve", "z3.solveConstraint")

  test "symbolMatches prefix wildcard":
    check symbolMatches("std.math.sqrt", "std.math.*")
    check not symbolMatches("z3.solve", "std.*")

  test "symbolMatches contains wildcard":
    check symbolMatches("z3.solveConstraint", "*solve*")
    check not symbolMatches("z3.addConstraint", "*solve*")

  test "symbolMatches partial match":
    check symbolMatches("z3.solveConstraint", "solveConstraint")

# ─── File I/O Tests ──────────────────────────────────────────────────────────

suite "File I/O":
  test "parseNifFile reads sample.nif":
    let file = fixturesDir / "sample.nif"
    let nodes = parseNifFile(file)
    check nodes.len > 0

  test "parseDepsFile reads sample.deps.nif":
    let file = fixturesDir / "sample.deps.nif"
    let deps = parseDepsFile(file)
    check deps.len > 0

  test "parseIfaceFile reads sample.iface.nif":
    let file = fixturesDir / "sample.iface.nif"
    let iface = parseIfaceFile(file)
    check iface.len > 0
    check "z3.solveConstraint" in iface
    check iface["z3.solveConstraint"] == "a3f8c1d2e5b4"

  test "parseNifFile raises on missing file":
    expect IOError:
      discard parseNifFile("/nonexistent/path/file.nif")

# ─── Full Pipeline Test ─────────────────────────────────────────────────────

suite "Full Pipeline":
  test "extracts symbols from sample.nif":
    let file = fixturesDir / "sample.nif"
    let nodes = parseNifFile(file)

    var allSymbols: seq[ExtractedSymbol]
    for node in nodes:
      if node.nodeKind == nkSExpr and node.tag in [
          "proc", "func", "template", "macro", "type", "const"]:
        allSymbols.add(node.extractSymbol())

    check allSymbols.len >= 5  # proc, func, template, macro, type, const

    # Check we got the proc
    let procs = allSymbols.filterIt(it.symbolKind == skProc)
    check procs.len >= 1
    check procs[0].symbol == "z3.solveConstraint"
    check procs[0].typeSignature.params.len == 2
    check procs[0].effectPragma.tags.len > 0

    # Check we got the type
    let types = allSymbols.filterIt(it.symbolKind == skType)
    check types.len >= 2

    # Check dependencies
    let z3solve = allSymbols.filterIt(it.symbol == "z3.solveConstraint")[0]
    check z3solve.dependencies.len > 0

  test "contract JSON output is valid":
    let file = fixturesDir / "sample.nif"
    let nodes = parseNifFile(file)

    var ext = newExtractor(ExtractConfig(
      projectPath: fixturesDir,
      symbols: @[],
      depth: 0,
      format: ofContract,
      includeDeps: false,
      includeIface: false,
      includeMacros: false,
      includeTemplates: false,
      verbose: false
    ))

    # Manually add symbols from sample.nif
    for node in nodes:
      if node.nodeKind == nkSExpr and node.tag in [
          "proc", "func", "template", "macro", "type", "const"]:
        let sym = node.extractSymbol()
        ext.symbols[sym.symbol] = sym

    let jsonStr = ext.toContractJson()
    let jsonNode = parseJson(jsonStr)

    check jsonNode["format"].getStr() == "kimi-agent-swarm-nif-contract"
    check jsonNode["symbols"].len > 0
    check jsonNode["totalSymbols"].getInt() > 0

  test "deps file parsing integrates with extractor":
    let depsFile = fixturesDir / "sample.deps.nif"
    let deps = parseDepsFile(depsFile)

    var depTable: Table[string, seq[Dependency]]
    for dep in deps:
      if dep.symbol notin depTable:
        depTable[dep.symbol] = @[]
      depTable[dep.symbol].add(dep)

    check "z3.solveConstraint" in depTable
    check depTable["z3.solveConstraint"].len >= 2

  test "iface file parsing integrates with extractor":
    let ifaceFile = fixturesDir / "sample.iface.nif"
    let iface = parseIfaceFile(ifaceFile)

    check iface.len == 7
    for symbol, hash in iface:
      check hash.len == 12  # All hashes are 12 chars

# ─── Template Overload Detection ────────────────────────────────────────────

suite "Template Overloads":
  test "detects template overloads":
    let input = """(template
  (name (exportedSym "format"))
  (params (param "s" (typeRef "string")))
  (ret (typeRef "string"))
)
(template
  (name (exportedSym "format"))
  (params (param "i" (typeRef "int")))
  (ret (typeRef "string"))
)
(template
  (name (exportedSym "format"))
  (params (param "f" (typeRef "float")))
  (ret (typeRef "string"))
)"""
    let nodes = parseNifString(input)
    let overloads = extractTemplateOverloads(nodes)

    check overloads.len == 1
    check overloads[0].name == "format"
    check overloads[0].instantiationCount == 3
