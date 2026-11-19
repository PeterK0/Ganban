#!/usr/bin/env node
/**
 * The smoke run: opens the app in a headless browser and walks the paths the owner uses every day, so a lane finds a
 * broken screen before he does. docs/dev/TESTING.md § Smoke run has the details.
 *
 *   npm run qa:smoke                        # its own throwaway host on 8814, every path but the slow ones
 *   npm run qa:smoke -- --port 8830         # another port
 *   npm run qa:smoke -- --url http://127.0.0.1:8823   # a QA host that's already running (scripts/qa-host.sh)
 *   npm run qa:smoke -- --only task-autosave   # one path (repeat --only for more)
 *   npm run qa:smoke -- --full              # adds finance-large (6,000 lines)
 *   npm run qa:smoke -- --list              # the paths, and stop
 *   npm run qa:smoke -- --headed            # watch it (a visible window)
 *   npm run qa:smoke -- --browser-url http://127.0.0.1:9222   # drive a browser you started (you hold the lock)
 *
 * It needs a built host (target/debug/ganban-server and dist/): build first, it never builds. It runs
 * scripts/qa-host.sh on a fresh seed of fictional data (scripts/gilt-qa-seed.mjs) in /tmp, never a real gansty.db.
 *
 * The browser: SMOKE_BROWSER if set, else the first of Brave, Chrome and Chromium at their usual places. Only one
 * browser may run at a time on a shared machine, so it takes /tmp/gilt-qa.lock (a folder) and waits while another
 * run holds it. On every exit it stops the host and the browser, and deletes the browser's profile and the host's data.
 *
 * Each path is one function in PATHS below. A path fails on a wrong result, a console error, a page error or a React
 * key warning; then its screenshot and console go to /tmp/ganban-smoke/<run>/ and the run goes on. Exit 1 if any
 * path failed.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = '/tmp/gilt-qa.lock';
const RUN = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const OUT = `/tmp/ganban-smoke/${RUN}`;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const o = { port: 8814, url: null, only: [], full: false, list: false, headed: false, browserUrl: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) usage(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--port') o.port = Number(next());
    else if (a === '--url') o.url = next().replace(/\/+$/, '');
    else if (a === '--only') o.only.push(...next().split(','));
    else if (a === '--full') o.full = true;
    else if (a === '--list') o.list = true;
    else if (a === '--headed') o.headed = true;
    else if (a === '--browser-url') o.browserUrl = next();
    else if (a === '--help' || a === '-h') usage();
    else usage(`unknown argument ${a}`);
  }
  if (!Number.isInteger(o.port) || o.port < 1024) usage('--port wants a number');
  return o;
}

function usage(msg) {
  if (msg) console.error(msg);
  console.error(
    'usage: npm run qa:smoke -- [--port N | --url URL] [--only NAME]… [--full] [--list] [--headed] [--browser-url URL]',
  );
  process.exit(2);
}

// ---------------------------------------------------------------- small helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class SmokeError extends Error {}
/** Fail the path with a message that says what was expected. */
function expect(cond, msg) {
  if (!cond) throw new SmokeError(msg);
}

/** Polls `fn` (in Node) until it returns something truthy; fails with `msg` after `ms`. */
async function until(fn, msg, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  let lastError = null;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      if (e instanceof SmokeError) throw e;
      lastError = e; /* not there yet */
    }
    if (Date.now() > end) {
      const text = typeof msg === 'function' ? await msg(last) : msg;
      throw new SmokeError(lastError ? `${text} (${`${lastError.message}`.split('\n')[0]})` : text);
    }
    await sleep(150);
  }
}

/** Text the user sees, with whitespace squeezed. */
const visibleText = (page) => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));

async function waitForText(page, text, ms = 8000) {
  await until(async () => (await visibleText(page)).includes(text), `"${text}" never showed`, ms);
}

/** XPath literal for any string (concat() when it holds both quote kinds). */
function xstr(s) {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat('${s.split("'").join(`', "'", '`)}')`;
}

/**
 * A visible element by role and accessible name, the way a person finds it: buttons by their text or aria-label,
 * links, tabs, menu items. `exact: false` matches a name that contains `name`.
 */
async function byRole(page, role, name, { exact = true, within = null, ms = 8000 } = {}) {
  return until(
    () =>
      page.evaluateHandle(
        (role, name, exact, within) => {
          const roots = within ? [within] : [document];
          const tags = {
            // A button with a role of its own (a tab, a switch, an option) is found by that role.
            button: 'button:not([role]),[role="button"],input[type="button"],input[type="submit"]',
            link: 'a[href],[role="link"]',
            tab: '[role="tab"]',
            menuitem: '[role="menuitem"],[role="menuitemcheckbox"],[role="option"]',
            switch: '[role="switch"]',
            checkbox: 'input[type="checkbox"],[role="checkbox"]',
            separator: '[role="separator"]',
            textbox: 'input:not([type]),input[type="text"],input[type="search"],textarea,[contenteditable="true"]',
            combobox: 'select,[role="combobox"]',
          };
          const field = (el) => /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !/button|submit/.test(el.type);
          const labelledBy = (el) =>
            (el.getAttribute('aria-labelledby') || '')
              .split(/\s+/)
              .map((id) => (id && document.getElementById(id)?.textContent) || '')
              .join(' ')
              .trim();
          const nameOf = (el) =>
            (
              el.getAttribute('aria-label') ||
              labelledBy(el) ||
              (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent) ||
              (field(el) ? el.getAttribute('placeholder') : el.textContent || el.value) ||
              el.getAttribute('title') ||
              ''
            )
              .replace(/\s+/g, ' ')
              .trim();
          const shown = (el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
          };
          for (const root of roots) {
            for (const el of root.querySelectorAll(tags[role] || `[role="${role}"]`)) {
              if (!shown(el)) continue;
              const n = nameOf(el);
              if (exact ? n === name : n.includes(name)) return el;
            }
          }
          return null;
        },
        role,
        name,
        exact,
        within,
      ).then(async (h) => {
        const el = h.asElement();
        if (!el) {
          await h.dispose();
          return null;
        }
        return el;
      }),
    `no ${role} "${name}"`,
    ms,
  );
}

/** The form field under a visible label: a `<label>` (or label-styled text) whose text is `label`, and the first
 * input, select or textarea in the same field block. */
async function byLabel(page, label, { within = null, ms = 8000 } = {}) {
  return until(
    () =>
      page
        .evaluateHandle(
          (label, within) => {
            const root = within || document;
            const shown = (el) => el.getBoundingClientRect().width > 0;
            for (const el of root.querySelectorAll('[aria-label]')) {
              if (el.getAttribute('aria-label') === label && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && shown(el)) return el;
            }
            // A label's own words: its text without the options of a field inside it.
            const own = (lab) =>
              [...lab.childNodes]
                .filter((n) => !(n.nodeType === 1 && n.matches('select,input,textarea')))
                .map((n) => n.textContent)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();
            for (const lab of root.querySelectorAll('label, .g-flbl')) {
              if (own(lab) !== label || !shown(lab)) continue;
              if (lab.htmlFor) {
                const f = document.getElementById(lab.htmlFor);
                if (f) return f;
              }
              const inside = lab.querySelector('input,select,textarea');
              if (inside) return inside;
              for (let p = lab.parentElement; p && p !== root; p = p.parentElement) {
                const f = [...p.querySelectorAll('input,select,textarea')].find(shown);
                if (f) return f;
              }
            }
            return null;
          },
          label,
          within,
        )
        .then(async (h) => h.asElement() || (await h.dispose(), null)),
    `no field labelled "${label}"`,
    ms,
  );
}

/** The smallest visible element whose text is `text` (for rows a phone makes tappable without a button). */
async function byText(page, text, ms = 8000) {
  return until(
    () =>
      page
        .evaluateHandle((text) => {
          let best = null;
          for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1 || (el.innerText || '').trim() !== text) continue;
            if (!best || best.contains(el)) best = el;
          }
          return best;
        }, text)
        .then(async (h) => h.asElement() || (await h.dispose(), null)),
    `nothing shows "${text}"`,
    ms,
  );
}

