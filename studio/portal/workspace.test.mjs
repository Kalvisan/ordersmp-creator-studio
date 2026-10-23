import test from 'node:test';
import assert from 'node:assert/strict';
import { recordingTitle, clipRanges, timeLabel } from './ui.mjs';

test('video names become editable titles while respecting the existing API limit', () => {
  assert.equal(
    recordingTitle('First_recording-2026.MP4'),
    'First recording 2026'
  );
  assert.equal(recordingTitle('.mov'), 'Untitled recording');
  assert.equal(recordingTitle('a'.repeat(300) + '.mkv').length, 180);
});
test('visual trim preserves exact selected seconds and supports explicit multiple ranges', () => {
  assert.deepEqual(clipRanges('', '2.5', '8.2', 12), [
    { start: 2.5, end: 8.2 },
  ]);
  assert.deepEqual(clipRanges('0,3\n30,90', '', '', 90), [
    { start: 0, end: 3 },
    { start: 30, end: 90 },
  ]);
});
for (const [label, text, start, end, duration] of [
  ['empty start', '', '', 30, 60],
  ['empty end', '', 0, '', 60],
  ['reversed range', '', 12, 5, 60],
  ['shorter than three seconds', '', 0, 2.9, 60],
  ['longer than sixty seconds', '', 0, 60.1, 100],
  ['outside measured duration', '', 0, 31, 30],
  ['nonfinite seconds', '', 0, Infinity, 60],
  ['negative start', '', -1, 3, 30],
  ['missing CSV value', '2,', 0, 30, 60],
  ['extra CSV value', '1,4,9', 0, 30, 60],
  ['more than ten clips', Array(11).fill('1,4').join('\n'), 0, 30, 60],
])
  test(`invalid trim cannot reach preparation: ${label}`, () =>
    assert.throws(() => clipRanges(text, start, end, duration)));
test('unknown duration can use explicit seconds without inventing a measured length', () => {
  assert.deepEqual(clipRanges('', 0, 5, NaN), [{ start: 0, end: 5 }]);
  assert.equal(timeLabel(NaN), '--:--');
  assert.equal(timeLabel(125.5), '2:05');
});
