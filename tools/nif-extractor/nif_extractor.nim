## nif_extractor — NIF (Nim Intermediate Format) Semantic Extractor
##
## Parses `.nif`, `.deps.nif`, and `.iface.nif` files from Nim's IC pipeline.
## Extracts type signatures, effect pragmas, macro expansions, template
## overloading, and include dependencies. Outputs structured JSON for the
## AgentSwarm contract / symbol-resolution layer.
##
## Usage:
##   nif-extractor --project /path --symbols "z3.solveConstraint" \
##                 --depth 2 --format contract

import std/[os, strutils, sequtils, sets, tables,
            json, times, options]
import std/strformat

# ─── NIF Token Types ─────────────────────────────────────────────────────────

type
  TokenKind* = enum
    tkLParen,      # (
    tkRParen,      # )
    tkIdent,       # bare identifier
    tkString,      # "..."
    tkInt,         # integer literal
    tkFloat,       # float literal
    tkDot,         # . (used in qualified names)
    tkAt,          # @
    tkHash,        # #
    tkAmp,         # &
    tkPercent,     # %
    tkCaret,       # ^
    tkTilde,       # ~
    tkBang,        # !
    tkEq,          # =
    tkLt,          # <
    tkGt,          # >
    tkMinus,       # -
    tkPlus,        # +
    tkStar,        # *
    tkSlash,       # /
    tkBackslash,   # \
    tkDollar,      # $
    tkColon,       # :
    tkSemicolon,   # ;
    tkComma,       # ,
    tkQuestion,    # ?
    tkPipe,        # |
    tkUnderscore,  # _
    tkDoubleQuote, # "
    tkTick,        # '
    tkComment,     # ; ... (line comment)
    tkEOF

  Token* = object
    kind*: TokenKind
    value*: string
    line*: int
    col*: int

  # ─── AST Nodes ────────────────────────────────────────────────────────────

  NifNodeKind* = enum
    nkSExpr,        # generic S-expression: (tag args...)
    nkIdent,        # bare identifier
    nkString,       # string literal
    nkInt,          # integer literal
    nkFloat,        # float literal
    nkQualified,    # dotted qualified name: a.b.c
    nkComment,      # comment
    nkEmpty,        # empty / nil

  NifNode* = ref object
    case nodeKind*: NifNodeKind
    of nkSExpr:
      tag*: string
      children*: seq[NifNode]
    of nkIdent:
      identVal*: string
    of nkString:
      strVal*: string
    of nkInt:
      intVal*: int64
    of nkFloat:
      floatVal*: float
    of nkQualified:
      parts*: seq[string]
    of nkComment, nkEmpty:
      discard

  # ─── Extracted Symbol Info ────────────────────────────────────────────────

  SymbolKind* = enum
    skProc, skFunc, skMethod, skIterator, skConverter,
    skTemplate, skMacro, skType, skConst, skVar, skLet,
    skEnum, skObject, skDistinct, skAlias, skUnknown

  EffectPragma* = object
    tags*: seq[string]    # e.g. ["gcsafe", "noSideEffect"]
    raw*: string          # original pragma text

  Dependency* = object
    symbol*: string       # qualified name of dependency
    kind*: string         # "import", "include", "call", "type-ref"
    path*: string         # file path if available

  TypeSignature* = object
    params*: seq[ParamInfo]
    returnType*: string
    genericParams*: seq[string]
    pragmas*: seq[string]
    raw*: string

  ParamInfo* = object
    name*: string
    typeStr*: string
    defaultVal*: string
    isVarargs*: bool

  MacroExpansion* = object
    macroName*: string
    expansionSite*: string    # file:line
    inputHash*: string        # content hash of the input
    outputAst*: string        # serialized expansion result
    expandedFrom*: string     # original source location

  TemplateOverload* = object
    name*: string
    signature*: string
    instantiationCount*: int
    file*: string
    line*: int

  ExtractedSymbol* = object
    symbol*: string           # fully qualified name
    symbolKind*: SymbolKind
    typeSignature*: TypeSignature
    effectPragma*: EffectPragma
    dependencies*: seq[Dependency]
    macroExpansions*: seq[MacroExpansion]
    templateOverloads*: seq[TemplateOverload]
    includeChain*: seq[string]
    file*: string
    line*: int
    column*: int
    isExported*: bool
    isGeneric*: bool
    genericParams*: seq[string]
    docComment*: string
    rawNifTag*: string        # original NIF tag for debugging
    children*: seq[ExtractedSymbol]  # nested symbols

  # ─── Config ───────────────────────────────────────────────────────────────

  OutputFormat* = enum
    ofContract, ofFull, ofMinimal

  ExtractConfig* = object
    projectPath*: string
    symbols*: seq[string]      # symbol patterns to extract
    depth*: int                # recursion depth (0 = unlimited)
    format*: OutputFormat
    includeDeps*: bool         # also extract dependencies
    includeIface*: bool        # also parse .iface.nif
    includeMacros*: bool       # extract macro expansions
    includeTemplates*: bool    # extract template overloads
    verbose*: bool

  # ─── Lexer ────────────────────────────────────────────────────────────────

  Lexer* = object
    input*: string
    pos*: int
    line*: int
    col*: int
    tokens*: seq[Token]

  # ─── Parser ───────────────────────────────────────────────────────────────

  Parser* = object
    tokens*: seq[Token]
    pos*: int
    filename*: string

  # ─── Extractor ────────────────────────────────────────────────────────────

  Extractor* = ref object
    config*: ExtractConfig
    symbols*: Table[string, ExtractedSymbol]
    fileIndex*: Table[string, NifNode]    # file -> root AST
    depIndex*: Table[string, seq[NifNode]] # symbol -> deps
    ifaceIndex*: Table[string, string]     # symbol -> interface hash

# ─── Symbol Kind Helpers ────────────────────────────────────────────────────

proc symbolKindFromTag*(tag: string): SymbolKind =
  case tag
  of "proc": skProc
  of "func": skFunc
  of "method": skMethod
  of "iterator": skIterator
  of "converter": skConverter
  of "template": skTemplate
  of "macro": skMacro
  of "type", "typeSection": skType
  of "const": skConst
  of "var": skVar
  of "let": skLet
  of "enum": skEnum
  of "object": skObject
  of "distinct": skDistinct
  of "alias": skAlias
  else: skUnknown