async function click(page, role, name, opts) {
  // React may swap the element between finding and clicking it: find it again then.
  for (let attempt = 1; ; attempt++) {
    try {
      const el = await byRole(page, role, name, opts);
      await el.scrollIntoView();
      await el.click();
      return el;
    } catch (e) {
      if (attempt >= 3 || !/detached|not clickable/i.test(e?.message ?? '')) throw e;
      await sleep(200);
    }
  }
}

/** Replaces a text field's value the way typing does (select all, type). */
async function typeInto(el, text) {
  await el.click({ clickCount: 3 });
  await el.evaluate((e) => {
    if ('select' in e) e.select();
  });
  await el.press('Backspace');
  await el.type(text, { delay: 2 });
}

/** Sets a `<select>` by the option's visible text. */
async function choose(selectEl, optionText) {
  const value = await selectEl.evaluate((s, t) => [...s.options].find((o) => o.text.trim() === t)?.value, optionText);
  expect(value !== undefined, `no option "${optionText}"`);
  await selectEl.select(value);
}

/** The task rows of the open project's list (each a button carrying the active-task hint). */
async function taskRow(page, title, ms = 8000) {
  return until(
    () =>
      page
        .evaluateHandle((title) => {
          for (const b of document.querySelectorAll('button[title="Double-click to set as the active task"]')) {
            if (b.innerText.split('\n').some((l) => l.trim() === title)) return b;
          }
          return null;
        }, title)
        .then(async (h) => h.asElement() || (await h.dispose(), null)),
    `task "${title}" is not in the list`,
    ms,
  );
}

async function rowText(page, title) {
  const row = await taskRow(page, title);
  return row.evaluate((b) => b.innerText.replace(/\s+/g, ' '));
}

/** A box helper: is `inner` fully inside `outer`? */
const inside = (inner, outer) =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width + 0.5 &&
  inner.y + inner.height <= outer.y + outer.height + 0.5;

const overlap = (a, b) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** A 1x1 PNG, and a small text file, both made here. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// ---------------------------------------------------------------- app navigation (shared by paths)

/** Opens the app at Home, fresh. */
async function openHome(ctx) {
  await ctx.page.goto(ctx.base + '/', { waitUntil: 'load' });
  await byRole(ctx.page, 'button', 'Home', { ms: 20000 });
  await waitForText(ctx.page, 'PROJECTS', 15000);
}

/** Opens a seeded project's task list from the sidebar. */
async function openProjectTasks(ctx, name) {
  const { page } = ctx;
  await openHome(ctx);
  await click(page, 'button', 'Projects');
  await click(page, 'button', name, { exact: false });
  await click(page, 'button', 'Tasks');
  await byRole(page, 'button', 'New task');
}

/** Creates a task in the open list and opens it; returns its title. */
async function newTask(ctx, title) {
  const { page } = ctx;
  await click(page, 'button', 'New task');
  const input = await byRole(page, 'textbox', 'Task title…');
  await input.type(title);
  await input.press('Enter');
  const row = await taskRow(page, title);
  await row.click();
  await until(
    async () => (await (await byLabel(page, 'Title')).evaluate((e) => e.value)) === title,
    `the new task "${title}" did not open`,
  );
  return title;
}

/** The open task's description as markdown: switches the field to editing first. */
async function descriptionField(page) {
  const find = () => byRole(page, 'textbox', 'Supports markdown', { exact: false, ms: 1500 });
  try {
    return await find();
  } catch {
    await click(page, 'button', 'Edit');
    return find();
  }
}

/** Puts the caret in a text field at `pos` (the field keeps focus). */
async function caretAt(el, pos) {
  await el.evaluate((e, pos) => {
    e.focus();
    e.setSelectionRange(pos, pos);
  }, pos);
}

