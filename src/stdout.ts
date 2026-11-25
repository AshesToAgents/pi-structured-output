import { writeSync } from "node:fs";

/** The subset of `fs.writeSync(fd, buffer, offset)` the writer needs; injectable for tests. */
export type FdWrite = (fd: number, buffer: Buffer, offset: number) => number;

export interface WriteToStdoutOptions {
  /** Synchronous pause used while a non-blocking pipe is full. */
  sleep?: (ms: number) => void;
}

const BUSY_CODES = new Set(["EAGAIN", "EWOULDBLOCK", "ENOBUFS"]);
const BUSY_RETRY_DELAY_MS = 10;

/** Blocks the current thread for `ms` without a dependency on Node timers. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write `text` to the process's real stdout (fd 1).
 *
 * Pi redirects `process.stdout.write` to stderr in every non-interactive mode and reserves stdout
 * for its own writer, so an extension that needs stdout must go through the file descriptor.
 * Loops on partial writes and retries while a non-blocking pipe is full.
 */
export function writeToStdout(text: string, write: FdWrite = writeSync, options: WriteToStdoutOptions = {}): void {
  const sleep = options.sleep ?? sleepSync;
  const buffer = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += write(1, buffer, offset);
    } catch (error) {
      if (!BUSY_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      sleep(BUSY_RETRY_DELAY_MS);
    }
  }
}
