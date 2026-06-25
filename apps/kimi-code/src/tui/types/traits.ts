/**
 * ISP (Interface Segregation Principle) trait interfaces for host controllers.
 *
 * Each trait represents a single capability that a host can provide.
 * Controllers compose the traits they need via intersection types,
 * ensuring they only depend on the capabilities they actually use.
 *
 * Methods that combine pi-tui internal operations (e.g. addChild + requestRender)
 * are designed as atomic operations — callers cannot forget to request a re-render.
 */

import type { Component } from '@earendil-works/pi-tui';

/** Controllers that need to trigger a re-render. */
export interface Renderable {
  requestRender(): void;
}

/** Controllers that need to return focus to the editor. */
export interface FocusableHost {
  focusEditor(): void;
}

/**
 * Controllers that manipulate the transcript container.
 *
 * All mutating methods are atomic: they perform the container operation
 * and call requestRender() internally, making it structurally impossible
 * to forget the re-render.
 */
export interface TranscriptContainerHost {
  addTranscriptChild(component: Component): void;
  findTranscriptChild(predicate: (child: Component) => boolean): Component | undefined;
  replaceTranscriptChild(old: Component, replacement: Component): void;
  spliceTranscriptChildren(index: number, deleteCount: number): Component[];
}

/** Controllers that display transient hints in the footer. */
export interface Hintable {
  setTransientHint(text: string | null): void;
}

/** Controllers that need terminal dimensions. */
export interface TerminalSizable {
  getTerminalSize(): { rows: number; columns: number };
}