/** Sets a field the way React hears it (a date input can't be typed into the same way in every locale). */
async function setNativeValue(el, value) {
  await el.evaluate((e, value) => {
    const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, value);
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

// ---------------------------------------------------------------- Finance

/** A fictional statement: lines `from` to `from + count - 1`, oldest first, four a day, line `last` dated yesterday
 * (so 350 lines fit in the last 90 days, which an import doesn't file as history). The tag and the line number make
 * every line unique, so a host that's reused (--url) sees no duplicates from an earlier run. Headers no built-in
 * format knows, so the import goes through the column-mapping wizard. Payees are made up. */
function statement(from, count, tag, last) {
  const payees = ['Corner Bakery', 'Lantern Books', 'Tram Pass', 'Hilltop Grocer', 'Night Owl Cinema', 'Studio Rent', 'Pixel Phone Co', 'Riverside Gym'];
  const rows = [['Booked on', 'Text', 'Counterparty', 'Amount', 'Ccy']];
  const now = new Date();
  const yesterday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86400000;
  for (let i = from; i < from + count; i++) {
    const d = new Date(yesterday - Math.floor((last - i) / 4) * 86400000);
    const payee = payees[(i * 7) % payees.length];
    const income = i % 25 === 0;
    const cents = income ? 250000 + (i % 7) * 1000 : -(150 + ((i * 7919) % 9000));
    rows.push([
      d.toISOString().slice(0, 10),
      income ? `Salary ref ${tag}-${i}` : `Card payment ref ${tag}-${i}`,
      income ? 'Fictional Employer Ltd' : payee,
      (cents / 100).toFixed(2),
      'EUR',
    ]);
  }
  return rows.map((r) => r.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n';
}

/** Switches Finance on in Settings › Plug-ins (if it's off) and opens it from the sidebar. */
async function openFinance(ctx) {
  const { page } = ctx;
  await openHome(ctx);
  const inSidebar = await byRole(page, 'button', 'Finance', { ms: 1500 }).catch(() => null);
  if (!inSidebar) {
    await page.keyboard.down('Control');
    await page.keyboard.press(',');
    await page.keyboard.up('Control');
    await click(page, 'button', 'Plug-ins');
    // The section reloads the switches from the host as it opens; a click before that lands is undone by it (a
    // race the app has: the switch flips back). Wait for the reload, as a person's slower hand does.
    await page.waitForNetworkIdle({ idleTime: 400, timeout: 5000 }).catch(() => {});
    const on = async () => (await byRole(page, 'switch', 'Finance', { exact: false })).evaluate((e) => e.getAttribute('aria-checked') === 'true');
    if (!(await on())) await click(page, 'switch', 'Finance', { exact: false });
    await until(on, 'the Finance switch did not turn on');
    await page.keyboard.press('Escape');
  }
  await click(page, 'button', 'Finance');
  await byRole(page, 'tab', 'Import', { exact: false, ms: 15000 });
}

/** The inbox count on the Transactions tab (0 when it shows none). */
async function inboxBadge(page) {
  const tab = await byRole(page, 'tab', 'Transactions', { exact: false });
  return Number((await tab.evaluate((e) => e.innerText)).replace(/\D/g, '') || 0);
}

/** Imports a file through the Import tab; maps its columns with the wizard if the bank isn't known yet. Returns the
 * result's numbers by label ("new", "already there", …) and the seconds the import took. */
async function importStatement(ctx, file, bankName, timeout = 60000, { keepOld = false } = {}) {
  const { page } = ctx;
  await click(page, 'tab', 'Import', { exact: false });
  const again = await byRole(page, 'button', 'Import another', { ms: 800 }).catch(() => null);
  if (again) await again.click();
  await byRole(page, 'button', 'Choose a file');
  const input = await page.$('input[type="file"][accept*=".csv"]');
  expect(input, 'the Import tab has no file input');
  await input.uploadFile(file);
  await byRole(page, 'button', 'Cancel', { ms: 15000 });
  const bank = await byLabel(page, 'Bank');
  const known = await bank.evaluate((s, name) => [...s.options].some((o) => o.text.trim() === name), bankName);
  if (known) {
    if ((await bank.evaluate((s) => s.selectedOptions[0]?.text.trim())) !== bankName) {
      await choose(bank, bankName);
      await byRole(page, 'button', 'Cancel', { ms: 15000 });
    }
  } else {
    // An unknown file opens the wizard by itself; otherwise ask for it.
    if (!(await byRole(page, 'button', 'Hide columns', { ms: 500 }).catch(() => null))) await click(page, 'button', 'Map columns…');
    const wizard = (
      await page.evaluateHandle(() => [...document.querySelectorAll('.g-stitle')].find((e) => e.textContent.trim() === 'Columns')?.closest('.g-card'))
    ).asElement();
    expect(wizard, 'Map columns opened no wizard');
    for (const [label, column] of [
      ['Date *', 'Booked on'],
      ['Description *', 'Text'],
      ['Amount (signed)', 'Amount'],
      ['Currency', 'Ccy'],
      ['Payee', 'Counterparty'],
    ]) {
      await choose(await byLabel(page, label, { within: wizard }), column);
    }
    await choose(await byLabel(page, 'Date format', { within: wizard }), 'YYYY-MM-DD');
    await choose(await byLabel(page, 'Decimal mark', { within: wizard }), 'Point (12.50)');
    await typeInto(await byLabel(page, "Name this bank's format", { within: wizard }), bankName);
    await click(page, 'button', 'Save and preview');
    await until(
      async () => (await (await byLabel(page, 'Bank', { ms: 1000 }).catch(() => null))?.evaluate((s) => s.selectedOptions[0]?.text.trim())) === bankName,
      'the saved format is not chosen for the file',
      15000,
    );
  }
  // keepOld: old lines stay in To sort instead of filing themselves as history. The box loads its saved state from
  // the host as the preview opens: wait for that, or the late answer flips it back after the click.
  await page.waitForNetworkIdle({ idleTime: 400, timeout: 5000 }).catch(() => {});
  const oldBox = (
    await page.evaluateHandle(() =>
      [...document.querySelectorAll('label')].find((l) => l.textContent.includes('Sort lines older than'))?.querySelector('input[type="checkbox"]'),
    )
  ).asElement();
  if (oldBox && (await oldBox.evaluate((b) => b.checked)) === keepOld) await oldBox.click();
  if (oldBox) await until(async () => (await oldBox.evaluate((b) => b.checked)) !== keepOld, 'the "Sort lines older than" box did not take its setting');
  const started = Date.now();
  await click(page, 'button', 'Import');
  await byRole(page, 'button', 'Import another', { ms: timeout }).catch(async () => {
    throw new SmokeError(`the import did not finish in ${timeout / 1000} s: ${(await visibleText(page)).slice(-300)}`);
  });
  const secs = (Date.now() - started) / 1000;
  const numbers = await page.evaluate(() => {
    const title = [...document.querySelectorAll('.g-stitle')].find((e) => /^(Imported|Nothing new)/.test(e.textContent.trim()));
    const card = title?.closest('.g-card');
    const out = { new: Number(title?.textContent.replace(/\D/g, '') || 0) };
    for (const cell of card?.querySelectorAll('.g-inset') ?? []) {
      const [n, label] = cell.innerText.split('\n');
      out[label.trim()] = Number(n.replace(/\D/g, ''));
    }
    return out;
  });
  return { numbers, secs };
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------------------------------------------------------------- the paths

const PATHS = {
  /** The app opens and Home shows the seeded projects. */
  async load(ctx) {
    await openHome(ctx);
    const text = await visibleText(ctx.page);
    for (const p of ['Harbour Gallery', 'Ganban Desktop', 'Kitchen Renovation', 'Studio Accounts', 'Autumn Reading']) {
      expect(text.includes(p), `Home does not show the project "${p}"`);
    }
  },

  /** A new task in a project appears in its list. */
  async 'task-create'(ctx) {
    await openProjectTasks(ctx, 'Studio Accounts');
    const title = `Smoke task ${ctx.stamp}`;
    await newTask(ctx, title);
    await taskRow(ctx.page, title);
  },

  /** Edit title and description, switch to another task, reload: the edit is there. */
  async 'task-autosave'(ctx) {
    const { page } = ctx;
    await openProjectTasks(ctx, 'Kitchen Renovation');
    await newTask(ctx, `Autosave ${ctx.stamp}`);
    const title = `Autosaved ${ctx.stamp}`;
    const note = `Written by the smoke run ${ctx.stamp}, never saved by hand.`;
    await typeInto(await byLabel(page, 'Title'), title);
    const desc = await descriptionField(page);
    await desc.click();
    await desc.type(note);
    // Another task: the editor saves the one it leaves.
    await (await taskRow(page, 'Agree the tiling dates')).click();
    await until(
      async () => (await (await byLabel(page, 'Title')).evaluate((e) => e.value)) === 'Agree the tiling dates',
      'the other task did not open',
    );
    // The save of the task it left lands when the list shows the new title.
    await taskRow(page, title, 10000);
    await page.reload({ waitUntil: 'load' });
    await openProjectTasks(ctx, 'Kitchen Renovation');
    await (await taskRow(page, title, 10000)).click();
    await until(
      async () => (await (await byLabel(page, 'Title')).evaluate((e) => e.value)) === title,
      'the renamed task did not open after a reload',
    );
    await until(
      async () =>
        (await visibleText(page)).includes(note) ||
        (await (await descriptionField(page)).evaluate((e, note) => e.value.includes(note), note)),
      'the description edit was lost after switching tasks and reloading',
    );
  },

  /** Status, priority and deadline change in the detail pane and show in the list. */
  async 'task-fields'(ctx) {
    const { page } = ctx;
    await openProjectTasks(ctx, 'Harbour Gallery');
    const title = await newTask(ctx, `Fields ${ctx.stamp}`);
    expect((await rowText(page, title)).includes('To Do'), 'a new task is not To Do');
    await choose(await byLabel(page, 'Status'), 'Blocked');
    await choose(await byLabel(page, 'Priority'), 'High');
    const when = new Date();
    when.setDate(when.getDate() + 10);
    await setNativeValue(await byLabel(page, 'Deadline'), ymd(when));
    await click(page, 'button', 'Save changes');
    const dueLabel = await page.evaluate(
      (iso) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }),
      when.toISOString(),
    );
    await until(
      async () => {
        const t = await rowText(page, title);
        return t.includes('Blocked') && t.includes('High') && t.includes(dueLabel);
      },
      async () => `the list row does not show Blocked, High and ${dueLabel}: "${await rowText(page, title)}"`,
    );
  },

  /** A comment is added and shows below the description. */
  async comment(ctx) {
    const { page } = ctx;
    await openProjectTasks(ctx, 'Autumn Reading');
    await newTask(ctx, `Comment ${ctx.stamp}`);
    const text = `A smoke comment ${ctx.stamp}`;
    await click(page, 'button', 'Add the first comment').catch(() => click(page, 'button', '+ New'));
    const box = await byRole(page, 'textbox', 'Write a comment', { exact: false });
    await box.type(text);
    await click(page, 'button', 'Add Comment');
    await waitForText(page, text);
    const [c, d] = await page.evaluate((text) => {
      const box = (el) => el && el.getBoundingClientRect().toJSON();
      const comment = [...document.querySelectorAll('p,div,span')].find((e) => e.childElementCount === 0 && e.textContent.trim() === text);
      const label = [...document.querySelectorAll('.g-flbl')].find((e) => e.textContent.trim() === 'Description');
      return [box(comment), box(label)];
    }, text);
    expect(c && d, 'could not find the comment or the description');
    expect(c.y > d.y, 'the comment is not below the description');
  },

  /** Upload a file to a task; /file lists it; picking it inserts a link at the caret. */
  async 'file-link'(ctx) {
    const { page } = ctx;
    await openProjectTasks(ctx, 'Studio Accounts');
    await newTask(ctx, `File link ${ctx.stamp}`);
    const name = `smoke-note-${ctx.stamp}.txt`;
    const file = path.join(ctx.tmp, name);
    writeFileSync(file, 'A fictional note for the smoke run.\n');
    await click(page, 'tab', 'Files', { exact: false });
    const input = await until(
      () => page.$('input[type="file"]:not([webkitdirectory])'),
      'the Files tab has no upload input',
    );
    await input.uploadFile(file);
    await waitForText(page, name, 15000);
    await click(page, 'tab', 'Details');
    const desc = await descriptionField(page);
    await desc.click();
    await desc.type('Start of text. End of text.');
    await caretAt(desc, 'Start of text. '.length);
    await page.keyboard.type('/file');
    await waitForText(page, 'Link a file').catch(() => {
      throw new SmokeError('typing /file opened no picker');
    });
    await click(page, 'button', name, { exact: false });
    const value = await desc.evaluate((e) => e.value);
    const at = value.indexOf(`[${name}]`);
    expect(at >= 0, `no link to ${name} in the description: "${value}"`);
    const after = value.slice(at).replace(/^\[[^\]]*\]\([^)]*\)/, '');
    expect(!(value.slice(0, at) + after).includes('/file'), `the /file trigger stayed in the text: "${value}"`);
    expect(
      value.slice(0, at).trimEnd() === 'Start of text.' && after.trim() === 'End of text.',
      `the link is not at the caret: "${value}"`,
    );
  },

  /** Paste a PNG with the caret in the middle of the text: the markdown lands at the caret. */
  async 'paste-image'(ctx) {
    const { page } = ctx;
    await openProjectTasks(ctx, 'Ganban Desktop');
    await newTask(ctx, `Paste ${ctx.stamp}`);
    const desc = await descriptionField(page);
    await desc.click();
    await desc.type('Intro line one. Second line here.');
    await caretAt(desc, 'Intro line one.'.length);
    await desc.evaluate((e, b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'smoke.png', { type: 'image/png' }));
      e.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, PNG_1X1.toString('base64'));
    // The markdown, wherever the editor shows it now.
    const value = await until(async () => {
      const v = await (await descriptionField(page)).evaluate((e) => e.value);
      return v.includes('![') ? v : null;
    }, 'the pasted image left no markdown in the description');
    const at = value.indexOf('![');
    const after = value.slice(at).replace(/^!\[[^\]]*\]\([^)]*\)/, '');
    expect(
      value.slice(0, at).trim() === 'Intro line one.' && after.trim() === 'Second line here.',
      `the image markdown is not at the caret: ${JSON.stringify(value)}`,
    );
  },

  /** Two statuses in Filter & sort narrow the list; the popover stays inside the window at list widths 300 and 220. */
  async filter(ctx) {
    const { page } = ctx;
    await openProjectTasks(ctx, 'Ganban Desktop');
    const statuses = () =>
      page.$$eval('button[title="Double-click to set as the active task"] .sr-only', (s) =>
        s.map((e) => e.textContent.replace(/:\s*$/, '').trim()),
      );
    const before = await until(async () => {
      const s = await statuses();
      return s.length ? s : null;
    }, 'the task list stayed empty');
    // The list pane's drag handle (role separator, min 220): arrow keys, Home and Enter size it.
    const handle = await until(
      () =>
        page
          .evaluateHandle(() =>
            [...document.querySelectorAll('[role="separator"][aria-valuemin="220"]')].find(
              (e) => e.getBoundingClientRect().height > 0,
            ),
          )
          .then(async (h) => h.asElement() || (await h.dispose(), null)),
      'the task list has no resize handle',
    );
    const popover = () =>
      page.evaluateHandle(() => {
        const head = [...document.querySelectorAll('.g-deco')].find((e) => e.textContent.trim() === 'Filter & sort');
        return head?.closest('.g-card') ?? null;
      });
    for (const [width, key] of [
      [300, 'Enter'],
      [220, 'Home'],
    ]) {
      await handle.focus();
      await page.keyboard.press(key);
      await until(
        async () => Number(await handle.evaluate((e) => e.getAttribute('aria-valuenow'))) === width,
        `the task list did not go to ${width} px`,
      );
      await click(page, 'button', 'Filter & sort', { exact: false });
      const pop = (await popover()).asElement();
      expect(pop, 'Filter & sort opened no popover');
      if (width === 300) {
        await click(page, 'button', 'To Do', { exact: false, within: pop });
        await click(page, 'button', 'Blocked', { exact: false, within: pop });
      }
      const box = await pop.evaluate((e) => e.getBoundingClientRect().toJSON());
      const win = await page.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: innerHeight }));
      expect(inside(box, win), `at ${width} px the popover leaves the window: ${JSON.stringify(box)}`);
      // Close it the way a person does: click away.
      await page.mouse.click(win.width - 5, win.height - 5);
      await until(async () => !(await popover()).asElement(), 'the popover did not close on a click away');
    }
    await handle.focus();
    await page.keyboard.press('Enter');
    const after = await statuses();
    expect(after.length > 0 && after.length < before.length, `the list did not narrow (${before.length} → ${after.length})`);
    const wrong = after.filter((s) => s !== 'To Do' && s !== 'Blocked');
    expect(!wrong.length, `the filtered list still shows ${wrong.join(', ')}`);
    expect(after.includes('To Do') && after.includes('Blocked'), `the list lost a chosen status: ${after.join(', ')}`);
    // Leave the list unfiltered for the next run.
    await click(page, 'button', 'Filter & sort', { exact: false });
    await click(page, 'button', 'All', { exact: false, within: (await popover()).asElement() });
  },

  /** A new event shows on its day. */
  async event(ctx) {
    const { page } = ctx;
    await openHome(ctx);
    await click(page, 'button', 'Events');
    await click(page, 'button', 'Day');
    await click(page, 'button', 'Add Event');
    const title = `Smoke event ${ctx.stamp}`;
    const field = await byRole(page, 'textbox', 'Event title...');
    await typeInto(field, title);
    await field.press('Tab');
    const save = await byRole(page, 'button', 'Save now', { ms: 1500 }).catch(() => null);
    if (save) await save.click();
    await click(page, 'button', 'Month');
    const today = await page.evaluate(() => new Date().getDate());
    await until(
      () =>
        page.evaluate(
          (title, day) =>
            [...document.querySelectorAll('div,section,button')].some((cell) => {
              const t = cell.innerText || '';
              return t.split('\n')[0].trim() === String(day) && t.includes(title) && cell.innerText.length < 400;
            }),
          title,
          today,
        ),
      `the event "${title}" does not show on today's day in the month`,
    );
  },

  /** Finance on; a 300-line statement through the column wizard; the inbox count; one payee sorted; an overlapping
   * file reports its duplicates. */
  async 'finance-import'(ctx) {
    const { page } = ctx;
    const bank = `Smoke Bank ${ctx.stamp}`;
    const first = path.join(ctx.tmp, 'statement-1.csv');
    const second = path.join(ctx.tmp, 'statement-2.csv');
    writeFileSync(first, statement(0, 300, ctx.stamp, 349));
    writeFileSync(second, statement(200, 150, ctx.stamp, 349)); // lines 200-299 again, and 50 new
    await openFinance(ctx);
    const before = await inboxBadge(page);

    const one = await importStatement(ctx, first, bank);
    expect(one.numbers.new === 300, `the first import says ${JSON.stringify(one.numbers)}, not 300 new`);
    await until(async () => (await inboxBadge(page)) === before + 300, async () => `the inbox shows ${await inboxBadge(page)}, not ${before + 300}`);

    expect(one.numbers['to sort'] === 300, `the first import leaves ${one.numbers['to sort']} to sort, not 300`);

    // Sort one payee from To sort's payee view: picking a category files it, and the payee learns it.
    await click(page, 'button', 'Sort 300 lines');
    await click(page, 'tab', 'By payee');
    const picker = await byRole(page, 'button', 'Category for Corner Bakery', { exact: false, ms: 15000 });
    await picker.click();
    await page.keyboard.type('Eating');
    await page.keyboard.press('Enter');
    // Categorised means done: the payee leaves To sort, and the toast offers Undo.
    await until(
      () =>
        page.evaluate(
          () => ![...document.querySelectorAll('button[title="Show these lines"]')].some((b) => b.innerText.startsWith('Corner Bakery')),
        ),
      'the payee Corner Bakery is still in To sort after it was sorted',
      15000,
    );
    await until(
      () => page.evaluate(() => [...document.querySelectorAll('[role="status"]')].some((e) => /Corner Bakery → Eating out from now on/.test(e.innerText))),
      'no "Corner Bakery → Eating out from now on" toast',
      5000,
    );
    await byRole(page, 'button', 'Undo');

    // One line from the Lines view: it leaves the list.
    await click(page, 'tab', 'Lines');
    const row = await byRole(page, 'button', 'Category: none', { ms: 15000 });
    const left = await inboxBadge(page);
    await row.click();
    await page.keyboard.type('Shopping');
    await page.keyboard.press('Enter');
    await until(async () => (await inboxBadge(page)) < left, async () => `To sort still counts ${await inboxBadge(page)} after a line was filed`, 15000);

    // A move to one of his own accounts: the picker's second group, here a new account. Transfers then lists it.
    const before2 = await inboxBadge(page);
    await (await byRole(page, 'button', 'Category: none', { ms: 15000 })).click();
    await click(page, 'menuitem', 'A new account…');
    await typeInto(await byLabel(page, 'Name of the new account'), `Smoke Savings ${ctx.stamp}`);
    await page.keyboard.press('Enter');
    await until(async () => (await inboxBadge(page)) < before2, 'a line filed as a move stayed in To sort', 15000);
    await click(page, 'tab', 'Transfers');
    await byRole(page, 'button', 'Not a transfer', { ms: 15000 });
    await click(page, 'tab', 'To sort', { exact: false });

    // The next file: Corner Bakery's new lines file themselves, and the number opens them.
    const two = await importStatement(ctx, second, bank);
    expect(
      two.numbers['already imported'] === 100 && two.numbers.new === 50,
      `the overlapping import says ${JSON.stringify(two.numbers)}, not 50 new and 100 already imported`,
    );
    expect(two.numbers['filed by your payees and rules'] > 0, `the second import filed nothing by payee: ${JSON.stringify(two.numbers)}`);
    await click(page, 'button', 'filed by your payees and rules', { exact: false });
    await byRole(page, 'button', 'Show all', { ms: 10000 });
    expect((await visibleText(page)).includes('Filed by this import'), 'the filed number did not open its lines');

    // Payees & rules lists the payee with what it files under.
    await click(page, 'button', 'Payees & rules');
    await until(
      () => page.evaluate(() => [...document.querySelectorAll('[role="row"]')].some((r) => /Corner Bakery/.test(r.innerText) && /Eating out/.test(r.innerText))),
      'Payees & rules does not list Corner Bakery under Eating out',
      10000,
    );

    // A rule can be made from Rules: words in the description, and a category.
    await click(page, 'tab', 'Rules');
    await click(page, 'button', 'New rule');
    await typeInto(await byLabel(page, 'Description or payee has'), 'Salary ref');
    await (await byRole(page, 'button', 'Files under: none')).click();
    await page.keyboard.type('Salary');
    await page.keyboard.press('Enter');
    await click(page, 'button', 'Add rule');
    await until(
      () => page.evaluate(() => [...document.querySelectorAll('[role="listitem"]')].some((r) => /Text has “Salary ref”/.test(r.innerText) && /Salary/.test(r.innerText))),
      'the new rule is not listed under Rules',
      10000,
    );
  },

  /** --full: 6,000 lines import in under 60 s, and the inbox opens in under 2 s. */
  async 'finance-large'(ctx) {
    const { page } = ctx;
    const file = path.join(ctx.tmp, 'statement-large.csv');
    writeFileSync(file, statement(0, 6000, `L${ctx.stamp}`, 5999));
    await openFinance(ctx);
    const before = await inboxBadge(page);
    const { numbers, secs } = await importStatement(ctx, file, `Smoke Bank large ${ctx.stamp}`, 60000, { keepOld: true });
    expect(numbers.new === 6000, `the import says ${JSON.stringify(numbers)}, not 6000 new`);
    expect(secs < 60, `6,000 lines took ${secs.toFixed(1)} s (limit 60 s)`);
    // The three payees finance-import sorted on this host (Corner Bakery, the payee of the line it filed, and the one
    // it filed as a move) file their lines: about three in eight.
    await until(async () => (await inboxBadge(page)) >= before + 3000, async () => `To sort grew by ${(await inboxBadge(page)) - before}, not about 3,600`);
    const started = Date.now();
    await click(page, 'button', 'Sort ', { exact: false });
    await byRole(page, 'checkbox', 'Tick every line shown', { ms: 10000 });
    const open = (Date.now() - started) / 1000;
    expect(open < 2, `the inbox took ${open.toFixed(1)} s to open (limit 2 s)`);
    ctx.note = `import ${secs.toFixed(1)} s, inbox ${open.toFixed(1)} s`;
  },

  /** At 800×900 no two items of the top bar overlap. */
  /** Settings › Updates › Patch notes lists the versions with this one marked, and opens up to every version; the
   * update offer and "What's new" previews (`?preview=…`, no updater) open their notes and close. */
  async 'patch-notes'(ctx) {
    const { page } = ctx;
    await openHome(ctx);
    await page.keyboard.down('Control');
    await page.keyboard.press(',');
    await page.keyboard.up('Control');
    await click(page, 'button', 'Updates');
    const card = await until(() => page.$('[data-testid="patch-notes"]'), 'Settings › Updates has no Patch notes card');
    const text = async () => card.evaluate((e) => e.innerText.replace(/\s+/g, ' '));
    expect((await text()).includes('This version'), 'the patch notes do not mark this version');
    expect(!(await text()).includes('Ganban 0.1.0'), 'the patch notes list every version before asked');
    await click(page, 'button', 'Show every version');
    await until(async () => (await text()).includes('Ganban 0.1.0'), '"Show every version" did not show the first release');
    await page.keyboard.press('Escape');

    // The update offer, as a preview: its notice opens the dialog with the notes and the three choices; Later closes it.
    await page.goto(ctx.base + '/?preview=update-offer', { waitUntil: 'load' });
    await click(page, 'button', 'Ganban 9.9.9 is available', { ms: 20000 });
    await byRole(page, 'button', 'Download and install');
    await byRole(page, 'button', 'Skip this version');
    const focused = await page.evaluate(() => document.activeElement?.innerText.trim());
    expect(focused === 'Later', `the offer opens with the focus on "${focused}", not Later: Enter would act on it`);
    await waitForText(page, 'PATCH NOTES');
    await click(page, 'button', 'Later');
    await until(async () => !(await visibleText(page)).includes('Ganban 9.9.9 is available'), 'Later did not hide the offer');
    // Downloaded: the focus is on Later too, not Restart to finish.
    await page.goto(ctx.base + '/?preview=update-ready', { waitUntil: 'load' });
    await click(page, 'button', 'Restart to finish the update', { ms: 20000 });
    await byRole(page, 'button', 'Restart to finish');
    const focusedReady = await page.evaluate(() => document.activeElement?.innerText.trim());
    expect(focusedReady === 'Later', `the downloaded step opens with the focus on "${focusedReady}", not Later`);
    await page.keyboard.press('Escape');

    // "What's new", as a preview: it opens the notes with the new entries marked; Done dismisses it.
    await page.goto(ctx.base + '/?preview=whats-new', { waitUntil: 'load' });
    await click(page, 'button', "What's new", { ms: 20000 });
    await waitForText(page, 'NEW');
    await click(page, 'button', 'Done');
    await until(async () => !(await byRole(page, 'button', "What's new", { ms: 300 }).catch(() => null)), '"What\'s new" stayed after Done');
  },

  async narrow(ctx) {
    const { page } = ctx;
    await page.setViewport({ width: 800, height: 900 });
    await openHome(ctx);
    await sleep(500);
    const items = await page.evaluate(() => {
      // The top bar: the band of controls along the top edge, above the content.
      const bar = [...document.querySelectorAll('header, [role="banner"], div')].find((e) => {
        const r = e.getBoundingClientRect();
        return r.top <= 1 && r.width >= innerWidth - 2 && r.height > 30 && r.height < 90;
      });
      if (!bar) return null;
      // Its leaves: the smallest boxes that show something (text, an icon, an image).
      const leaves = [...bar.querySelectorAll('*')].filter((e) => {
        const r = e.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || getComputedStyle(e).visibility === 'hidden') return false;
        const ownText = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        return ownText || /^(svg|img|canvas|input|button)$/i.test(e.tagName);
      });
      // An icon or text inside a button counts as the button.
      const top = leaves.filter((e) => !leaves.some((o) => o !== e && o.contains(e)));
      // The control a box belongs to: its nearest button or link. A badge pinned on a control (positioned, letting
      // clicks through, like the count on the avatar) belongs to the control in the box it's pinned to.
      const controls = [];
      const ctl = 'button, a, [role="button"], [role="link"]';
      const controlOf = (e) => {
        let c = e.closest(ctl);
        const cs = getComputedStyle(e);
        if (!c && cs.position === 'absolute' && cs.pointerEvents === 'none') c = e.offsetParent?.querySelector(ctl) ?? null;
        if (!c || !bar.contains(c)) return -1;
        if (!controls.includes(c)) controls.push(c);
        return controls.indexOf(c);
      };
      return top.map((e) => ({
        control: controlOf(e),
        name: (e.innerText || e.getAttribute('aria-label') || e.tagName).replace(/\s+/g, ' ').trim().slice(0, 30),
        ...e.getBoundingClientRect().toJSON(),
      }));
    });
    expect(items && items.length > 2, 'found no top bar');
    const hits = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (items[i].control >= 0 && items[i].control === items[j].control) continue;
        if (overlap(items[i], items[j]) > 4) hits.push(`"${items[i].name}" and "${items[j].name}"`);
      }
    }
    expect(!hits.length, `the top bar overlaps at 800 px: ${hits.slice(0, 4).join('; ')}`);
  },

  /** A phone, 390×844: Home loads, a task opens, Finance opens. */
  async phone(ctx) {
    const { page } = ctx;
    // Finance shows on a phone once it's switched on (a setting that follows the user): switch it on at a desk first.
    const desk = await ctx.browser.newPage();
    try {
      await desk.setViewport({ width: 1440, height: 900 });
      await openFinance({ ...ctx, page: desk });
    } finally {
      await desk.close();
    }
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    );
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.goto(ctx.base + '/', { waitUntil: 'load' });
    await waitForText(page, 'Studio Accounts', 20000).catch(async () => {
      throw new SmokeError(`Home on a phone does not show the seeded projects: ${(await visibleText(page)).slice(0, 200)}`);
    });
    // A task: a project, then one of its tasks.
    await (await byText(page, 'Studio Accounts')).tap();
    const task = 'Renew the studio insurance';
    await (await byText(page, task, 10000)).tap();
    // The task screen: its title on top, its status below (the phone shows them as text, not a form).
    await until(
      async () => {
        const t = (await visibleText(page)).toLowerCase();
        return t.includes(task.toLowerCase()) && t.includes('status') && !t.includes('book the accountant');
      },
      `tapping "${task}" opened no task`,
      10000,
    );
    // Finance lives under More on a phone once it's switched on.
    await click(page, 'button', 'More', { ms: 15000 });
    const fin = await byRole(page, 'button', 'Finance', { exact: false, ms: 3000 }).catch(() => null);
    expect(fin, 'More has no Finance');
    await fin.tap();
    await byRole(page, 'tab', 'Transactions', { exact: false, ms: 15000 });
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(wide <= 391, `Finance on a phone is ${wide} px wide (window 390)`);
  },
};

