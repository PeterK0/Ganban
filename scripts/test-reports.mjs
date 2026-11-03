#!/usr/bin/env node
// Pure-module tests (report engine, export, invite parsing, quiz grading). No test framework in this repo: the pure
// modules are bundled with esbuild (already here via vite) and asserted with
// node:assert. External readers (openpyxl via uv, poppler's pdftotext) validate
// the XLSX/PDF bytes independently and SKIP LOUDLY when absent.
//   npm run test:reports
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('.test-build', { recursive: true });
const esb = (entry, out, extra = '') =>
  execSync(`npx esbuild ${entry} --bundle --platform=node --format=esm --outfile=${out} --log-level=error ${extra}`, { stdio: 'inherit' });
esb('src/lib/reportGenerator.ts', '.test-build/rg.mjs');
esb('src/lib/reportExport.ts', '.test-build/rx.mjs', '--external:pdfmake/build/pdfmake --external:pdfmake/build/vfs_fonts');
esb('src/lib/invite.pure.ts', '.test-build/invite.mjs');
esb('src/lib/quizGrade.ts', '.test-build/quizGrade.mjs');

let failed = false;
for (const f of ['scripts/tests/report-engine.test.mjs', 'scripts/tests/report-export.test.mjs', 'scripts/tests/invite.test.mjs', 'scripts/tests/quiz-grade.test.mjs']) {
  console.log(`\n▶ ${f}`);
  try {
    execSync(`node --no-warnings ${f}`, { stdio: 'inherit' });
  } catch {
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
