import { afterEach, describe, expect, it, vi } from "vitest";
import { writeToStdout } from "./stdout.js";

type FdWrite = (fd: number, buffer: Buffer, offset: number) => number;

function failingOnce(code: string, write: FdWrite): FdWrite {
  let failed = false;
  return (fd, buffer, offset) => {
    if (!failed) {
      failed = true;
      throw Object.assign(new Error(code), { code });
    }
    return write(fd, buffer, offset);
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("writeToStdout", () => {
  it("writes the whole text to fd 1", () => {
    const calls: Array<[number, string]> = [];
    writeToStdout('{"a":1}\n', (fd, buffer) => {
      calls.push([fd, buffer.toString()]);
      return buffer.length;
    });
    expect(calls).toEqual([[1, '{"a":1}\n']]);
  });

  it("continues after a partial write, including across multi-byte characters", () => {
    const chunks: Buffer[] = [];
    const written: number[] = [];
    writeToStdout('{"summary":"héllo wörld"}\n', (_fd, buffer, offset) => {
      // Accept only the first 3 bytes each time.
      const accepted = Math.min(3, buffer.length - offset);
      written.push(accepted);
      chunks.push(Buffer.from(buffer.subarray(offset, offset + accepted)));
      return accepted;
    });
    expect(Buffer.concat(chunks).toString()).toBe('{"summary":"héllo wörld"}\n');
    expect(written.length).toBeGreaterThan(2);
  });

  it("retries when the pipe is full", async () => {
    const fakeSleep = vi.fn();
    const write = failingOnce("EAGAIN", (_fd, buffer) => buffer.length);
    writeToStdout("x", write, { sleep: fakeSleep });
    expect(fakeSleep).toHaveBeenCalled();
  });

  it("rethrows other errors", () => {
    expect(() => writeToStdout("x", failingOnce("EBADF", (_fd, buffer) => buffer.length))).toThrow(/EBADF/);
  });

  it("bypasses process.stdout.write", () => {
    const original = process.stdout.write;
    let intercepted = false;
    process.stdout.write = (() => {
      intercepted = true;
      return true;
    }) as typeof process.stdout.write;
    try {
      writeToStdout('{"bypassed":true}\n');
    } finally {
      process.stdout.write = original;
    }
    expect(intercepted).toBe(false);
  });
});