// ---------------------------------------------------------------- host, browser, lock

function findBrowser() {
  if (process.env.SMOKE_BROWSER) {
    if (!existsSync(process.env.SMOKE_BROWSER)) throw new Error(`SMOKE_BROWSER=${process.env.SMOKE_BROWSER} does not exist`);
    return process.env.SMOKE_BROWSER;
  }
  const candidates = [
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/brave-browser',
    '/usr/bin/brave',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error('no Brave, Chrome or Chromium found; set SMOKE_BROWSER to one');
  return found;
}

const cleanups = [];
/** What must happen even on a hard exit (no awaiting there): the lock and the child processes. */
const syncCleanups = [];
let cleaning = null;
function cleanup() {
  if (!cleaning) {
    cleaning = (async () => {
      for (const fn of cleanups.reverse()) {
        try {
          await fn();
        } catch {
          /* best effort */
        }
      }
    })();
  }
  return cleaning;
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    console.error(`\n${sig}: cleaning up`);
    await cleanup();
    process.exit(130);
  });
}
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, async (e) => {
    console.error(`\nsmoke run stopped: ${e?.stack ?? e}`);
    await cleanup();
    process.exit(1);
  });
}
// A last resort for the lock and the children if something exits hard.
process.on('exit', () => {
  for (const fn of syncCleanups) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
});

