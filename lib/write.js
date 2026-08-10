// Writing to a project's queue — creating a task, and recording an approval.
//
// Shared by the dashboard and the MCP server, for the same reason as lib/read.js:
// where the `Approved:` line lands in a file, and what a task file is named, are
// decisions the two surfaces must make identically. A task created from an editor
// and one created from the dashboard have to be the same kind of object.
//
// Node-side only.

import fs from 'node:fs';
import path from 'node:path';

// Number-prefixed names sort in run order, but the dashboard has always stamped its
// own with a timestamp so two people creating tasks at once cannot collide. Keep
// that: a queue where two files claim `012-` is a queue that runs in the wrong order.
export function createTask(projectPath, title, content) {
  const dir = path.join(projectPath, 'tasks', 'todo');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = String(title || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
  const file = path.join(dir, stamp + '-' + slug + '.md');
  fs.writeFileSync(file, content);
  return path.basename(file);
}

export const COLUMNS = ['todo', 'inprogress', 'verify', 'done'];

// Approval is a line in the task file itself, not a record in a database beside it:
// it travels with the task as it moves through the queue folders, and whoever picks
// the task up can read it — including Claude, which is told never to edit it.
//
// Returns the approval string, or null when it was withdrawn. Throws when the file
// is missing, so callers can tell "not found" from "already unapproved".
export function setApproval(projectPath, col, file, { by = '', undo = false } = {}) {
  if (!COLUMNS.includes(col)) throw new Error(`bad column: ${col}`);
  const name = path.basename(file);
  if (!name.endsWith('.md')) throw new Error(`not a task file: ${file}`);
  const full = path.join(projectPath, 'tasks', col, name);
  const text = fs.readFileSync(full, 'utf8');          // throws if missing — deliberate
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^\s*approved\s*:/i.test(l));

  if (undo) {
    if (at === -1) return null;
    lines.splice(at, 1);
    fs.writeFileSync(full, lines.join('\n'));
    return null;
  }

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const line = 'Approved: ' + stamp + (by ? ' by ' + by : '');
  if (at !== -1) lines[at] = line;
  else {
    // Into the header block, under Type:/Touches: when there is one, otherwise under
    // the title — so the file still reads top-down.
    let ins = lines.findIndex((l) => l.trim().startsWith('#'));
    ins = ins === -1 ? 0 : ins + 1;
    while (ins < lines.length && !lines[ins].trim()) ins++;                    // past the blank line
    while (ins < lines.length && /^\s*[A-Za-z][A-Za-z ]*:/.test(lines[ins])) ins++;
    lines.splice(ins, 0, line);
  }
  fs.writeFileSync(full, lines.join('\n'));
  return line.slice('Approved: '.length);
}