proc symbolKindName*(sk: SymbolKind): string =
  case sk
  of skProc: "proc"
  of skFunc: "func"
  of skMethod: "method"
  of skIterator: "iterator"
  of skConverter: "converter"
  of skTemplate: "template"
  of skMacro: "macro"
  of skType: "type"
  of skConst: "const"
  of skVar: "var"
  of skLet: "let"
  of skEnum: "enum"
  of skObject: "object"
  of skDistinct: "distinct"
  of skAlias: "alias"
  of skUnknown: "unknown"

# ─── NifNode Helpers ────────────────────────────────────────────────────────

proc newSExpr*(tag: string, children: seq[NifNode] = @[]): NifNode =
  NifNode(nodeKind: nkSExpr, tag: tag, children: children)

proc newIdent*(val: string): NifNode =
  NifNode(nodeKind: nkIdent, identVal: val)

proc newString*(val: string): NifNode =
  NifNode(nodeKind: nkString, strVal: val)

proc newInt*(val: int64): NifNode =
  NifNode(nodeKind: nkInt, intVal: val)

proc newFloat*(val: float): NifNode =
  NifNode(nodeKind: nkFloat, floatVal: val)

proc newQualified*(parts: seq[string]): NifNode =
  NifNode(nodeKind: nkQualified, parts: parts)

proc newEmpty*(): NifNode =
  NifNode(nodeKind: nkEmpty)

proc tag*(n: NifNode): string =
  if n.nodeKind == nkSExpr: n.tag
  elif n.nodeKind == nkIdent: n.identVal
  elif n.nodeKind == nkQualified: n.parts.join(".")
  else: ""

proc len*(n: NifNode): int =
  if n.nodeKind == nkSExpr: n.children.len
  else: 0

proc `[]`*(n: NifNode, i: int): NifNode =
  assert n.nodeKind == nkSExpr
  n.children[i]

proc `[]`*(n: NifNode, s: HSlice): seq[NifNode] =
  assert n.nodeKind == nkSExpr
  n.children[s]

iterator items*(n: NifNode): NifNode =
  if n.nodeKind == nkSExpr:
    for child in n.children:
      yield child

proc `$`*(n: NifNode): string =
  case n.nodeKind
  of nkSExpr:
    var parts: seq[string]
    parts.add("(")
    parts.add(n.tag)
    for child in n.children:
      parts.add($child)
    parts.add(")")
    parts.join(" ")
  of nkIdent: n.identVal
  of nkString: "\"" & n.strVal & "\""
  of nkInt: $n.intVal
  of nkFloat: $n.floatVal
  of nkQualified: n.parts.join(".")
  of nkComment: "; " & ""
  of nkEmpty: "()"

# ─── Forward Declarations ────────────────────────────────────────────────────

proc getText*(node: NifNode): string

# ─── Lexer Implementation ───────────────────────────────────────────────────

proc initLexer*(input: string): Lexer =
  Lexer(input: input, pos: 0, line: 1, col: 1)

proc peek*(lex: Lexer): char =
  if lex.pos < lex.input.len: lex.input[lex.pos]
  else: '\0'

proc advance*(lex: var Lexer) =
  if lex.pos < lex.input.len:
    if lex.input[lex.pos] == '\n':
      inc lex.line
      lex.col = 1
    else:
      inc lex.col
    inc lex.pos

proc skipWhitespace*(lex: var Lexer) =
  while lex.pos < lex.input.len and lex.input[lex.pos] in {' ', '\t', '\n', '\r'}:
    lex.advance()

proc skipComment*(lex: var Lexer): bool =
  if lex.peek() == ';':
    while lex.pos < lex.input.len and lex.input[lex.pos] != '\n':
      lex.advance()
    return true
  false

proc readString*(lex: var Lexer): string =
  assert lex.peek() == '"'
  lex.advance() # skip opening quote
  var result = ""
  while lex.pos < lex.input.len:
    let c = lex.input[lex.pos]
    if c == '\\':
      lex.advance()
      if lex.pos < lex.input.len:
        let escaped = lex.input[lex.pos]
        case escaped
        of 'n': result.add('\n')
        of 't': result.add('\t')
        of '\\': result.add('\\')
        of '"': result.add('"')
        else: result.add(escaped)
      lex.advance()
    elif c == '"':
      lex.advance() # skip closing quote
      return result
    else:
      result.add(c)
      lex.advance()
  result

proc readWord*(lex: var Lexer): string =
  var result = ""
  while lex.pos < lex.input.len:
    let c = lex.input[lex.pos]
    if c in {'(', ')', ' ', '\t', '\n', '\r', ';', '"'}:
      break
    result.add(c)
    lex.advance()
  result

proc tokenize*(lex: var Lexer): seq[Token] =
  result = @[]
  while lex.pos < lex.input.len:
    lex.skipWhitespace()
    if lex.pos >= lex.input.len:
      break

    if lex.skipComment():
      continue

    let startLine = lex.line
    let startCol = lex.col
    let c = lex.peek()

    case c
    of '(':
      result.add(Token(kind: tkLParen, value: "(", line: startLine, col: startCol))
      lex.advance()
    of ')':
      result.add(Token(kind: tkRParen, value: ")", line: startLine, col: startCol))
      lex.advance()
    of '"':
      let s = lex.readString()
      result.add(Token(kind: tkString, value: s, line: startLine, col: startCol))
    else:
      let word = lex.readWord()
      if word.len > 0:
        # Determine token kind from content
        let kind = if word.len > 0 and word[0] in {'0'..'9'}:
                     if '.' in word: tkFloat else: tkInt
                   elif word == "@": tkAt
                   elif word == "#": tkHash
                   elif word == "&": tkAmp
                   elif word == "%": tkPercent
                   elif word == "^": tkCaret
                   elif word == "~": tkTilde
                   elif word == "!": tkBang
                   elif word == "=": tkEq
                   elif word == "<": tkLt
                   elif word == ">": tkGt
                   elif word == "-": tkMinus
                   elif word == "+": tkPlus
                   elif word == "*": tkStar
                   elif word == "/": tkSlash
                   elif word == "\\": tkBackslash
                   elif word == "$": tkDollar
                   elif word == ":": tkColon
                   elif word == ";": tkSemicolon
                   elif word == ",": tkComma
                   elif word == "?": tkQuestion
                   elif word == "|": tkPipe
                   elif word == "_": tkUnderscore
                   elif word == "'": tkTick
                   else: tkIdent
        result.add(Token(kind: kind, value: word, line: startLine, col: startCol))

  result.add(Token(kind: tkEOF, line: lex.line, col: lex.col))

