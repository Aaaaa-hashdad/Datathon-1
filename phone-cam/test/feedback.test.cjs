const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeResult, parseAnswer } = require('../feedback');

function analyze(exercises) {
  return parseAnswer(`Feedback\nJSON: ${JSON.stringify({ exercises })}`).result;
}

function curl(range, control, stability, tempo, consistency) {
  return { exercise: 'bicep curl', reps: 2, form_points: { range, control, stability, tempo, consistency }, form_score: 7 };
}

test('scores use the full 3–10 scale and reflect partial credit across five criteria', () => {
  const result = analyze([
    curl(0, 0, 0, 0, 0), curl(4, 4, 3, 4, 4), curl(4, 4, 4, 2, 4),
    curl(3, 4, 4, 4, 4), curl(4, 4, 4, 4, 4),
  ]);
  assert.equal(result.rubric, 'form-v5');
  assert.deepEqual(result.exercises.map((item) => item.form_score), [3, 9.7, 9.5, 9.4, 10]);
  assert.equal(result.exercises[1].form_points.stability, 3);
});

test('good tempo and consistency cannot mask repeatedly missed fundamentals', () => {
  const { exercises } = analyze([curl(4, 0, 0, 4, 4), curl(4, 0, 4, 4, 4), curl(1, 1, 4, 4, 4), curl(4, 4, 4, 0, 0)]);
  assert.deepEqual(exercises.map((item) => item.form_score), [3, 6, 6.5, 8.3]);
  assert.deepEqual(exercises.map((item) => item.form_limit), ['fundamentals', 'fundamentals', 'fundamentals', null]);
});

test('excellent range alone cannot carry a high form score', () => {
  const { exercises: [item] } = analyze([{ ...curl(8, 6, 4, 5, 5), reps: 4 }]);
  assert.equal(item.form_score, 6.5);
  assert.equal(item.form_limit, 'balance');
});

test('unobservable criteria leave an exercise unscored, and invalid replies fail', () => {
  const unscored = { ...curl(0, 0, 0, 0, 0), form_points: null };
  assert.equal(analyze([unscored]).exercises[0].form_score, null);
  assert.throws(() => analyze([curl(5, 4, 4, 4, 4)]), /incomplete/);
  assert.throws(() => analyze([curl(4, 4, 4, 4)]), /incomplete/);
  assert.throws(() => analyze([{ ...unscored, form_points: undefined }]), /incomplete/);
  assert.throws(() => analyze([{ ...curl(1, 1, 1, 1, 1), reps: 1 }]), /incomplete/);
  assert.throws(() => parseAnswer('Feedback only'), /incomplete/);
});

test('stored v2 scores keep their rubric and value when read again', () => {
  const earlier = normalizeResult({ rubric: 'form-v2', exercises: [{ exercise: 'bicep curl', reps: 2, form_score: 8.3 }] });
  assert.equal(earlier.rubric, 'form-v2');
  assert.equal(earlier.exercises[0].form_score, 8.3);
});
