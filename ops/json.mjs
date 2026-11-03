#!/usr/bin/env node
// The JSON files the ops scripts write (update-status.json, the client builds' manifest.json),
// so no shell has to quote JSON. Writes are atomic (a temp file, then a rename).
//
//   node ops/json.mjs set <file> key=value key:=<json> clients.desktop=...   merge into <file> (made if missing)
//   node ops/json.mjs new <file> key=value ...                               write <file> afresh
//   node ops/json.mjs get <file> key                                         print a value ('' when missing)
//
// `key=value` sets a string, `key:=json` a raw JSON value (a number, null). Dots go into objects.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const [mode, file, ...pairs] = process.argv.slice(2);
if (!['set', 'new', 'get'].includes(mode) || !file) {
  console.error('usage: node ops/json.mjs set|new|get <file> key=value key:=json ...');
  process.exit(2);
}
let doc = {};
if (mode !== 'new') {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed;
  } catch {
    // missing or unreadable: start empty
  }
}
if (mode === 'get') {
  let v = doc;
  for (const k of (pairs[0] ?? '').split('.')) v = v != null && typeof v === 'object' ? v[k] : undefined;
  process.stdout.write(v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  process.exit(0);
}
for (const pair of pairs) {
  const raw = pair.match(/^([A-Za-z0-9_.]+):=(.*)$/s);
  const str = pair.match(/^([A-Za-z0-9_.]+)=(.*)$/s);
  const m = raw ?? str;
  if (!m) {
    console.error(`json.mjs: not key=value: ${pair}`);
    process.exit(2);
  }
  const value = raw ? JSON.parse(m[2]) : m[2];
  const keys = m[1].split('.');
  let o = doc;
  for (const k of keys.slice(0, -1)) o = o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {};
  o[keys.at(-1)] = value;
}
const tmp = `${file}.tmp-${process.pid}`;
writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
renameSync(tmp, file);
