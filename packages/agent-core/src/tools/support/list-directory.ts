/**
 * list-directory — compact directory tree for LLM context.
 *
 * Used by GlobTool when rejecting a `**`-leading pattern: appending a
 * snapshot of the workspace root helps the LLM re-scope its pattern
 * without a second round-trip.
 *
 * Width caps keep the system-prompt token budget bounded:
 *   - Depth 0 (root):  up to LIST_DIR_ROOT_WIDTH entries
 *   - Depth 1+ (children): up to LIST_DIR_CHILD_WIDTH entries
 *   - Truncated levels show "... and N more" so the LLM knows more exists.
 *
 * Optional smart-pruning controls (used by the system-prompt context):
 *   - maxDepth:       recurse up to N levels (default 2 for backward compat)
 *   - skipDirs:       directory names to skip entirely (e.g. node_modules)
 *   - maxEntries:     collapse dirs with >N entries into a count summary
 */

import { basename, join } from 'pathe';

import type { Kaos } from '@moonshot-ai/kaos';

export const LIST_DIR_ROOT_WIDTH = 30;
export const LIST_DIR_CHILD_WIDTH = 10;

export interface ListDirectoryOptions {
  readonly collapseHiddenDirs?: boolean;
  /** Maximum tree depth to render. 0 = root only, 1 = root + children, etc. Default 2. */
  readonly maxDepth?: number;
  /** Directory names to skip entirely (never recurse into). */
  readonly skipDirs?: ReadonlySet<string>;
  /** When a directory has more than this many entries, collapse it to a count summary. */
  readonly maxEntries?: number;
}

interface Entry {
  readonly name: string;
  readonly isDir: boolean;
}

async function collectEntries(
  kaos: Kaos,
  dirPath: string,
  maxWidth: number,
): Promise<{ entries: Entry[]; total: number; readable: boolean }> {
  const all: Entry[] = [];
  try {
    for await (const fullPath of kaos.iterdir(dirPath)) {
      const name = basename(fullPath);
      let isDir = false;
      try {
        const st = await kaos.stat(fullPath);
        // StatResult mirrors POSIX stat; derive the file type from the
        // mode bits (S_IFMT mask → S_IFDIR == 0o040000).
        isDir = (st.stMode & 0o170000) === 0o040000;
      } catch {
        // Unreadable entries keep isDir=false; still list the name.
      }
      all.push({ name, isDir });
    }
  } catch {
    return { entries: [], total: 0, readable: false };
  }
  all.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { entries: all.slice(0, maxWidth), total: all.length, readable: true };
}

function shouldCollapseDirectory(entry: Entry, options: ListDirectoryOptions): boolean {
  return options.collapseHiddenDirs === true && entry.isDir && entry.name.startsWith('.');
}

/**
 * Recursively render a directory tree level. Returns an array of formatted
 * lines with tree-style connectors and prefix indentation.
 */
async function renderTree(
  kaos: Kaos,
  dirPath: string,
  depth: number,
  maxDepth: number,
  maxWidth: number,
  skipDirs: ReadonlySet<string>,
  maxEntries: number | undefined,
  options: ListDirectoryOptions,
  prefix: string,
): Promise<string[]> {
  const { entries, total, readable } = await collectEntries(kaos, dirPath, maxWidth);

  if (!readable) {
    return [`${prefix}[not readable]`];
  }

  // Collapse directories exceeding the entry threshold (skip root level so the
  // top-level overview is always visible).
  if (depth > 0 && maxEntries !== undefined && total > maxEntries) {
    return [`${prefix}... (${String(total)} entries)`];
  }

  const lines: string[] = [];
  const remaining = total - entries.length;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const { name, isDir } = entry;
    const entryIsLast = i === entries.length - 1 && remaining === 0;
    const connector = entryIsLast ? '└── ' : '├── ';

    if (isDir) {
      lines.push(`${prefix}${connector}${name}/`);

      // Skip hidden dirs when collapseHiddenDirs is set
      if (shouldCollapseDirectory(entry, options)) continue;
      // Skip explicitly excluded directories
      if (skipDirs.has(name)) continue;

      // Recurse if depth allows
      if (depth < maxDepth) {
        const childPrefix = prefix + (entryIsLast ? '    ' : '│   ');
        const childLines = await renderTree(
          kaos,
          join(dirPath, name),
          depth + 1,
          maxDepth,
          LIST_DIR_CHILD_WIDTH,
          skipDirs,
          maxEntries,
          options,
          childPrefix,
        );
        lines.push(...childLines);
      }
    } else {
      lines.push(`${prefix}${connector}${name}`);
    }
  }

  if (remaining > 0) {
    const suffix = depth === 0 ? ' entries' : '';
    lines.push(`${prefix}└── ... and ${String(remaining)} more${suffix}`);
  }

  return lines;
}

/**
 * Return a compact directory tree of `workDir` suitable for inclusion in a
 * tool error message or system prompt. Returns `"(empty directory)"` if the
 * directory is empty, or an error marker line if the directory itself is
 * unreadable.
 */
export async function listDirectory(
  kaos: Kaos,
  workDir: string = kaos.getcwd(),
  options: ListDirectoryOptions = {},
): Promise<string> {
  const maxDepth = options.maxDepth ?? 2;
  const skipDirs = options.skipDirs ?? new Set<string>();
  const lines = await renderTree(
    kaos,
    workDir,
    0,
    maxDepth,
    LIST_DIR_ROOT_WIDTH,
    skipDirs,
    options.maxEntries,
    options,
    '',
  );
  return lines.length > 0 ? lines.join('\n') : '(empty directory)';
}
