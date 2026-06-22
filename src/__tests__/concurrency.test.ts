import { describe, it, expect } from 'vitest';
import { createSemaphore, SaturatedError } from '../concurrency.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createSemaphore', () => {
  it('runs up to max tasks concurrently and queues the rest', async () => {
    const sem = createSemaphore(2, 10);
    const gates = [deferred(), deferred(), deferred()];
    let active = 0;
    let maxActive = 0;

    const runs = gates.map((g) =>
      sem.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await g.promise;
        active--;
      }),
    );

    // Let microtasks settle: 2 should be active, 3rd queued.
    await Promise.resolve();
    expect(maxActive).toBe(2);

    gates.forEach((g) => g.resolve());
    await Promise.all(runs);
    expect(maxActive).toBe(2);
  });

  it('rejects with SaturatedError when the queue is full', async () => {
    const sem = createSemaphore(1, 1);
    const gate = deferred();

    const running = sem.run(() => gate.promise); // takes the only slot
    const queued = sem.run(async () => {}); // fills the queue (size 1)

    // Third call: no slot, queue full → SaturatedError.
    await expect(sem.run(async () => {})).rejects.toBeInstanceOf(SaturatedError);

    gate.resolve();
    await running;
    await queued;
  });

  it('releases the permit even when the task throws', async () => {
    const sem = createSemaphore(1, 5);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // If the permit leaked, this would hang/never resolve.
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });
});
