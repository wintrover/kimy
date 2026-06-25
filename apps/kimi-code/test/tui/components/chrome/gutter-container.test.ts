import type { Component } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { GutterContainer } from '#/tui/components/chrome/gutter-container';
import type { RenderDiagnostics } from '#/tui/render-diagnostics';

class FakeChild implements Component {
  constructor(
    private readonly lines: (innerWidth: number) => string[],
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    return this.lines(width);
  }
}

describe('GutterContainer', () => {
  it('prefixes every child line with `left` spaces', () => {
    const c = new GutterContainer(2, 2);
    c.addChild(new FakeChild(() => ['hello', 'world']));
    expect(c.render(20)).toEqual(['  hello', '  world']);
  });

  it('shrinks the width passed to children by left + right', () => {
    const seenWidth = vi.fn<(w: number) => string[]>(() => ['x']);
    const c = new GutterContainer(2, 3);
    c.addChild(new FakeChild(seenWidth));
    c.render(20);
    expect(seenWidth).toHaveBeenCalledWith(15);
  });

  it('clamps inner width to at least 1 when gutters would otherwise consume it', () => {
    const seenWidth = vi.fn<(w: number) => string[]>(() => ['x']);
    const c = new GutterContainer(5, 5);
    c.addChild(new FakeChild(seenWidth));
    c.render(2);
    expect(seenWidth).toHaveBeenCalledWith(1);
  });

  it('stacks lines from multiple children in order', () => {
    const c = new GutterContainer(1, 0);
    c.addChild(new FakeChild(() => ['a1', 'a2']));
    c.addChild(new FakeChild(() => ['b1']));
    expect(c.render(10)).toEqual([' a1', ' a2', ' b1']);
  });

  it('returns an empty array when there are no children', () => {
    const c = new GutterContainer(2, 2);
    expect(c.render(20)).toEqual([]);
  });

  it('preserves ANSI sequences within child lines (only the leading pad is plain)', () => {
    const colored = '\u001B[31mred\u001B[0m';
    const c = new GutterContainer(2, 2);
    c.addChild(new FakeChild(() => [colored]));
    expect(c.render(20)).toEqual([`  ${colored}`]);
  });

  describe('maxHeight', () => {
    it('clamps output via constructor maxHeight, preserving last N lines', () => {
      const c = new GutterContainer(0, 0, 3);
      c.addChild(new FakeChild(() => ['a', 'b', 'c', 'd', 'e']));
      expect(c.render(40)).toEqual(['c', 'd', 'e']);
    });

    it('clamps output when maxHeight set via setMaxHeight', () => {
      const c = new GutterContainer(0, 0);
      c.addChild(new FakeChild(() => ['a', 'b', 'c', 'd', 'e']));
      c.setMaxHeight(3);
      expect(c.render(40)).toEqual(['c', 'd', 'e']);
    });

    it('returns all lines when maxHeight is unset', () => {
      const c = new GutterContainer(0, 0);
      c.addChild(new FakeChild(() => ['a', 'b', 'c', 'd', 'e']));
      expect(c.render(40)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('returns all lines when maxHeight exceeds content length', () => {
      const c = new GutterContainer(0, 0, 10);
      c.addChild(new FakeChild(() => ['a', 'b', 'c']));
      expect(c.render(40)).toEqual(['a', 'b', 'c']);
    });

    it('removes clamping when setMaxHeight(undefined) is called', () => {
      const c = new GutterContainer(0, 0, 3);
      c.addChild(new FakeChild(() => ['a', 'b', 'c', 'd', 'e']));
      expect(c.render(40)).toEqual(['c', 'd', 'e']);
      c.setMaxHeight(undefined);
      expect(c.render(40)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('getMaxHeight reflects constructor and setMaxHeight values', () => {
      const c = new GutterContainer(0, 0, 5);
      expect(c.getMaxHeight()).toBe(5);
      c.setMaxHeight(2);
      expect(c.getMaxHeight()).toBe(2);
      c.setMaxHeight(undefined);
      expect(c.getMaxHeight()).toBeUndefined();
    });
  });

  describe('clamp diagnostic recording', () => {
    it('records a clamp event when maxHeight truncates content', () => {
      const mockDiagnostics = { record: vi.fn() } as unknown as RenderDiagnostics;
      const c = new GutterContainer(0, 0, 2, mockDiagnostics);
      c.addChild(new FakeChild(() => ['a', 'b', 'c', 'd', 'e']));
      c.render(40);
      expect(mockDiagnostics.record).toHaveBeenCalledOnce();
      expect(mockDiagnostics.record).toHaveBeenCalledWith({
        type: 'clamp',
        caller: expect.stringContaining('lines=5'),
        force: false,
        depth: 0,
        suppressedCount: 0,
      });
    });

    it('does not record when content fits within maxHeight', () => {
      const mockDiagnostics = { record: vi.fn() } as unknown as RenderDiagnostics;
      const c = new GutterContainer(0, 0, 10, mockDiagnostics);
      c.addChild(new FakeChild(() => ['a', 'b']));
      c.render(40);
      expect(mockDiagnostics.record).not.toHaveBeenCalled();
    });

    it('does not record when no diagnostics instance is provided', () => {
      const c = new GutterContainer(0, 0, 2);
      c.addChild(new FakeChild(() => ['a', 'b', 'c']));
      expect(() => c.render(40)).not.toThrow();
    });
  });
});