# ─── Parser Implementation ──────────────────────────────────────────────────

proc initParser*(tokens: seq[Token], filename: string = ""): Parser =
  Parser(tokens: tokens, pos: 0, filename: filename)

proc peek*(p: Parser): Token =
  if p.pos < p.tokens.len: p.tokens[p.pos]
  else: Token(kind: tkEOF)

proc advance*(p: var Parser): Token =
  let tok = p.peek()
  if p.pos < p.tokens.len:
    inc p.pos
  tok

proc expect*(p: var Parser, kind: TokenKind): Token =
  let tok = p.peek()
  if tok.kind != kind:
    raise newException(ValueError,
      fmt"Expected {kind} at {tok.line}:{tok.col}, got {tok.kind} ({tok.value})")
  p.advance()

proc parseSExpr*(p: var Parser): NifNode =
  ## Parse a single S-expression or atom.
  let tok = p.peek()

  case tok.kind
  of tkLParen:
    discard p.advance() # consume (
    var children: seq[NifNode] = @[]

    # First child is typically the tag
    var tagStr = ""
    if p.peek().kind != tkRParen:
      let tagNode = p.parseSExpr()
      tagStr = case tagNode.nodeKind
        of nkIdent: tagNode.identVal
        of nkQualified: tagNode.parts.join(".")
        of nkString: tagNode.strVal
        of nkSExpr: tagNode.tag
        else: $tagNode

      # Parse remaining children
      while p.peek().kind notin {tkRParen, tkEOF}:
        children.add(p.parseSExpr())

    discard p.expect(tkRParen) # consume )

    if children.len > 0:
      result = NifNode(nodeKind: nkSExpr, tag: tagStr, children: children)
    else:
      result = NifNode(nodeKind: nkSExpr, tag: "", children: @[])

  of tkRParen:
    raise newException(ValueError,
      fmt"Unexpected ) at {tok.line}:{tok.col}")

  of tkIdent:
    discard p.advance()
    # Check for qualified name: ident.ident
    if p.peek().kind == tkDot:
      var parts = @[tok.value]
      while p.peek().kind == tkDot:
        discard p.advance() # consume .
        let next = p.advance()
        if next.kind == tkIdent:
          parts.add(next.value)
        else:
          break
      result = NifNode(nodeKind: nkQualified, parts: parts)
    else:
      result = NifNode(nodeKind: nkIdent, identVal: tok.value)

  of tkString:
    discard p.advance()
    result = NifNode(nodeKind: nkString, strVal: tok.value)

  of tkInt:
    discard p.advance()
    try:
      result = NifNode(nodeKind: nkInt, intVal: parseBiggestInt(tok.value))
    except ValueError:
      result = NifNode(nodeKind: nkString, strVal: tok.value)

  of tkFloat:
    discard p.advance()
    try:
      result = NifNode(nodeKind: nkFloat, floatVal: parseFloat(tok.value))
    except ValueError:
      result = NifNode(nodeKind: nkString, strVal: tok.value)

  of tkDot:
    # standalone dot — part of qualified name, read next ident
    discard p.advance()
    let next = p.advance()
    if next.kind == tkIdent:
      result = NifNode(nodeKind: nkIdent, identVal: "." & next.value)
    else:
      result = NifNode(nodeKind: nkIdent, identVal: ".")

  else:
    discard p.advance()
    result = NifNode(nodeKind: nkIdent, identVal: tok.value)

proc parseAll*(p: var Parser): seq[NifNode] =
  result = @[]
  while p.peek().kind != tkEOF:
    result.add(p.parseSExpr())

# ─── NIF File I/O ───────────────────────────────────────────────────────────

proc parseNifFile*(filename: string): seq[NifNode] =
  ## Parse a .nif file and return the list of top-level S-expressions.
  if not fileExists(filename):
    raise newException(IOError, fmt"NIF file not found: {filename}")

  let content = readFile(filename)
  var lexer = initLexer(content)
  let tokens = lexer.tokenize()
  var parser = initParser(tokens, filename)
  parser.parseAll()

proc parseNifString*(input: string, filename: string = "<string>"): seq[NifNode] =
  ## Parse NIF content from a string.
  var lexer = initLexer(input)
  let tokens = lexer.tokenize()
  var parser = initParser(tokens, filename)
  parser.parseAll()

# ─── NIF Semantic Navigation ────────────────────────────────────────────────

proc findChild*(node: NifNode, tag: string): Option[NifNode] =
  ## Find the first child with the given tag.
  if node.nodeKind != nkSExpr:
    return none(NifNode)
  for child in node.children:
    if child.nodeKind == nkSExpr and child.tag == tag:
      return some(child)
  none(NifNode)

proc findAll*(node: NifNode, tag: string): seq[NifNode] =
  ## Find all children with the given tag.
  if node.nodeKind != nkSExpr:
    return @[]
  for child in node.children:
    if child.nodeKind == nkSExpr and child.tag == tag:
      result.add(child)

proc findDeep*(node: NifNode, tag: string, maxDepth: int = 10): seq[NifNode] =
  ## Recursively find all nodes with the given tag up to maxDepth.
  if maxDepth <= 0:
    return @[]
  if node.nodeKind == nkSExpr:
    if node.tag == tag:
      result.add(node)
    for child in node.children:
      result.add(child.findDeep(tag, maxDepth - 1))

proc getText*(node: NifNode): string =
  ## Extract text content from a node.
  case node.nodeKind
  of nkIdent: node.identVal
  of nkString: node.strVal
  of nkInt: $node.intVal
  of nkFloat: $node.floatVal
  of nkQualified: node.parts.join(".")
  of nkSExpr:
    if node.children.len > 0:
      node.children[0].getText()
    else: ""
  of nkComment, nkEmpty: ""

