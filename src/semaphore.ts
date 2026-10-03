/** FIFO counting semaphore with abortable waits. */
export class Semaphore {
  private waiters: Array<{ resolve: () => void; reject: (e: Error) => void; signal?: AbortSignal; onAbort?: () => void }> = [];
  private inUse = 0;

  constructor(private readonly size: number) {}

  get active(): number { return this.inUse; }
  get queued(): number { return this.waiters.length; }

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    if (this.inUse < this.size) { this.inUse++; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const w: (typeof this.waiters)[number] = { resolve, reject, signal };
      if (signal) {
        w.onAbort = () => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error('aborted'));
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.waiters.push(w);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
      next.resolve(); // slot passes straight to the waiter
    } else {
      this.inUse = Math.max(0, this.inUse - 1);
    }
  }
}
