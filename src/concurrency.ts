/** Thrown when the wait queue is full and no slot can be granted. */
export class SaturatedError extends Error {
  constructor() {
    super('server saturated: too many pending requests');
    this.name = 'SaturatedError';
  }
}

export interface Semaphore {
  /** Run `fn` once a slot is free. Rejects with SaturatedError if the queue is full. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Bounded async semaphore. At most `max` tasks run concurrently; up to
 * `maxQueue` more may wait. Beyond that, `run` rejects with SaturatedError
 * instead of queueing unboundedly (which would let agent subprocesses pile up).
 */
export function createSemaphore(max: number, maxQueue: number): Semaphore {
  let permits = max;
  const waiters: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (permits > 0) {
      permits--;
      return;
    }
    if (waiters.length >= maxQueue) {
      throw new SaturatedError();
    }
    // Wait for a release. The releaser hands the permit directly to us — it
    // does not bump `permits`, so there is no window for a new caller to steal it.
    await new Promise<void>((resolve) => waiters.push(resolve));
  }

  function release(): void {
    const next = waiters.shift();
    if (next) {
      next();
    } else {
      permits++;
    }
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