proc getQualifiedName*(node: NifNode): string =
  ## Extract a qualified name from an identifier or qualified node.
  case node.nodeKind
  of nkIdent: node.identVal
  of nkQualified: node.parts.join(".")
  of nkSExpr:
    # Could be (sym "module.name")
    if node.tag == "sym" and node.children.len > 0:
      node.children[0].getText()
    elif node.tag == "exportedSym" and node.children.len > 0:
      node.children[0].getText()
    elif node.tag == "name" and node.children.len > 0:
      # (name (exportedSym "foo")) or (name (sym "foo"))
      node.children[0].getQualifiedName()
    else: ""
  else: ""

# ─── Symbol Extraction Logic ────────────────────────────────────────────────

proc extractTypeSignature*(node: NifNode): TypeSignature =
  ## Extract type signature from a proc/func/method/template node.
  result = TypeSignature()

  # Look for (params ...) subnode
  let paramsNode = node.findChild("params")
  if paramsNode.isSome:
    let p = paramsNode.get()
    for child in p.children:
      if child.nodeKind == nkSExpr:
        var param = ParamInfo()
        if child.children.len >= 2:
          param.name = child.children[0].getText()
          param.typeStr = child.children[1].getText()
        elif child.children.len == 1:
          param.typeStr = child.children[0].getText()
        # Check for default value
        let defaultNode = child.findChild("default")
        if defaultNode.isSome:
          param.defaultVal = defaultNode.get().getText()
        result.params.add(param)
      elif child.nodeKind == nkIdent:
        # Bare identifier could be a param name
        result.params.add(ParamInfo(name: child.identVal))

  # Return type: (ret type)
  let retNode = node.findChild("ret")
  if retNode.isSome:
    result.returnType = retNode.get().getText()

  # Generic params: (genericParams ...)
  let gpNode = node.findChild("genericParams")
  if gpNode.isSome:
    for child in gpNode.get().children:
      result.genericParams.add(child.getText())

  # Pragmas
  let pragmaNode = node.findChild("pragma")
  if pragmaNode.isSome:
    for child in pragmaNode.get().children:
      result.pragmas.add(child.getText())

  # Build raw string representation
  var rawParts: seq[string]
  if result.genericParams.len > 0:
    rawParts.add("[" & result.genericParams.join(", ") & "]")
  rawParts.add("(")
  for i, p in result.params:
    if i > 0: rawParts.add(", ")
    if p.name.len > 0:
      rawParts.add(p.name & ": " & p.typeStr)
    else:
      rawParts.add(p.typeStr)
  rawParts.add(")")
  if result.returnType.len > 0:
    rawParts.add(": " & result.returnType)
  result.raw = rawParts.join("")

proc extractEffectPragma*(node: NifNode): EffectPragma =
  ## Extract effect pragmas from a node.
  result = EffectPragma(tags: @[], raw: "")

  # Look for (efx ...) or (effects ...) or (pragma ...) subnode
  let pragmaNode = node.findChild("pragma")
  if pragmaNode.isSome:
    var tags: seq[string]
    for child in pragmaNode.get().children:
      if child.nodeKind == nkIdent:
        tags.add(child.identVal)
      elif child.nodeKind == nkSExpr and child.tag in ["efx", "effects", "tags"]:
        for sub in child.children:
          tags.add(sub.getText())
    result.tags = tags
    result.raw = $(pragmaNode.get())

  # Also check for (efx ...) directly
  let efxNode = node.findChild("efx")
  if efxNode.isSome:
    for child in efxNode.get().children:
      let tag = child.getText()
      if tag.len > 0 and tag notin result.tags:
        result.tags.add(tag)
    if result.raw.len == 0:
      result.raw = $(efxNode.get())

  # And (effects ...)
  let effectsNode = node.findChild("effects")
  if effectsNode.isSome:
    for child in effectsNode.get().children:
      let tag = child.getText()
      if tag.len > 0 and tag notin result.tags:
        result.tags.add(tag)

proc extractDependencies*(node: NifNode): seq[Dependency] =
  ## Extract dependency information from a node.
  result = @[]

  # Imports: (import ...) — there may be multiple
  let importNodes = node.findAll("import")
  for importNode in importNodes:
    for child in importNode.children:
      result.add(Dependency(
        symbol: child.getText(),
        kind: "import",
        path: ""
      ))

  # From imports: (fromModImport ...)
  let fromModNode = node.findChild("fromModImport")
  if fromModNode.isSome:
    let modName = if fromModNode.get().children.len > 0:
      fromModNode.get().children[0].getText()
    else: ""
    for i in 1..<fromModNode.get().children.len:
      result.add(Dependency(
        symbol: modName & "." & fromModNode.get().children[i].getText(),
        kind: "import",
        path: ""
      ))

  # Includes: (include ...)
  let includeNode = node.findChild("include")
  if includeNode.isSome:
    for child in includeNode.get().children:
      result.add(Dependency(
        symbol: child.getText(),
        kind: "include",
        path: child.getText()
      ))

  # Calls (nested invocations)
  let callNode = node.findChild("call")
  if callNode.isSome and callNode.get().children.len > 0:
    let callee = callNode.get().children[0]
    let calleeName = callee.getQualifiedName()
    if calleeName.len > 0:
      result.add(Dependency(
        symbol: calleeName,
        kind: "call",
        path: ""
      ))

  # Type references: (typeRef ...)
  let typeRefNode = node.findChild("typeRef")
  if typeRefNode.isSome:
    result.add(Dependency(
      symbol: typeRefNode.get().getText(),
      kind: "type-ref",
      path: ""
    ))

  # Direct child type references in type definitions
  for child in node.children:
    if child.nodeKind == nkSExpr and child.tag in ["sym", "exportedSym"]:
      let name = child.getQualifiedName()
      if name.len > 0:
        result.add(Dependency(
          symbol: name,
          kind: "type-ref",
          path: ""
        ))