/** Takes the shared browser lock (a folder; people take it by hand with mkdir too). A smoke run writes its pid in
 * it, so a lock left by a run that was killed outright is taken over; anyone else's lock is waited out. */
async function takeLock() {
  const started = Date.now();
  let said = 0;
  for (;;) {
    try {
      mkdirSync(LOCK);
      writeFileSync(`${LOCK}/smoke.pid`, String(process.pid));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = NaN;
      try {
        holder = Number(readFileSync(`${LOCK}/smoke.pid`, 'utf8'));
      } catch {
        /* someone else's lock: no pid in it */
      }
      if (holder && !alive(holder)) {
        console.log(`${LOCK} was left by a smoke run that died (pid ${holder}); taking it over`);
        rmSync(LOCK, { recursive: true, force: true });
        continue;
      }
      const mins = Math.floor((Date.now() - started) / 60000);
      if (said === 0 || mins >= said * 5) {
        console.log(`waiting for ${LOCK} (another browser run holds it${mins ? `, ${mins} min so far` : ''})…`);
        said = Math.max(1, Math.floor(mins / 5) + 1);
      }
      await sleep(2000);
    }
  }
  let held = true;
  const release = () => {
    // Once only: a second rmSync could delete the lock of the run that took it next.
    if (!held) return;
    held = false;
    rmSync(LOCK, { recursive: true, force: true });
  };
  cleanups.push(release);
  syncCleanups.push(release);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function health(base) {
  try {
    return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

async function startHost(port) {
  const base = `http://127.0.0.1:${port}`;
  if (await health(base)) throw new Error(`something already listens on ${base}; pick another --port, or pass --url`);
  for (const bin of [path.join(REPO, 'target/debug/ganban-server'), path.join(REPO, 'dist/index.html')]) {
    if (!existsSync(bin)) {
      throw new Error(`no ${path.relative(REPO, bin)}: build first (cargo build -p ganban-server, npx vite build)`);
    }
  }
  warnIfStale();
  // Its own seed, fresh each run: the dates in it are relative to today, and nothing another run did leaks in.
  const seedDir = `/tmp/ganban-smoke-seed-${port}`;
  rmSync(seedDir, { recursive: true, force: true });
  const log = [];
  const host = spawn('nice', ['-n', '10', path.join(REPO, 'scripts/qa-host.sh'), String(port)], {
    cwd: REPO,
    env: { ...process.env, GILT_QA_DIR: seedDir, GILT_SEED_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so stopping it also stops the seed script's short-lived host.
    detached: true,
  });
  const kill = (sig) => {
    try {
      process.kill(-host.pid, sig);
    } catch {
      /* already gone */
    }
  };
  const keep = (d) => {
    log.push(String(d));
    if (log.length > 200) log.shift();
  };
  host.stdout.on('data', keep);
  host.stderr.on('data', keep);
  const stop = async () => {
    if (host.exitCode === null && host.signalCode === null) {
      // (The exit hook below kills it only while it still runs, so a reused process group is never hit.)
      const gone = new Promise((r) => host.once('exit', r));
      kill('SIGTERM');
      const t = setTimeout(() => kill('SIGKILL'), 5000);
      await gone;
      clearTimeout(t);
    }
    rmSync(`/tmp/ganban-qa-${port}`, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
  };
  cleanups.push(stop);
  syncCleanups.push(() => host.exitCode === null && kill('SIGKILL'));
  const end = Date.now() + 90000;
  for (;;) {
    // The seed host answers /health on the same port before the real one, so wait for the line that says the
    // real host started.
    if (log.join('').includes('QA host on') && (await health(base))) break;
    if (host.exitCode !== null) throw new Error(`the QA host exited:\n${log.join('').slice(-2000)}`);
    if (Date.now() > end) throw new Error(`the QA host did not come up on ${base}:\n${log.join('').slice(-2000)}`);
    await sleep(300);
  }
  return { base, log };
}

/** A built web app older than the newest source file runs yesterday's code: say so (it doesn't fail the run). */
function warnIfStale() {
  try {
    const built = statSync(path.join(REPO, 'dist/index.html')).mtimeMs;
    const newest = Number(execFileSync('git', ['log', '-1', '--format=%ct', '--', 'src'], { cwd: REPO }).toString()) * 1000;
    if (newest > built) console.log('note: dist/ is older than the last commit to src/; run npx vite build for the current UI');
  } catch {
    /* no git: skip the hint */
  }
}

async function startBrowser(opts) {
  if (opts.browserUrl) {
    const browser = await puppeteer.connect({ browserURL: opts.browserUrl, defaultViewport: null });
    cleanups.push(() => browser.disconnect());
    return browser;
  }
  const executablePath = findBrowser();
  const profile = mkdtempSync('/tmp/ganban-smoke-profile-');
  cleanups.push(() => rmSync(profile, { recursive: true, force: true }));
  const browser = await puppeteer.launch({
    executablePath,
    headless: !opts.headed,
    userDataDir: profile,
    defaultViewport: null,
    args: [
      '--use-mock-keychain',
      '--password-store=basic',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--window-size=1440,1037',
    ],
  });
  const pid = browser.process()?.pid;
  cleanups.push(async () => {
    await Promise.race([browser.close(), sleep(5000)]);
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });
  syncCleanups.push(() => pid && browser.process()?.exitCode === null && process.kill(pid, 'SIGKILL'));
  return browser;
}

// ---------------------------------------------------------------- running a path

/** Console lines that fail a path: errors, and React's key warning (a development build logs it). */
const isKeyWarning = (t) => /same key|unique "key" prop/i.test(t);

/** The most a path may take before it's called hung (the browser lock is held all the while). */
const PATH_LIMIT_S = { 'finance-large': 300 };

async function runPath(browser, base, name, fn, opts) {
  // A browser context of its own: no storage (pane widths, filters) carries over from the path before.
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const consoleLines = [];
  const problems = [];
  page.on('console', (m) => {
    const t = m.text();
    consoleLines.push(`[${m.type()}] ${t}`);
    if (m.type() === 'error' || isKeyWarning(t)) problems.push(`console ${m.type()}: ${t.slice(0, 300)}`);
  });
  page.on('pageerror', (e) => {
    consoleLines.push(`[pageerror] ${e.message}`);
    problems.push(`page error: ${e.message.slice(0, 300)}`);
  });
  // The app's confirm() and prompt() dialogs would freeze a headless page: say yes, keep the default.
  page.on('dialog', async (d) => {
    consoleLines.push(`[dialog ${d.type()}] ${d.message()}`);
    await d.accept(d.defaultValue()).catch(() => {});
  });
  const ctx = { page, base, browser: context, stamp: `${RUN.slice(-6)}-${Math.floor(Math.random() * 1e4)}`, opts, tmp: opts.tmp };
  const started = Date.now();
  let error = null;
  const limit = PATH_LIMIT_S[name] ?? 120;
  let timer;
  try {
    await Promise.race([
      fn(ctx),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new SmokeError(`hung: still running after ${limit} s`)), limit * 1000);
      }),
    ]);
    await sleep(250); // an error the last step caused can arrive a moment later
  } catch (e) {
    // A tool error (not a failed check) says where in this script it happened.
    const where = e instanceof SmokeError ? null : (e?.stack ?? '').match(/qa-smoke\.mjs:(\d+)/)?.[1];
    error = e instanceof SmokeError ? e.message : `${`${e?.message ?? e}`.split('\n')[0]}${where ? ` (qa-smoke.mjs:${where})` : ''}`;
  }
  clearTimeout(timer);
  if (!error && problems.length) error = problems[0] + (problems.length > 1 ? ` (+${problems.length - 1} more)` : '');
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (error) {
    mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false }).catch(() => {});
    writeFileSync(`${OUT}/${name}.console.txt`, [`FAILED: ${error}`, ...problems, '', ...consoleLines].join('\n') + '\n');
  }
  await context.close().catch(() => {});
  return { name, ok: !error, error, secs, note: ctx.note };
}

