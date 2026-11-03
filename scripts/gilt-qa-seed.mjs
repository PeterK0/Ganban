#!/usr/bin/env node
/**
 * Gilt QA seed: a throwaway database with enough data to look at every screen.
 *
 * Usage:
 *   node scripts/gilt-qa-seed.mjs            # writes /tmp/gilt-qa/seed.db
 *   GILT_SEED_PORT=8799 node scripts/gilt-qa-seed.mjs   # if 8799 is taken
 *   GILT_QA_DIR=/tmp/my-seed node scripts/gilt-qa-seed.mjs   # another folder (it must sit directly under /tmp)
 *   GANBAN_SERVER=/path/to/ganban-server node scripts/gilt-qa-seed.mjs   # another binary
 *
 * It runs this checkout's target/debug/ganban-server (cargo build -p ganban-server). Most of the time you don't call
 * it yourself: scripts/qa-host.sh <port> seeds on first use and serves a fresh copy (docs/dev/TESTING.md § QA host).
 *
 * It starts a host on a FRESH database in /tmp/gilt-qa or GILT_QA_DIR (deleting the old
 * seed first), creates the data through the host's /invoke API (the same
 * commands the UI calls, src/lib/api.ts), stops the host and leaves the file.
 * Loopback callers are the owner, so no sign-in is needed.
 *
 * It refuses any folder that isn't directly under /tmp and never touches a real gansty.db.
 *
 * The data: 5 projects (3 pinned) with areas, ~40 tasks across every status
 * and priority (deadlines this week, some assigned to the owner), comments
 * and updates, 6 events this month and next, 2 contacts. Dates are relative
 * to the day you run it, so "this week" stays true; re-seed for a fresh week.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.platform === 'win32' ? '.exe' : '';
const SERVER = process.env.GANBAN_SERVER || path.join(REPO, 'target', 'debug', `ganban-server${EXE}`);
const DIR = process.env.GILT_QA_DIR || '/tmp/gilt-qa';
const DB = path.join(DIR, 'seed.db');
const STORAGE = path.join(DIR, 'seed-files');
const PORT = Number(process.env.GILT_SEED_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;

// Belt and braces: this script only ever writes in its own folder directly under /tmp.
if (!/^\/tmp\/[\w.-]+$/.test(DIR) || !DB.startsWith(DIR + '/') || /gansty\.db$/.test(DB)) throw new Error(`refusing to seed ${DB}`);
if (!existsSync(SERVER)) throw new Error(`no host binary at ${SERVER} (run cargo build -p ganban-server, or set GANBAN_SERVER)`);

// Never seed a host we didn't start: if anything already answers on the port
// (another lane's host, or a real one), stop before writing a single row.
try {
  await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) });
  throw new Error(`something already listens on ${BASE}; set GILT_SEED_PORT to a free port`);
} catch (e) {
  if (e instanceof Error && e.message.startsWith('something already listens')) {
    console.error(e.message);
    process.exit(1);
  }
  /* connection refused: the port is free */
}

mkdirSync(DIR, { recursive: true });
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
rmSync(STORAGE, { recursive: true, force: true });

const host = spawn(SERVER, [], {
  env: { ...process.env, GANBAN_DB: DB, GANBAN_STORAGE: STORAGE, GANBAN_ADDR: `127.0.0.1:${PORT}` },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let hostLog = '';
host.stderr.on('data', (d) => (hostLog = (hostLog + d).slice(-4000)));
host.on('exit', (code) => {
  if (code && code !== 0 && !stopping) {
    console.error(`host exited with ${code}\n${hostLog}`);
    process.exit(1);
  }
});
let stopping = false;

async function waitForHost() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`host did not come up on ${BASE}\n${hostLog}`);
}

