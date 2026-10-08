import { sleep } from '../client-core.js';
import type { Client, TaskStatus } from '../client.js';

interface Job {
  name: string;
  startedAt: number;
  finishedAt?: number;
  done: Promise<void>;
  result?: unknown;
  error?: { code?: string; message: string };
}

/**
 * Long actions (walk_to, dig, craft) started with {@code background: true}. The probe runs one action per
 * client at a time, so only the latest job of each client is kept; its outcome stays readable after it ends.
 */
export class BackgroundTasks {
  private readonly jobs = new Map<string, Job>();

  /** Runs {@code action} and returns its result or, in the background, returns at once. */
  async run(client: Client, name: string, background: boolean, action: () => Promise<unknown>): Promise<unknown> {
    return background ? this.start(client, name, action) : action();
  }

  private start(client: Client, name: string, run: () => Promise<unknown>): { started: string; next: string } {
    const job: Job = { name, startedAt: Date.now(), done: Promise.resolve() };
    job.done = run().then(
      (result) => {
        job.result = result;
      },
      (err: Error & { code?: string }) => {
        job.error = { code: err.code, message: err.message };
      },
    ).finally(() => {
      job.finishedAt = Date.now();
    });
    this.jobs.set(client.options.name, job);
    return { started: name, next: 'Call get_task to follow it (waitSeconds waits for it to end); stop_actions cancels it' };
  }

  /** The running action's progress plus the outcome of the latest background job, waiting up to {@code waitMs} for it. */
  async status(client: Client, waitMs: number): Promise<TaskStatus & { background?: Record<string, unknown> }> {
    const job = this.jobs.get(client.options.name);
    if (job && job.finishedAt === undefined && waitMs > 0) await Promise.race([job.done, sleep(waitMs)]);
    let running: TaskStatus = { running: false };
    try {
      running = await client.task();
    } catch {
      // not in a world: nothing runs
    }
    if (!job) return running;
    const state = job.finishedAt === undefined ? 'running' : job.error ? 'failed' : 'done';
    const seconds = Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 100) / 10;
    return { ...running, background: { name: job.name, state, seconds, result: job.result, error: job.error } };
  }
}