// ---------------------------------------------------------------- main

const SLOW = new Set(['finance-large']);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const names = Object.keys(PATHS);
  if (opts.list) {
    for (const n of names) console.log(`${n}${SLOW.has(n) ? '  (--full)' : ''}`);
    return 0;
  }
  for (const n of opts.only) if (!PATHS[n]) usage(`no path "${n}" (try --list)`);
  const chosen = opts.only.length ? opts.only : names.filter((n) => opts.full || !SLOW.has(n));

  let base = opts.url;
  if (base && /:(8765|8770)(\/|$)/.test(base)) {
    usage(`${base} looks like a real host (8765, 8770): the smoke run writes test data, so point it at a QA host`);
  }
  opts.tmp = mkdtempSync('/tmp/ganban-smoke-files-');
  cleanups.push(() => rmSync(opts.tmp, { recursive: true, force: true }));
  // The lock first: a run that waits for it holds no host meanwhile.
  if (!opts.browserUrl) await takeLock();
  if (!base) {
    process.stdout.write(`starting a QA host on ${opts.port}… `);
    ({ base } = await startHost(opts.port));
    console.log('up');
  } else if (!(await health(base))) {
    throw new Error(`nothing answers on ${base}/health`);
  }
  const browser = await startBrowser(opts);

  const results = [];
  for (const n of chosen) {
    const r = await runPath(browser, base, n, PATHS[n], opts);
    results.push(r);
    console.log(
      `${r.ok ? 'ok    ' : 'FAILED'}  ${n.padEnd(16)} ${r.secs.padStart(5)} s${r.ok ? (r.note ? `  (${r.note})` : '') : `  ${r.error}`}`,
    );
  }
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length} of ${results.length} paths ok` +
      (failed.length ? `; ${failed.length} failed: ${failed.map((r) => r.name).join(', ')}\nscreenshots and console: ${OUT}/` : ''),
  );
  return failed.length ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(`\nsmoke run stopped: ${e?.message ?? e}`);
  code = 1;
} finally {
  await cleanup();
}
process.exit(code);
