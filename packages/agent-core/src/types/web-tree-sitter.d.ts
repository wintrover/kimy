/**
 * Minimal ambient type declarations for `web-tree-sitter`.
 *
 * The `web-tree-sitter` npm package ships no bundled types.  This shim
 * covers only the API surface actually used by this package — it is not
 * a complete upstream typings replacement.
 *
 * @see https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web
 */

declare module 'web-tree-sitter' {
  /** A point in source expressed as (row, column). */
  interface Point {
    readonly row: number;
    readonly column: number;
  }

  /** Range of a node in the source, by byte offset and point. */
  interface Range {
    readonly startIndex: number;
    readonly endIndex: number;
    readonly startPosition: Point;
    readonly endPosition: Point;
  }

  /** An edit used by `tree.edit()` for incremental re-parsing. */
  interface Edit {
    readonly startIndex: number;
    readonly oldEndIndex: number;
    readonly newEndIndex: number;
    readonly startPosition: Point;
    readonly oldEndPosition: Point;
    readonly newEndPosition: Point;
  }

  /** A single node in the concrete syntax tree. */
  interface SyntaxNode {
    readonly id: number;
    readonly type: string;
    readonly isNamed: boolean;
    readonly text: string;
    readonly parent: SyntaxNode | null;
    readonly children: readonly SyntaxNode[];
    readonly namedChildren: readonly SyntaxNode[];
    readonly childCount: number;
    readonly startIndex: number;
    readonly endIndex: number;
    readonly startPosition: Point;
    readonly endPosition: Point;
    readonly hasError: boolean;
    readonly hasChildren: boolean;

    child(index: number): SyntaxNode | null;
    namedChild(index: number): SyntaxNode | null;
    childForFieldName(fieldName: string): SyntaxNode | null;
    fieldNameForChild(childIndex: number): string | null;
  }

  /** A parsed syntax tree. */
  interface Tree {
    readonly rootNode: SyntaxNode;
    edit(edit: Edit): void;
  }

  /** A loaded tree-sitter language grammar. */
  interface Language {
    readonly name: string | undefined;
  }

  /** The default `Parser` class exported by `web-tree-sitter`. */
  class Parser {
    /** Initialise the WASM runtime. Must be called before any parsing. */
    static init(): Promise<void>;

    /** Load a language grammar from a `.wasm` file path or URL. */
    static Language: {
      load(wasmPath: string): Promise<Language>;
    };

    constructor();

    /** Set the language grammar to use for subsequent parses. */
    setLanguage(language: Language): void;

    /** Parse source text and return a syntax tree. */
    parse(source: string, oldTree?: Tree): Tree;
  }

  export default Parser;
}
