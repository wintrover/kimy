import path from 'node:path';

/**
 * NFC-normalized VFS relative path with rootDir stripped.
 * Can only be created through {@link VFSPathFactory.create}.
 */
export type CanonicalVFSPath = string & { readonly __canonicalVFS: unique symbol };

/**
 * Factory that canonicalizes raw filesystem paths into {@link CanonicalVFSPath}.
 *
 * Normalization steps:
 * 1. Unicode NFC normalization
 * 2. Backslash → forward slash
 * 3. `path.posix.normalize` (resolve `..`, `//`)
 * 4. Strip rootDir prefix → relative path
 */
export class VFSPathFactory {
  private readonly _nfcRoot: string;

  constructor(private readonly rootDir: string) {
    this._nfcRoot = rootDir.normalize('NFC');
  }

  create(rawPath: string): CanonicalVFSPath {
    let normalized = rawPath.normalize('NFC');
    normalized = normalized.replace(/\\/g, '/');
    normalized = path.posix.normalize(normalized);

    const nfcRoot = this._nfcRoot;
    if (normalized.startsWith(nfcRoot + '/')) {
      normalized = normalized.slice(nfcRoot.length + 1);
    } else if (normalized === nfcRoot || normalized === '.') {
      normalized = '';
    }
    return normalized as CanonicalVFSPath;
  }
}

/**
 * Deterministic comparison for merkle tree sorting.
 * Uses UTF-8 byte order (not JS string codepoint order) for cross-platform consistency.
 */
export const compareCanonicalPath = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