async function call(command, args = {}) {
  const r = await fetch(`${BASE}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, args }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${command}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// ---- dates, relative to today ----
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (n) => {
  const d = new Date();
  d.setHours(17, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
};
/** A deadline the way the task editor writes it: an ISO timestamp. */
const due = (n) => addDays(n).toISOString();
/** A day this month (clamped to the month's end) or next month. */
function monthDay(monthOffset, day) {
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 0).getDate();
  return ymd(new Date(now.getFullYear(), now.getMonth() + monthOffset, Math.min(day, last)));
}

const PROJECTS = [
  {
    name: 'Harbour Gallery',
    description: 'The new gallery wing: fit-out, opening night and the catalogue.',
    pinned: true,
    areas: ['Fit-out', 'Opening', 'Catalogue'],
  },
  {
    name: 'Ganban Desktop',
    description: 'The desktop app: the Gilt redesign, sync and the release train.',
    pinned: true,
    areas: ['Design', 'Sync', 'Release'],
  },
  {
    name: 'Kitchen Renovation',
    description: 'Cabinets, worktops and the electrician, in that order.',
    pinned: true,
    areas: ['Trades', 'Materials'],
  },
  {
    name: 'Autumn Reading',
    description: 'Books for the long evenings, with notes.',
    pinned: false,
    areas: ['Fiction', 'History'],
  },
  {
    name: 'Studio Accounts',
    description: 'Quarterly VAT, invoices and the year-end with the accountant.',
    pinned: false,
    areas: ['Invoices', 'Tax'],
  },
];

// [project index, area index or null, title, status, priority, deadline offset in days or null, assign to owner]
const TASKS = [
  [0, 0, 'Order the gallery lighting track', 'In Progress', 'High', 1, true],
  [0, 0, 'Sign off the wall colours', 'Done', 'Medium', null, false],
  [0, 0, 'Book the floor sanding', 'To Do', 'Medium', 4, false],
  [0, 1, 'Send the opening-night invitations', 'To Do', 'High', 2, true],
  [0, 1, 'Confirm the caterer', 'Blocked', 'High', 3, false],
  [0, 1, 'Draft the speech', 'To Do', 'Low', 6, true],
  [0, 2, 'Photograph the twelve pieces', 'In Progress', 'Medium', 5, false],
  [0, 2, 'Proof the catalogue essays', 'To Do', 'Medium', null, false],
  [0, 2, 'Choose the paper stock', 'Done', 'Low', null, false],
  [1, 0, 'Gilt: theme tokens and fonts', 'In Progress', 'High', 0, true],
  [1, 0, 'Gilt: restyle the top bar', 'To Do', 'High', 2, true],
  [1, 0, 'Gilt: the side pane resizes', 'Done', 'Medium', null, false],
  [1, 0, 'Pick an icon set for the sidebar', 'Blocked', 'Low', null, false],
  [1, 1, 'Sync: retry on a dropped connection', 'To Do', 'High', 3, false],
  [1, 1, 'Sync: show the last pull time', 'In Progress', 'Medium', null, true],
  [1, 1, 'Investigate the duplicate pulse', 'Blocked', 'Medium', 1, false],
  [1, 2, 'Write the 0.6 release notes', 'To Do', 'Medium', 5, true],
  [1, 2, 'Notarise the macOS build', 'To Do', 'High', 6, false],
  [1, 2, 'Tag 0.5.1', 'Done', 'Low', null, false],
  [1, null, 'A very long task title to check that rows truncate gracefully instead of pushing the layout sideways', 'To Do', 'Low', null, false],
  [2, 0, 'Get three quotes from electricians', 'Done', 'High', null, false],
  [2, 0, 'Book the plumber for the sink move', 'In Progress', 'High', 2, true],
  [2, 0, 'Agree the tiling dates', 'To Do', 'Medium', 7, false],
  [2, 1, 'Choose the worktop (oak or quartz)', 'Blocked', 'Medium', null, true],
  [2, 1, 'Order the cabinet handles', 'To Do', 'Low', 4, false],
  [2, 1, 'Return the wrong hinges', 'Done', 'Low', null, false],
  [2, null, 'Measure the alcove for the fridge', 'To Do', 'Medium', 0, true],
  [3, 0, 'Finish "The Remains of the Day"', 'In Progress', 'Low', null, true],
  [3, 0, 'Start "Piranesi"', 'To Do', 'Low', null, false],
  [3, 1, 'Notes on "SPQR", chapters 4 to 6', 'To Do', 'Medium', 6, false],
  [3, 1, 'Return the library copy of "The Silk Roads"', 'To Do', 'High', 1, true],
  [3, 0, 'Read "Klara and the Sun"', 'Done', 'Low', null, false],
  [4, 0, 'Invoice Harbour Gallery for October', 'To Do', 'High', 2, true],
  [4, 0, 'Chase the September invoice', 'Blocked', 'High', -2, true],
  [4, 0, 'Send the November invoices', 'To Do', 'Medium', 8, false],
  [4, 1, 'Q3 VAT return', 'Done', 'High', null, false],
  [4, 1, 'Collect receipts for the year-end', 'In Progress', 'Medium', 5, false],
  [4, 1, 'Book the accountant', 'To Do', 'Low', 12, false],
  [4, null, 'Renew the studio insurance', 'To Do', 'Medium', 3, false],
  [4, null, 'Cancel the old bank card', 'Done', 'Low', null, false],
];

const EVENTS = [
  { title: 'Studio stand-up', event_date: monthDay(0, new Date().getDate()), start_time: '09:30', end_time: '09:45' },
  { title: 'Lighting supplier visit', event_date: ymd(addDays(2)), start_time: '11:00', end_time: '12:00', location: 'Harbour Gallery' },
  { title: 'Plumber', event_date: ymd(addDays(3)), start_time: '08:00', end_time: '10:00', location: 'Home' },
  { title: 'Accountant call', event_date: monthDay(0, 26), start_time: '15:00', end_time: '15:30' },
  { title: 'Gallery opening night', event_date: monthDay(1, 6), start_time: '18:30', end_time: '22:00', location: 'Harbour Gallery' },
  { title: 'Book club', event_date: monthDay(1, 14), all_day: true },
];

const CONTACTS = [
  {
    full_name: 'Maren Holt',
    occupation: 'Gallery curator',
    emails: 'maren@harbourgallery.example',
    phone_numbers: '+44 20 7946 0101',
    notes: 'Signs off the catalogue. Prefers calls before noon.',
  },
  {
    full_name: 'Tomasz Wierzbicki',
    occupation: 'Electrician',
    emails: 'tomasz@sparks.example',
    phone_numbers: '+44 7700 900123',
    notes: 'Quoted for the kitchen. Free from the 20th.',
  },
];

async function seed() {
  const users = await call('get_users');
  const owner = Array.isArray(users) && users.length ? users[0] : null;

  const projects = [];
  for (const p of PROJECTS) {
    const project = await call('create_project', { input: { name: p.name, description: p.description } });
    if (p.pinned) await call('update_project', { projectId: project.id, input: { pinned: true } });
    const areas = [];
    for (const name of p.areas) areas.push(await call('create_area', { input: { project_id: project.id, name } }));
    projects.push({ project, areas });
  }

  const tasks = [];
  for (const [pi, ai, title, status, priority, dueIn, mine] of TASKS) {
    const { project, areas } = projects[pi];
    const input = { project_id: project.id, title, status, priority };
    if (ai !== null) input.area_id = areas[ai].id;
    if (dueIn !== null) input.deadline = due(dueIn);
    if (status === 'Done' || status === 'In Progress') {
      input.description = `Notes for **${title}**.\n\n- the first step\n- the second step`;
    }
    const task = await call('create_task', { input });
    if (mine && owner) await call('assign_task', { taskId: task.id, userId: owner.id, assignedBy: owner.id, brief: null });
    tasks.push(task);
  }

  // Comments (with a reply) and updates (top-level comments tagged to several tasks).
  const byTitle = (t) => tasks.find((x) => x.title.startsWith(t));
  const comment = (task, content, extra = {}) =>
    call('create_comment', { input: { task_id: task.id, content, user_id: owner?.id, ...extra } });
  const c1 = await comment(byTitle('Order the gallery lighting'), 'The supplier can deliver on Thursday if we confirm today.');
  await comment(byTitle('Order the gallery lighting'), 'Confirmed. Thursday it is.', { parent_id: c1.id });
  await comment(byTitle('Confirm the caterer'), 'Waiting on their allergen sheet before we sign.');
  await comment(byTitle('Gilt: theme tokens'), 'All eight themes have their gold now. Latte gets the darker ochre.');
  await comment(byTitle('Book the plumber'), 'He can do Tuesday morning; the sink has to be empty by then.');
  await comment(
    byTitle('Gilt: theme tokens'),
    '**Update:** the foundations are in: tokens, fonts, corners and the resizable side pane.',
    { task_ids: [byTitle('Gilt: the side pane').id] },
  );
  await comment(
    byTitle('Photograph the twelve pieces'),
    '**Update:** eight of the twelve are shot; the large canvases need the studio on Friday.',
    { task_ids: [byTitle('Proof the catalogue').id] },
  );

  for (const e of EVENTS) {
    // The calendar sends event_date as local midnight, ISO (CalendarView).
    const [y, m, d] = e.event_date.split('-').map(Number);
    const event_date = new Date(y, m - 1, d).toISOString();
    await call('create_event', {
      input: { all_day: false, notification_enabled: false, ...e, event_date },
    });
  }
  for (const c of CONTACTS) await call('create_contact', { input: c });

  return { projects: projects.length, tasks: tasks.length, owner: owner?.name ?? owner?.username ?? null };
}

try {
  await waitForHost();
  const summary = await seed();
  console.log(`seeded ${DB}: ${summary.projects} projects, ${summary.tasks} tasks, owner ${summary.owner ?? '(none)'}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  stopping = true;
  if (host.exitCode === null && host.signalCode === null) {
    const exited = new Promise((r) => host.once('exit', r));
    host.kill('SIGTERM');
    const timer = setTimeout(() => host.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  }
}