proc extractMacroExpansion*(node: NifNode): seq[MacroExpansion] =
  ## Extract macro expansion information.
  result = @[]

  # Look for (expandedFrom ...) or (macroExp ...) nodes
  let expandedFrom = node.findChild("expandedFrom")
  if expandedFrom.isSome:
    var exp = MacroExpansion()
    if expandedFrom.get().children.len > 0:
      exp.macroName = expandedFrom.get().children[0].getText()
    if expandedFrom.get().children.len > 1:
      exp.expansionSite = expandedFrom.get().children[1].getText()
    if expandedFrom.get().children.len > 2:
      exp.outputAst = expandedFrom.get().children[2].getText()
    result.add(exp)

  # (macroExp ...)
  let macroExpNode = node.findChild("macroExp")
  if macroExpNode.isSome:
    var exp = MacroExpansion()
    for child in macroExpNode.get().children:
      if exp.macroName.len == 0:
        exp.macroName = child.getText()
      elif exp.expansionSite.len == 0:
        exp.expansionSite = child.getText()
      else:
        exp.outputAst = child.getText()
    result.add(exp)

  # (templateExpr ...) or (macroExpr ...) for template/macro bodies
  for tag in ["templateExpr", "macroExpr"]:
    let exprNode = node.findChild(tag)
    if exprNode.isSome:
      var exp = MacroExpansion()
      exp.macroName = tag
      exp.outputAst = $(exprNode.get())
      result.add(exp)

proc extractTemplateOverloads*(nodes: seq[NifNode]): seq[TemplateOverload] =
  ## Find template overloads across multiple definitions.
  result = @[]

  var overloadSigs: Table[string, seq[string]]  # name -> list of signatures
  var overloadDefs: Table[string, TemplateOverload]

  for node in nodes:
    if node.nodeKind == nkSExpr and node.tag in ["template", "macro"]:
      # Get name from (name ...) child, not from the node itself
      let nameNode = node.findChild("name")
      if nameNode.isSome:
        let name = nameNode.get().getQualifiedName()
        if name.len > 0:
          let sig = node.extractTypeSignature()

          if name notin overloadSigs:
            overloadSigs[name] = @[]
            overloadDefs[name] = TemplateOverload(
              name: name,
              signature: "",
              instantiationCount: 0,
              file: "",
              line: 0
            )
          overloadSigs[name].add(sig.raw)

  for name, sigs in overloadSigs:
    if sigs.len > 1:
      var ov = overloadDefs[name]
      ov.instantiationCount = sigs.len
      ov.signature = sigs.join(" | ")
      result.add(ov)

proc extractIncludeChain*(node: NifNode): seq[string] =
  ## Extract the include dependency chain.
  result = @[]
  let includeNode = node.findChild("include")
  if includeNode.isSome:
    for child in includeNode.get().children:
      result.add(child.getText())

proc extractSymbol*(node: NifNode, qualifiedPrefix: string = ""): ExtractedSymbol =
  ## Extract full symbol information from a NIF AST node.
  result = ExtractedSymbol()

  # Determine symbol name
  let nameNode = node.findChild("name")
  if nameNode.isSome:
    result.symbol = nameNode.get().getQualifiedName()
  elif node.children.len > 0:
    result.symbol = node.children[0].getQualifiedName()

  # Build fully qualified name
  if qualifiedPrefix.len > 0 and result.symbol.len > 0:
    result.symbol = qualifiedPrefix & "." & result.symbol

  # Symbol kind
  result.symbolKind = symbolKindFromTag(node.tag)
  result.rawNifTag = node.tag

  # Type signature
  result.typeSignature = node.extractTypeSignature()

  # Effect pragmas
  result.effectPragma = node.extractEffectPragma()

  # Dependencies
  result.dependencies = node.extractDependencies()

  # Macro expansions
  result.macroExpansions = node.extractMacroExpansion()

  # Include chain
  result.includeChain = node.extractIncludeChain()

  # Exported?
  let exportNode = node.findChild("export")
  let nmNode = node.findChild("name")
  result.isExported = exportNode.isSome
  # Also detect exportedSym inside name node
  if not result.isExported and nmNode.isSome:
    let nameChild = nmNode.get()
    if nameChild.children.len > 0 and nameChild.children[0].nodeKind == nkSExpr:
      result.isExported = nameChild.children[0].tag == "exportedSym"

  # Generic?
  let gpNode = node.findChild("genericParams")
  result.isGeneric = gpNode.isSome
  if gpNode.isSome:
    for child in gpNode.get().children:
      result.genericParams.add(child.getText())

  # Doc comment
  let docNode = node.findChild("docComment")
  if docNode.isSome:
    result.docComment = docNode.get().getText()

  # Location
  let lineNode = node.findChild("line")
  if lineNode.isSome:
    try:
      result.line = parseInt(lineNode.get().getText())
    except ValueError:
      discard

  # Nested symbols (for type definitions, etc.)
  for child in node.children:
    if child.nodeKind == nkSExpr and child.tag in [
        "proc", "func", "method", "template", "macro",
        "iterator", "converter", "type", "const", "var", "let"]:
      result.children.add(child.extractSymbol(result.symbol))

# ─── Deps & Interface Parsing ───────────────────────────────────────────────

proc parseDepsFile*(filename: string): seq[Dependency] =
  ## Parse a .deps.nif file.
  result = @[]
  let nodes = parseNifFile(filename)
  for node in nodes:
    if node.nodeKind == nkSExpr:
      case node.tag
      of "dep", "dependency":
        if node.children.len >= 2:
          result.add(Dependency(
            symbol: node.children[0].getText(),
            kind: node.children[1].getText(),
            path: if node.children.len >= 3: node.children[2].getText() else: ""
          ))
      of "import", "include":
        for child in node.children:
          result.add(Dependency(
            symbol: child.getText(),
            kind: node.tag,
            path: child.getText()
          ))

proc parseIfaceFile*(filename: string): Table[string, string] =
  ## Parse a .iface.nif file -> symbol -> interface hash.
  result = initTable[string, string]()
  let nodes = parseNifFile(filename)
  for node in nodes:
    if node.nodeKind == nkSExpr and node.tag in ["iface", "interface"]:
      if node.children.len >= 2:
        let symbol = node.children[0].getText()
        let hash = node.children[1].getText()
        if symbol.len > 0:
          result[symbol] = hash

# ─── Project-Level Extraction ───────────────────────────────────────────────

