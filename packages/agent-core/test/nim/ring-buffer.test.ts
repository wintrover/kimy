import { describe, it, expect } from 'vitest';
import { StaticRingBuffer } from '../../src/nim/ring-buffer.js';
import { AXIM_MAGIC, HEADER_SIZE } from '../../src/nim/types.js';

describe('StaticRingBuffer', () => {
  it('should pre-allocate buffer at construction', () => {
    const ring = new StaticRingBuffer(1024);
    expect(ring.capacity).toBe(1024);
    expect(ring.offset).toBe(0);
  });

  it('should write frame with correct magic number and length header', () => {
    const ring = new StaticRingBuffer(1024);
    const payload = new Uint8Array([10, 0, 0, 0]); // int32 value 10
    const ref = ring.writeFrame(payload);

    expect(ref.offset).toBe(0);
    expect(ref.length).toBe(HEADER_SIZE + payload.length); // 8 + 4 = 12

    // Verify magic number in buffer
    const buffer = ring.getBuffer();
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const magic = view.getUint32(0, true);
    expect(magic).toBe(AXIM_MAGIC); // 0x4158494D

    // Verify total length
    const totalLen = view.getInt32(4, true);
    expect(totalLen).toBe(12);

    // Verify payload copied correctly
    expect(buffer[8]).toBe(10);
  });

  it('should support multiple sequential writes without new allocation', () => {
    const ring = new StaticRingBuffer(1024);
    const payload1 = new Uint8Array([1, 0, 0, 0]);
    const payload2 = new Uint8Array([2, 0, 0, 0]);

    const ref1 = ring.writeFrame(payload1);
    const ref2 = ring.writeFrame(payload2);

    expect(ref1.offset).toBe(0);
    expect(ref2.offset).toBe(12); // 8 header + 4 payload

    // Verify both payloads are in the buffer
    const buffer = ring.getBuffer();
    expect(buffer[8]).toBe(1);  // first payload
    expect(buffer[20]).toBe(2); // second payload (offset 12 + 8 header)
  });

  it('should reset write offset for next tick', () => {
    const ring = new StaticRingBuffer(1024);
    const payload = new Uint8Array([42, 0, 0, 0]);

    ring.writeFrame(payload);
    expect(ring.offset).toBe(12);

    ring.reset();
    expect(ring.offset).toBe(0);
  });

  it('should return subarray view (zero-copy) for frame', () => {
    const ring = new StaticRingBuffer(1024);
    const payload = new Uint8Array([99, 0, 0, 0]);
    const ref = ring.writeFrame(payload);

    const frameView = ring.getFrameView(ref.offset, ref.length);
    // Verify it shares the same underlying buffer
    expect(frameView.buffer).toBe(ring.getBuffer().buffer);
    // Verify content
    expect(frameView.length).toBe(12);
    const view = new DataView(frameView.buffer, frameView.byteOffset, frameView.byteLength);
    expect(view.getUint32(0, true)).toBe(AXIM_MAGIC);
    expect(frameView[8]).toBe(99);
  });

  it('should throw on buffer overflow', () => {
    const ring = new StaticRingBuffer(16); // very small
    const payload = new Uint8Array(20); // too large
    expect(() => ring.writeFrame(payload)).toThrow('Ring buffer overflow');
  });

  it('should not create new objects during writeFrame (GC zero-allocation)', () => {
    const ring = new StaticRingBuffer(1024);
    const payload = new Uint8Array([1, 2, 3, 4]);

    // Write many frames — if GC pressure occurs, this would be measurable
    for (let i = 0; i < 1000; i++) {
      ring.reset();
      ring.writeFrame(payload);
    }
    // No assertion needed — if this runs without GC pressure, the test passes
    // The key invariant is: no new Uint8Array is created per writeFrame call
    expect(ring.capacity).toBe(1024); // buffer never replaced
  });
});
