'use strict';
// Notices when a streamed reply starts repeating itself (a thinking loop), so the bridge can stop
// it instead of letting it run to the reply limit. Used instead of a presence penalty, which slows
// generation (fewer MTP drafts accepted) and garbles names that should repeat.
//
// The check: the text must end in the same passage repeated back to back, REPEATS times or more,
// covering at least MIN_SPAN characters. Spacing is made uniform first; nothing else is, so a list
// of numbers or code that only differs in values is not a loop. Repetitive code (the same block
// with different lines between) is not flagged, because the copies aren't back to back.
// How: take the last PROBE characters; the gap to their previous occurrence is the loop's length;
// then check the end of the text has that period throughout.

const PROBE = 160;
const WINDOW = 16000; // longest loop caught: WINDOW / REPEATS characters per turn
const REPEATS = 3;
const MIN_SPAN = 600;
const CHECK_EVERY = 400; // characters between checks
const MIN_DISTINCT = 10; // a probe of a few characters (rows of dashes) is never a loop

const norm = (s) => s.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n');

// Returns { repeats, unit } when text ends in a loop, else null.
function findLoop(text) {
  const w = norm(text.slice(-WINDOW - 400));
  if (w.length < MIN_SPAN) return null;
  const probe = w.slice(-PROBE);
  if (new Set(probe).size < MIN_DISTINCT) return null;
  const prev = w.lastIndexOf(probe, w.length - PROBE - 1);
  if (prev < 0) return null;
  const unit = w.length - PROBE - prev;
  const span = Math.max(unit * REPEATS, MIN_SPAN);
  if (span > w.length) return null;
  const start = w.length - span;
  for (let i = start; i + unit < w.length; i++) if (w[i] !== w[i + unit]) return null;
  // How many whole turns it has gone round.
  let k = w.length - unit;
  while (k - unit >= 0 && w.slice(k - unit, k) === w.slice(k, k + unit)) k -= unit;
  return { repeats: Math.round((w.length - k) / unit), unit };
}

// One per streamed reply. add(key, piece) gives text for one channel (thinking, a content block);
// it returns the loop found, or null. chars is how much text has come in overall.
function loopWatcher() {
  const seen = new Map();
  let chars = 0;
  return {
    get chars() { return chars; },
    add(key, piece) {
      if (!piece) return null;
      chars += piece.length;
      const s = seen.get(key) || { text: '', checked: 0 };
      s.text += piece;
      if (s.text.length > WINDOW * 2) {
        const drop = s.text.length - WINDOW - 400;
        s.text = s.text.slice(drop);
        s.checked = Math.max(0, s.checked - drop);
      }
      seen.set(key, s);
      if (s.text.length - s.checked < CHECK_EVERY) return null;
      s.checked = s.text.length;
      return findLoop(s.text);
    },
  };
}

const LOOP_NOTE = 'The model started repeating itself, so the bridge stopped this reply. Say "continue" to pick up from here.';

module.exports = { loopWatcher, findLoop, LOOP_NOTE };
