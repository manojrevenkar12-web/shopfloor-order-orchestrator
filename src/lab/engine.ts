/** A small discrete-event engine: a binary heap of (time, sequence) ordered callbacks. */
export class Engine {
  private heap: Array<{ at: number; seq: number; fn: () => void }> = [];
  private seq = 0;
  now = 0;
  processed = 0;

  at(time: number, fn: () => void): void {
    const item = { at: Math.max(time, this.now), seq: this.seq++, fn };
    const h = this.heap;
    h.push(item);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(h[p]!, item)) break;
      h[i] = h[p]!;
      i = p;
    }
    h[i] = item;
  }

  after(delay: number, fn: () => void): void {
    this.at(this.now + delay, fn);
  }

  every(period: number, start: number, fn: (now: number) => void, until: number): void {
    const loop = (t: number) => {
      if (t > until) return;
      this.at(t, () => {
        fn(t);
        loop(t + period);
      });
    };
    loop(start);
  }

  run(until: number): void {
    const h = this.heap;
    while (h.length > 0 && h[0]!.at <= until) {
      const top = h[0]!;
      const last = h.pop()!;
      if (h.length > 0) {
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          const cur = m === i ? last : h[m]!;
          let best = cur;
          if (l < h.length && this.less(h[l]!, best)) {
            m = l;
            best = h[l]!;
          }
          if (r < h.length && this.less(h[r]!, best)) {
            m = r;
            best = h[r]!;
          }
          if (m === i) break;
          h[i] = h[m]!;
          i = m;
        }
        h[i] = last;
      }
      this.now = top.at;
      this.processed++;
      top.fn();
    }
    this.now = until;
  }

  private less(a: { at: number; seq: number }, b: { at: number; seq: number }): boolean {
    return a.at < b.at || (a.at === b.at && a.seq < b.seq);
  }
}

/** Seeded PRNG (mulberry32) so a seed fixes the whole year. */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }

  exp(mean: number): number {
    return -Math.log(1 - this.next()) * mean;
  }

  lognormal(median: number, sigma: number): number {
    const u = 1 - this.next();
    const v = this.next();
    return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  fork(salt: number): Rng {
    return new Rng((Math.floor(this.next() * 2 ** 31) ^ salt) >>> 0);
  }
}
