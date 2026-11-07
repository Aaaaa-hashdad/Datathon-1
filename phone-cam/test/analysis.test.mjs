
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  SquatAnalyzer, analyzeFrames, summarize, trends, toCSV
} from '../public/analysis.mjs';

// Synthetic fixtures for tests only; not collected participant data.
const frame = (t, knee, side = 'L') => ({
  t, pose: {angles: {
    [`${side} knee`]: knee, [`${side} hip`]: 85
  }}
});
const cycle = (depth = 90) =>
  [170, 150, 140, 110, depth, 110, 140, 165]
    .map((k, i) => frame(i * 300, k));

test('complete cycle returns a measured, scored rep', () => {
  const reps = analyzeFrames(cycle());
  assert.equal(reps.length, 1);
  assert.equal(reps[0].knee_angle_min, 90);
  assert.equal(reps[0].form_score, 100);
  assert.equal(reps[0].rep_time_sec, 1.8);
});

test('shallow and fast motion receives feedback flags', () => {
  const reps = analyzeFrames(cycle(125).map(f => ({...f, t: f.t / 2})));
  assert.equal(reps.length, 1);
  assert.ok(reps[0].mistakes.includes('too_fast'));
  assert.ok(reps[0].mistakes.includes('not_deep'));
  assert.ok(reps[0].form_score < 100);
});

test('standing jitter and incomplete reps are excluded', () => {
  assert.deepEqual(analyzeFrames(
    [170, 161, 159, 165].map((k, i) => frame(i * 300, k))
  ), []);
  assert.deepEqual(analyzeFrames(cycle().slice(0, -1)), []);
});

test('lost tracking, long gaps and leg switches invalidate partial reps', () => {
  for (const middle of [
    {t: 1000, pose: null},
    frame(3000, 90),
    frame(1000, 90, 'R')
  ]) {
    assert.equal(analyzeFrames([
      ...cycle().slice(0, 3), middle, frame(middle.t + 300, 165)
    ]).length, 0);
  }
});

test('out-of-order frames cannot complete a rep', () => {
  const a = new SquatAnalyzer();
  cycle().slice(0, -1).forEach(f => a.update(f));
  a.update(frame(1, 170));
  assert.equal(a.reps.length, 0);
  a.update(cycle().at(-1));
  assert.equal(a.reps.length, 1);
});

test('invalid angles are not treated as zero', () => {
  for (const knee of [null, NaN, Infinity, '90', -1, 181]) {
    assert.equal(analyzeFrames([frame(0, knee)]).length, 0);
  }
  assert.equal(summarize([]).mean_score, null);
});

test('comparison excludes self and requires five other sessions', () => {
  const reps = analyzeFrames(cycle());
  const peers = Array.from({length: 5}, (_, i) => ({
    session_id: String(i), reps
  }));
  assert.equal(trends(peers, peers[0]).percentile, null);
  assert.equal(trends(peers, {session_id: 'new', reps}).percentile, 50);
});

test('CSV escapes metadata and includes rule version', () => {
  const csv = toCSV([{
    session_id: 's1',
    metadata: {location: 'MSC, "hall"'},
    reps: analyzeFrames(cycle())
  }]);
  assert.ok(csv.includes('"MSC, ""hall"""'));
  assert.ok(csv.includes('squat-v1'));
});