proc findNifFiles*(projectPath: string, pattern: string = "*.nif"): seq[string] =
  ## Find all .nif files in the project's nimcache.
  result = @[]

  # Common nimcache locations
  let nimcacheDirs = [
    projectPath / "nimcache",
    projectPath / "nimcache" / "release",
    projectPath / "nimcache" / "debug",
    projectPath / ".nimcache",
    projectPath / "build" / "nimcache",
    getHomeDir() / ".cache" / "nim" / extractFilename(projectPath)
  ]

  for dir in nimcacheDirs:
    if dirExists(dir):
      for kind, path in walkDir(dir, relative = false):
        if kind == pcFile and path.endsWith(".nif"):
          if pattern == "*.nif" or path.endsWith(pattern):
            result.add(path)

  # Also check for .deps.nif and .iface.nif if requested
  if pattern == "*.nif":
    for dir in nimcacheDirs:
      if dirExists(dir):
        for kind, path in walkDir(dir, relative = false):
          if kind == pcFile and (path.endsWith(".deps.nif") or path.endsWith(".iface.nif")):
            result.add(path)

  # If no nimcache found, look for .nif files in the project root
  if result.len == 0:
    for kind, path in walkDir(projectPath, relative = false):
      if kind == pcFile and path.endsWith(pattern):
        result.add(path)

proc symbolMatches*(symbolName: string, pattern: string): bool =
  ## Check if a symbol name matches the given pattern.
  ## Supports: exact match, prefix match with *, suffix with *, contains with *.
  if pattern == "*": return true
  if symbolName == pattern: return true

  # Check if pattern uses * as wildcard
  if '*' in pattern:
    let starIdx = pattern.find('*')
    # Find prefix (before first *) and suffix (after last *)
    let lastStar = pattern.rfind('*')
    let prefix = pattern[0..<starIdx]
    let suffix = pattern[(lastStar + 1)..^1]
    if not symbolName.startsWith(prefix): return false
    if not symbolName.endsWith(suffix): return false
    # Check middle part (between first and last *)
    if lastStar > starIdx:
      let middle = pattern[(starIdx + 1)..<lastStar]
      if middle.len > 0 and middle notin symbolName:
        return false
    return true

  # Check for "module.symbol" pattern
  if '.' in pattern:
    return symbolName == pattern or symbolName.endsWith("." & pattern)

  # Partial match
  return symbolName.contains(pattern)

# ─── JSON Serialization ─────────────────────────────────────────────────────

proc toJson*(sym: ExtractedSymbol): JsonNode =
  ## Convert an ExtractedSymbol to JSON.
  result = newJObject()
  result["symbol"] = newJString(sym.symbol)
  result["symbolKind"] = newJString(symbolKindName(sym.symbolKind))
  result["file"] = newJString(sym.file)
  result["line"] = newJInt(sym.line)
  result["column"] = newJInt(sym.column)
  result["isExported"] = newJBool(sym.isExported)
  result["isGeneric"] = newJBool(sym.isGeneric)
  result["rawNifTag"] = newJString(sym.rawNifTag)

  # Generic params
  var gpArr = newJArray()
  for gp in sym.genericParams:
    gpArr.add(newJString(gp))
  result["genericParams"] = gpArr

  # Doc comment
  result["docComment"] = newJString(sym.docComment)

  # Type signature
  var ts = newJObject()
  ts["raw"] = newJString(sym.typeSignature.raw)
  ts["returnType"] = newJString(sym.typeSignature.returnType)
  var params = newJArray()
  for p in sym.typeSignature.params:
    var pObj = newJObject()
    pObj["name"] = newJString(p.name)
    pObj["type"] = newJString(p.typeStr)
    if p.defaultVal.len > 0:
      pObj["default"] = newJString(p.defaultVal)
    params.add(pObj)
  ts["params"] = params
  var gp2 = newJArray()
  for gp in sym.typeSignature.genericParams:
    gp2.add(newJString(gp))
  ts["genericParams"] = gp2
  var prags = newJArray()
  for pr in sym.typeSignature.pragmas:
    prags.add(newJString(pr))
  ts["pragmas"] = prags
  result["typeSignature"] = ts

  # Effect pragmas
  var ep = newJObject()
  var tags = newJArray()
  for tag in sym.effectPragma.tags:
    tags.add(newJString(tag))
  ep["tags"] = tags
  ep["raw"] = newJString(sym.effectPragma.raw)
  result["effectPragma"] = ep

  # Dependencies
  var deps = newJArray()
  for d in sym.dependencies:
    var dObj = newJObject()
    dObj["symbol"] = newJString(d.symbol)
    dObj["kind"] = newJString(d.kind)
    if d.path.len > 0:
      dObj["path"] = newJString(d.path)
    deps.add(dObj)
  result["dependencies"] = deps

  # Macro expansions
  var macros = newJArray()
  for m in sym.macroExpansions:
    var mObj = newJObject()
    mObj["macroName"] = newJString(m.macroName)
    mObj["expansionSite"] = newJString(m.expansionSite)
    if m.outputAst.len > 0:
      mObj["outputAst"] = newJString(m.outputAst)
    macros.add(mObj)
  result["macroExpansions"] = macros

  # Include chain
  var includes = newJArray()
  for inc in sym.includeChain:
    includes.add(newJString(inc))
  result["includeChain"] = includes

  # Template overloads
  var tovs = newJArray()
  for t in sym.templateOverloads:
    var tObj = newJObject()
    tObj["name"] = newJString(t.name)
    tObj["signature"] = newJString(t.signature)
    tObj["instantiationCount"] = newJInt(t.instantiationCount)
    tovs.add(tObj)
  result["templateOverloads"] = tovs

  # Nested children
  if sym.children.len > 0:
    var childrenArr = newJArray()
    for child in sym.children:
      childrenArr.add(child.toJson())
    result["children"] = childrenArr

# ─── Extraction Engine ──────────────────────────────────────────────────────

proc newExtractor*(config: ExtractConfig): Extractor =
  Extractor(
    config: config,
    symbols: initTable[string, ExtractedSymbol](),
    fileIndex: initTable[string, NifNode](),
    depIndex: initTable[string, seq[NifNode]](),
    ifaceIndex: initTable[string, string]()
  )

