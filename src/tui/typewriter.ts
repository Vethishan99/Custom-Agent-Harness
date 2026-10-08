// Reveals streamed text a few characters at a time, so replies type out
// smoothly however the provider chunks them. Actions queued with then() run
// once the text before them has been shown, keeping tool events in order.

type Item = string | (() => void);

const TICK_MS = 16;
// The backlog drains in roughly this many ticks, so a big chunk speeds the
// typing up rather than leaving the display far behind the model.
const CATCH_UP_TICKS = 45;

export class Typewriter {
  private queue: Item[] = [];
  private timer: NodeJS.Timeout | undefined;
  private waiters: Array<() => void> = [];

  constructor(private readonly reveal: (text: string) => void) {}

  write(text: string): void {
    if (!text) return;
    this.queue.push(text);
    this.start();
  }

  then(action: () => void): void {
    this.queue.push(action);
    this.start();
  }

  // Resolves once everything queued so far has been shown.
  idle(): Promise<void> {
    if (this.queue.length === 0) return Promise.resolve();
    return new Promise(resolve => this.waiters.push(resolve));
  }

  private start(): void {
    if (this.timer) return;
    // Keep this timer referenced: while the agent works, nothing else may
    // hold the process open, and it would exit mid-reply.
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  tick(): void {
    let backlog = 0;
    for (const item of this.queue) {
      if (typeof item === 'string') backlog += item.length;
    }
    let budget = Math.max(1, Math.ceil(backlog / CATCH_UP_TICKS));

    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (typeof head === 'function') {
        this.queue.shift();
        head();
        continue;
      }
      if (budget <= 0) break;

      let end = Math.min(budget, head.length);
      // Don't split an emoji or other surrogate pair.
      const code = head.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff && end < head.length) end += 1;

      this.reveal(head.slice(0, end));
      budget -= end;
      if (end === head.length) this.queue.shift();
      else this.queue[0] = head.slice(end);
    }

    if (this.queue.length === 0) {
      clearInterval(this.timer);
      this.timer = undefined;
      const waiters = this.waiters;
      this.waiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}
