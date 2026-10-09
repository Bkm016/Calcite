import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Feed } from '../dist/feed.js';

test('Feed keeps the newest entries and reads them by sequence', () => {
  const feed = new Feed(4);
  for (let seq = 1; seq <= 10; seq++) feed.push({ seq, even: seq % 2 === 0 });
  const seqs = (list) => list.map((e) => e.seq);
  assert.ok(seqs(feed.since()).at(0) >= 5 && seqs(feed.since()).at(-1) === 10, 'old entries drop off');
  assert.deepEqual(seqs(feed.since(8)), [9, 10]);
  assert.deepEqual(seqs(feed.since(0, (e) => e.even, 2)), [8, 10]);
  assert.equal(feed.find(7, (e) => e.even)?.seq, 8);
  assert.equal(
    feed.find(10, () => true),
    undefined,
  );
  assert.deepEqual(new Feed(3).since(), []);
});
