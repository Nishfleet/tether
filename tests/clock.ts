import type { SetTimer } from "@earendil-works/pi-durable";

export class FakeClock {
  private time: number;
  private timers: { at: number; callback: () => void }[] = [];

  constructor(start: number) {
    this.time = start;
  }

  now = (): number => this.time;

  setTimer: SetTimer = (callback, delayMs) => {
    const timer = { at: this.time + delayMs, callback };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((entry) => entry !== timer);
    };
  };

  async advance(ms: number): Promise<void> {
    this.time += ms;
    const due = this.timers.filter((timer) => timer.at <= this.time).sort((a, b) => a.at - b.at);
    this.timers = this.timers.filter((timer) => timer.at > this.time);
    for (const timer of due) timer.callback();
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  async restart(ms: number): Promise<void> {
    this.timers = [];
    this.time += ms;
  }
}