# ─── Extraction Helpers (module-level to avoid capture issues) ───────────────

const symbolTags* = [
  "proc", "func", "method", "template", "macro",
  "iterator", "converter", "type", "const", "var", "let",
  "enum", "object", "distinct", "alias", "typeDef",
  "typeSection", "sym", "exportedSym"
]

proc processNode*(ext: Extractor, node: NifNode, fileName: string, depth: int = 0) =
  ## Recursively process NIF nodes and extract matching symbols.
  if ext.config.depth > 0 and depth > ext.config.depth:
    return

  if ext.config.verbose and depth < 3:
    var tagName = ""
    if node.nodeKind == nkSExpr: tagName = node.tag
    echo "  depth=" & $depth & " nodeKind=" & $node.nodeKind & " tag=" & tagName

  if node.nodeKind == nkSExpr and node.tag in symbolTags:
    var sym = node.extractSymbol()

    # Set file info
    sym.file = fileName

    # Check if any requested symbols match
    var shouldExtract = false
    if ext.config.symbols.len == 0:
      shouldExtract = sym.isExported
    else:
      for pattern in ext.config.symbols:
        if symbolMatches(sym.symbol, pattern):
          shouldExtract = true
          break

    if shouldExtract:
      # Add template overloads if requested
      if ext.config.includeTemplates:
        var allTemplates: seq[NifNode]
        for f, r in ext.fileIndex:
          for n in r.children:
            if n.nodeKind == nkSExpr and n.tag in ["template", "macro"]:
              if n.getQualifiedName() == sym.symbol:
                allTemplates.add(n)
        sym.templateOverloads = extractTemplateOverloads(allTemplates)

      # Add interface hash if available
      if sym.symbol in ext.ifaceIndex:
        sym.docComment = if sym.docComment.len > 0: sym.docComment
                         else: "interface-hash: " & ext.ifaceIndex[sym.symbol]

      ext.symbols[sym.symbol] = sym

  # Recurse into children
  if node.nodeKind == nkSExpr:
    for child in node.children:
      processNode(ext, child, fileName, depth + 1)

proc extract*(ext: var Extractor) =
  ## Main extraction routine: scan nimcache, parse NIF files, extract symbols.

  let projectPath = ext.config.projectPath
  if not dirExists(projectPath):
    raise newException(IOError, fmt"Project path does not exist: {projectPath}")

  # 1. Find all NIF files
  let nifFiles = findNifFiles(projectPath)
  if ext.config.verbose:
    echo fmt"Found {nifFiles.len} NIF files in {projectPath}"

  # 2. Parse and index all .nif files
  for file in nifFiles:
    if file.endsWith(".nif") and not file.endsWith(".deps.nif") and not file.endsWith(".iface.nif"):
      try:
        let nodes = parseNifFile(file)
        if nodes.len > 0:
          # Wrap all top-level nodes into a single root for traversal
          ext.fileIndex[file] = NifNode(nodeKind: nkSExpr, tag: "file", children: nodes)
          if ext.config.verbose:
            echo fmt"Parsed {file}: {nodes.len} top-level nodes"
      except IOError as e:
        if ext.config.verbose:
          echo fmt"Warning: could not parse {file}: {e.msg}"

  # 3. Parse .deps.nif files
  if ext.config.includeDeps:
    for file in nifFiles:
      if file.endsWith(".deps.nif"):
        try:
          let deps = parseDepsFile(file)
          for dep in deps:
            if dep.symbol notin ext.depIndex:
              ext.depIndex[dep.symbol] = @[]
          if ext.config.verbose:
            echo fmt"Parsed deps: {file}: {deps.len} dependencies"
        except IOError:
          discard

  # 4. Parse .iface.nif files
  if ext.config.includeIface:
    for file in nifFiles:
      if file.endsWith(".iface.nif"):
        try:
          let iface = parseIfaceFile(file)
          for sym, hash in iface:
            ext.ifaceIndex[sym] = hash
          if ext.config.verbose:
            echo fmt"Parsed iface: {file}: {iface.len} interfaces"
        except IOError:
          discard

  # 5. Extract matching symbols
  for file, root in ext.fileIndex:
    processNode(ext, root, file)

proc toContractJson*(ext: Extractor): string =
  ## Output in contract format: minimal JSON for AgentSwarm consumption.
  var result = newJObject()
  result["format"] = newJString("kimi-agent-swarm-nif-contract")
  result["version"] = newJString("1.0.0")
  result["generatedAt"] = newJString($now())
  result["projectPath"] = newJString(ext.config.projectPath)

  var symbolsArr = newJArray()
  for symName, sym in ext.symbols:
    var symJson = newJObject()
    symJson["symbol"] = newJString(sym.symbol)
    symJson["typeSignature"] = newJString(sym.typeSignature.raw)
    symJson["effectPragma"] = newJArray()
    for tag in sym.effectPragma.tags:
      symJson["effectPragma"].add(newJString(tag))
    symJson["dependencies"] = newJArray()
    for dep in sym.dependencies:
      var dObj = newJObject()
      dObj["symbol"] = newJString(dep.symbol)
      dObj["kind"] = newJString(dep.kind)
      symJson["dependencies"].add(dObj)
    symJson["macroExpanded"] = newJBool(sym.macroExpansions.len > 0)
    symJson["file"] = newJString(sym.file)
    symJson["line"] = newJInt(sym.line)
    symJson["kind"] = newJString(symbolKindName(sym.symbolKind))
    symbolsArr.add(symJson)

  result["symbols"] = symbolsArr
  result["totalSymbols"] = newJInt(ext.symbols.len)

  pretty(result, 2)

