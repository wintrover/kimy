/**
 * @moonshot-ai/kimi-sdk
 *
 * Platform interface contracts for Kimi Code extensions.
 * Projects consume these interfaces; the platform provides implementations.
 *
 * The actual SDK interfaces are defined in Nim (src/interfaces/*.nim)
 * for consumption by Nim-based projects like Axiom.
 * This TypeScript barrel provides type definitions for TypeScript-based extensions.
 */

// Re-export interface types
export * from './types';
