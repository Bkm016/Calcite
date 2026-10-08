/** Anything kept in a {@link Feed}: entries are numbered by a sequence shared across feeds of one client. */
export interface Sequenced {
  seq: number;
}

/** A bounded, append-only history of entries ordered by {@code seq}; the oldest entries drop off first. */
export class Feed<T extends Sequenced> {
  private items: T[] = [];

  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.items.push(item);
    // trim in batches so a full feed does not shift the array on every push
    if (this.items.length > this.capacity * 1.25) this.items = this.items.slice(-this.capacity);
  }

  /** Entries newer than {@code since} that pass {@code filter}; with {@code limit} only the newest ones. */
  since(since = 0, filter?: (item: T) => boolean, limit?: number): T[] {
    const start = this.firstAfter(since);
    const list: T[] = [];
    for (let i = start; i < this.items.length; i++) {
      const item = this.items[i];
      if (!filter || filter(item)) list.push(item);
    }
    return limit && limit > 0 ? list.slice(-limit) : list;
  }

  /** The first entry newer than {@code since} that passes {@code filter}. */
  find(since: number, filter: (item: T) => boolean): T | undefined {
    for (let i = this.firstAfter(since); i < this.items.length; i++) {
      if (filter(this.items[i])) return this.items[i];
    }
    return undefined;
  }

  last(): T | undefined {
    return this.items.at(-1);
  }

  /** Index of the first entry with a seq greater than {@code seq} (binary search; seqs only grow). */
  private firstAfter(seq: number): number {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.items[mid].seq <= seq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
