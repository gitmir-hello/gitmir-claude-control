// What the agent is doing right now, in its own words.
//
// The dashboard used to watch the folder and infer. Watching a folder tells you
// nothing while an agent reads forty files, and nothing at all when it stops to
// ask the person a question — which is the case that actually strands people:
// the screen says "waiting" for twenty minutes while the chat two windows away
// has a question in it nobody looked at.
//
// So the agent says what it is doing. One small file in the project, overwritten
// each time. It is a courtesy, not a contract: everything here still works if
// nothing ever writes it, because the map appearing is what really ends the wait.

import fs from 'node:fs';
import path from 'node:path';

const FILE = ['.gitmir', 'progress.json'];
/** Nothing heard for this long means the agent died, or the person walked away. */
const STALE_MS = 15 * 60 * 1000;

export const STAGES = ['started', 'reading', 'writing', 'blocked', 'done', 'failed'];

const fileOf = (p) => path.join(p, ...FILE);

/**
 * Record a stage. Never throws: an agent must not fail a job because it could not
 * update a status line.
 */
export function report(projectPath, stage, note) {
  if (!projectPath || !STAGES.includes(stage)) return false;
  const rec = {
    stage,
    note: String(note || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    at: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(fileOf(projectPath)), { recursive: true });
    fs.writeFileSync(fileOf(projectPath), JSON.stringify(rec) + '\n');
    return true;
  } catch { return false; }
}

/**
 * The last thing the agent said, with an honest age on it.
 *
 * A stage that has not moved in a quarter of an hour is reported as stale rather
 * than as progress. "Writing the map" left on screen from a session that crashed
 * an hour ago is worse than saying nothing.
 */
export function read(projectPath) {
  let raw = '';
  try { raw = fs.readFileSync(fileOf(projectPath), 'utf8'); } catch { return null; }
  let rec;
  try { rec = JSON.parse(raw); } catch { return null; }
  if (!rec || !STAGES.includes(rec.stage)) return null;
  const ts = Date.parse(rec.at || '');
  const ageMs = ts ? Date.now() - ts : 0;
  return {
    stage: rec.stage,
    note: String(rec.note || '').slice(0, 300),
    at: rec.at || null,
    ageMs,
    // `blocked` never goes stale: a question waits as long as it takes.
    stale: rec.stage !== 'blocked' && rec.stage !== 'done' && ageMs > STALE_MS,
  };
}

/** Forget what was said — used when the map lands and the wait is over. */
export function clear(projectPath) {
  try { fs.unlinkSync(fileOf(projectPath)); } catch {}
}
