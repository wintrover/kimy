import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

type RenderEventType = 'request' | 'suppress' | 'commit' | 'flush';

interface RenderEvent {
  readonly ts: number;
  readonly type: RenderEventType;
  readonly caller: string;
  readonly force: boolean;
  readonly depth: number;
  readonly suppressedCount: number;
}

const INTERNAL_FRAME_PATTERNS = [
  'render-diagnostics',
  'render-transaction',
  'node_modules',
];

/**
 * V8 CallSite API based caller capture. Walks the stack to find the first
 * frame that isn't an internal frame, returning a human-readable label.
 */
export function captureCaller(): string {
  // oxlint-disable-next-line typescript-eslint(unbound-method)
  const saved = Error.prepareStackTrace;
  let caller = 'unknown-context';
  try {
    Error.prepareStackTrace = (_err, callSites) => {
      for (const cs of callSites) {
        const file = cs.getFileName() ?? '';
        const func = cs.getFunctionName() ?? cs.getMethodName() ?? '';
        if (INTERNAL_FRAME_PATTERNS.some((p) => file.includes(p))) continue;
        const shortFile = file.split('/').slice(-2).join('/');
        const line = cs.getLineNumber();
        caller = func ? `${func} (${shortFile}:${line})` : `${shortFile}:${line}`;
        return callSites;
      }
      return callSites;
    };
    const obj: { stack?: unknown } = {};
    Error.captureStackTrace(obj, captureCaller);
    void obj.stack;
  } finally {
    Error.prepareStackTrace = saved;
  }
  return caller;
}

/**
 * Ring-buffer based render diagnostics store. Records render-related events
 * for debugging render storms, excessive suppression, and flush ordering.
 */
export class RenderDiagnostics {
  private buffer: RenderEvent[];
  private head = 0;
  private count = 0;
  private readonly capacity: number;
  private postCommit = false;
  private violationCount = 0;
  private lastDumpTime = 0;
  private lastDumpPath: string | null = null;
  private static readonly DUMP_COOLDOWN_MS = 5_000;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(capacity = 500) {
    this.capacity = capacity;
    this.buffer = Array.from({ length: capacity });
  }

  record(event: Omit<RenderEvent, 'ts'>): void {
    const fullEvent: RenderEvent = { ...event, ts: performance.now() };
    this.buffer[this.head] = fullEvent;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  getEvents(): readonly RenderEvent[] {
    if (this.count < this.capacity) {
      return this.buffer.slice(0, this.count);
    }
    // Wrap-around: head..end, then 0..head
    return [
      ...this.buffer.slice(this.head),
      ...this.buffer.slice(0, this.head),
    ];
  }

  get totalRecorded(): number {
    return this.count;
  }

  async dumpToFile(dir?: string): Promise<string> {
    const resolvedDir = dir ?? '/tmp/kimi-code';
    await mkdir(resolvedDir, { recursive: true });
    const ts = new Date().toISOString().replaceAll(/[:.]/g, '-');
    const filePath = join(resolvedDir, `render-log-${ts}.jsonl`);
    const lines = this.getEvents().map((e) => JSON.stringify(e));
    await writeFile(filePath, lines.join('\n') + '\n');
    return filePath;
  }

  /** Called by commitRenderBatch after outermost commit. Sets a tick-boundary flag. */
  setPostCommit(): void {
    this.postCommit = true;
    process.nextTick(() => { this.postCommit = false; });
  }

  /**
   * Check structural invariants on a render event.
   * Returns a violation reason string, or null if no violation.
   *
   * Invariant 1 (Transaction Leak): During streaming, requestRender must be inside a transaction.
   * Invariant 2 (Frame Multiplication): No requestRender in the same tick as a commit.
   */
  checkInvariant(event: Omit<RenderEvent, 'ts'>, isStreaming: boolean): string | null {
    // Invariant 1: Transaction Leak — streaming active but depth === 0
    if (event.type === 'request' && isStreaming && event.depth === 0) {
      return 'Transaction Leak';
    }
    // Invariant 2: Frame Multiplication — requestRender in same tick as commit
    if (event.type === 'request' && this.postCommit) {
      return 'Frame Multiplication';
    }
    return null;
  }

  /** Trigger automatic log dump on invariant violation (TUI-safe: no stderr output). */
  triggerAutoDump(reason: string, caller?: string): void {
    this.violationCount++;
    const now = Date.now();
    if (now - this.lastDumpTime >= RenderDiagnostics.DUMP_COOLDOWN_MS) {
      this.lastDumpTime = now;
      // Chain onto pendingWrite to preserve ordering; errors are swallowed.
      this.pendingWrite = this.pendingWrite
        .then(() => this.dumpAppendix(reason, caller))
        .catch(() => { this.lastDumpPath = null; });
    }
  }

  private async dumpAppendix(reason: string, caller?: string): Promise<void> {
    if (this.lastDumpPath !== null) {
      await mkdir(dirname(this.lastDumpPath), { recursive: true });
      const entry = JSON.stringify({ ts: performance.now(), violation: reason, caller: caller ?? '' });
      await appendFile(this.lastDumpPath, entry + '\n');
    } else {
      this.lastDumpPath = await this.dumpToFile();
    }
  }

  /** Wait for pending async I/O to complete. Gives up after timeoutMs. */
  async flush(timeoutMs = 2000): Promise<void> {
    await Promise.race([
      this.pendingWrite,
      new Promise<void>((resolve) => { setTimeout(resolve, timeoutMs); }),
    ]);
  }

  /** Number of invariant violations detected. */
  getViolationCount(): number {
    return this.violationCount;
  }
}

export function isEnabled(): boolean {
  return process.env['KIMI_CODE_RENDER_DEBUG'] === '1';
}

let _instance: RenderDiagnostics | null = null;
export function getDiagnostics(): RenderDiagnostics {
  if (_instance === null) _instance = new RenderDiagnostics();
  return _instance;
}