proc toFullJson*(ext: Extractor): string =
  ## Output full detailed JSON.
  var result = newJObject()
  result["format"] = newJString("kimi-agent-swarm-nif-full")
  result["version"] = newJString("1.0.0")
  result["generatedAt"] = newJString($now())
  result["projectPath"] = newJString(ext.config.projectPath)

  var symbolsArr = newJArray()
  for symName, sym in ext.symbols:
    symbolsArr.add(sym.toJson())
  result["symbols"] = symbolsArr
  result["totalSymbols"] = newJInt(ext.symbols.len)

  # Include dep index summary
  var depSummary = newJObject()
  for sym, deps in ext.depIndex:
    var depArr = newJArray()
    for d in deps:
      depArr.add(newJString(d.getText()))
    depSummary[sym] = depArr
  result["dependencyIndex"] = depSummary

  # Include iface index
  var ifaceSummary = newJObject()
  for sym, hash in ext.ifaceIndex:
    ifaceSummary[sym] = newJString(hash)
  result["interfaceIndex"] = ifaceSummary

  pretty(result, 2)

proc toMinimalJson*(ext: Extractor): string =
  ## Output minimal JSON: just symbol names and kinds.
  var result = newJObject()
  result["format"] = newJString("kimi-agent-swarm-nif-minimal")
  result["projectPath"] = newJString(ext.config.projectPath)

  var symbolsArr = newJArray()
  for symName, sym in ext.symbols:
    var symJson = newJObject()
    symJson["symbol"] = newJString(sym.symbol)
    symJson["kind"] = newJString(symbolKindName(sym.symbolKind))
    symJson["file"] = newJString(sym.file)
    symbolsArr.add(symJson)
  result["symbols"] = symbolsArr
  result["totalSymbols"] = newJInt(ext.symbols.len)

  pretty(result, 2)

# ─── CLI Entry Point ────────────────────────────────────────────────────────

proc printUsage() =
  echo """
nif-extractor — NIF Semantic Extractor for AgentSwarm

Usage:
  nif-extractor [OPTIONS]

Options:
  --project PATH     Project root path (required)
  --symbols PATTERN  Symbol patterns to extract (comma-separated, default: all exported)
                     Supports: exact match, prefix*, *suffix, *contains*
  --depth N          Recursion depth for nested symbols (0 = unlimited, default: 0)
  --format FORMAT    Output format: contract | full | minimal (default: contract)
  --include-deps     Also parse .deps.nif files
  --include-iface    Also parse .iface.nif files
  --include-macros   Extract macro expansion information
  --include-templates Extract template overloading information
  --verbose          Print progress information
  --help             Show this help message

Examples:
  nif-extractor --project /path/to/nim/project
  nif-extractor --project /path --symbols "z3.solveConstraint" --depth 2 --format contract
  nif-extractor --project /path --symbols "std/math.*, mymodule.*" --format full
  nif-extractor --project /path --include-deps --include-iface --verbose

Output (contract format):
  {
    "format": "kimi-agent-swarm-nif-contract",
    "symbols": [
      {
        "symbol": "z3.solveConstraint",
        "typeSignature": "(constraints: seq[Constraint]): bool",
        "effectPragma": ["gcsafe"],
        "dependencies": [...],
        "macroExpanded": false
      }
    ]
  }
"""

proc main() =
  var config = ExtractConfig(
    projectPath: "",
    symbols: @[],
    depth: 0,
    format: ofContract,
    includeDeps: true,
    includeIface: false,
    includeMacros: false,
    includeTemplates: false,
    verbose: false
  )

  # Parse command-line arguments (handle both --key=val and --key val forms)
  let args = commandLineParams()
  var i = 0
  while i < args.len:
    let arg = args[i]
    if arg == "--help" or arg == "-h":
      printUsage()
      quit(0)
    elif arg == "--verbose" or arg == "-v":
      config.verbose = true
    elif arg == "--include-deps":
      config.includeDeps = true
    elif arg == "--include-iface":
      config.includeIface = true
    elif arg == "--include-macros":
      config.includeMacros = true
    elif arg == "--include-templates":
      config.includeTemplates = true
    elif arg.startsWith("--") or (arg.len == 2 and arg[0] == '-'):
      # Parse --key=value or --key value or -k value
      var key: string
      var val: string
      if '=' in arg:
        let eqPos = arg.find('=')
        key = arg[1..^1]  # skip leading -
        if key.startsWith("-"): key = key[1..^1]  # skip second -
        val = arg[(eqPos+1)..^1]
      else:
        key = arg[1..^1]
        if key.startsWith("-"): key = key[1..^1]
        # Get value from next arg
        if i + 1 < args.len and not args[i+1].startsWith("-"):
          val = args[i+1]
          inc i
        else:
          val = ""

      case key
      of "project", "p":
        config.projectPath = val
      of "symbols", "s":
        config.symbols = val.split(",").mapIt(it.strip())
      of "depth", "d":
        try:
          config.depth = parseInt(val)
        except ValueError:
          echo "Error: --depth must be an integer"
          quit(1)
      of "format", "f":
        let fmtVal = val.toLower()
        case fmtVal
        of "contract": config.format = ofContract
        of "full": config.format = ofFull
        of "minimal": config.format = ofMinimal
        else:
          echo fmt"Error: Unknown format '{val}'. Use: contract, full, minimal"
          quit(1)
      else:
        echo fmt"Unknown option: --{key}"
        printUsage()
        quit(1)
    inc i

  # Validate required arguments
  if config.projectPath.len == 0:
    echo "Error: --project is required"
    printUsage()
    quit(1)

  if not dirExists(config.projectPath):
    echo fmt"Error: Project path does not exist: {config.projectPath}"
    quit(1)

  # Run extraction
  if config.verbose:
    echo fmt"Extracting symbols from: {config.projectPath}"
    if config.symbols.len > 0:
      let sep = ", "
      echo fmt"Symbol patterns: {config.symbols.join(sep)}"
    else:
      echo "Extracting all exported symbols"

  var extractor = newExtractor(config)

  try:
    extractor.extract()
  except IOError as e:
    echo fmt"IO Error: {e.msg}"
    quit(1)
  except ValueError as e:
    echo fmt"Parse Error: {e.msg}"
    quit(1)
  except CatchableError as e:
    echo fmt"Error: {e.msg}"
    if config.verbose:
      echo getStackTrace(e)
    quit(1)

  if config.verbose:
    echo fmt"Extracted {extractor.symbols.len} symbols"

  # Output results
  let output = case config.format
    of ofContract: extractor.toContractJson()
    of ofFull: extractor.toFullJson()
    of ofMinimal: extractor.toMinimalJson()

  echo output

when isMainModule:
  main()
