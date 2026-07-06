/**
 * Static Ring Buffer for GC Zero-Allocation data passing to Nim.
 *
 * Pre-allocated once at boot. Every tick writes data in-place
 * without creating new Uint8Array instances, ensuring V8 GC events = 0.
 *
 * Buffer layout: [MAGIC:4B][TOTAL_LEN:4B][PAYLOAD:...]
 * MAGIC = 0x4158494D ('AXIM' in little-endian)
 */

const MAGIC_NUMBER = 0x4158494d; // 'AXIM'
const HEADER_SIZE = 8; // 4B magic + 4B total length

export class StaticRingBuffer {
  private readonly buffer: Uint8Array;
  private readonly view: DataView;
  private writeOffset: number = 0;

  constructor(size: number = 65536) {
    // Pre-allocate once — never replaced during lifetime
    this.buffer = new Uint8Array(size);
    this.view = new DataView(
      this.buffer.buffer,
      this.buffer.byteOffset,
      this.buffer.byteLength,
    );
  }

  /**
   * Write a frame with magic number header + payload.
   * Returns the offset and total length for Nim to read.
   * No new object allocation — writes in-place.
   */
  writeFrame(payload: Uint8Array): { offset: number; length: number } {
    const totalLength = HEADER_SIZE + payload.length;
    if (this.writeOffset + totalLength > this.buffer.length) {
      throw new Error(
        `Ring buffer overflow: need ${totalLength} bytes, have ${this.buffer.length - this.writeOffset}`,
      );
    }

    // Write header in-place
    this.view.setUint32(this.writeOffset, MAGIC_NUMBER, true); // little-endian
    this.view.setUint32(this.writeOffset + 4, totalLength, true);

    // Write payload in-place (no new allocation)
    this.buffer.set(payload, this.writeOffset + HEADER_SIZE);

    const result = { offset: this.writeOffset, length: totalLength };
    this.writeOffset += totalLength;
    return result;
  }

  /**
   * Get a Uint8Array view of the entire buffer (for passing to native).
   * Returns the same underlying buffer — zero copy.
   */
  getBuffer(): Uint8Array {
    return this.buffer;
  }

  /**
   * Get a Uint8Array view of a specific frame (for passing to native).
   * Returns a subarray view — zero copy, same underlying buffer.
   */
  getFrameView(offset: number, length: number): Uint8Array {
    return this.buffer.subarray(offset, offset + length);
  }

  /**
   * Reset write offset for next tick.
   * Does not zero memory — just resets the pointer.
   */
  reset(): void {
    this.writeOffset = 0;
  }

  /** Buffer capacity in bytes. */
  get capacity(): number {
    return this.buffer.length;
  }

  /** Current write offset. */
  get offset(): number {
    return this.writeOffset;
  }
}
