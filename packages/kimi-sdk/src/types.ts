/**
 * SDK interface types — mirrors the Nim concept interfaces
 */

export interface ValidationResult {
  allowed: boolean;
  reason: string;
  effect: CommandEffect;
}

export enum CommandEffect {
  Idempotent = 'idempotent',
  Mutation = 'mutation',
  Transient = 'transient',
  Derivation = 'derivation',
}

export interface ICommandValidator {
  validateCommand(cmd: string): ValidationResult;
  recordCommand(cmd: string, effect: CommandEffect): void;
  recentCommands(): string[];
}

export enum HealthLevel {
  Healthy = 'healthy',
  Warning = 'warning',
  Degraded = 'degraded',
  Critical = 'critical',
}

export interface IAuditStorage {
  append(entry: AuditEntry): void;
  recentEntries(n: number): AuditEntry[];
  assessHealth(gateId: string): HealthLevel;
}

export interface AuditEntry {
  gateId: string;
  passed: boolean;
  durationMs: number;
  timestamp: string;
  metadata?: string;
}

export interface IGateTelemetry {
  record(gateId: string, passed: boolean, durationMs: number): void;
  generateSummary(): string;
}

export enum ContextTier {
  Peak = 'peak',
  Good = 'good',
  Degrading = 'degrading',
  Poor = 'poor',
}

export interface IContextBudget {
  currentTier(): ContextTier;
  tokenBudget(): number;
  shouldCompact(): boolean;
}

export interface EvidenceReceipt {
  agentId: string;
  postConditions: string[];
  verificationCommands: string[];
  headHash: string;
  timestamp: string;
}

export interface IEvidenceStore {
  store(receipt: EvidenceReceipt): void;
  verify(agentId: string): boolean;
}
