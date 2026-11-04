// The import job's progress, as the Import screen shows it: a label for the stage and how full the
// bar is. Pure, so scripts/test-finance-import-job.mjs can check it.

export type ImportStage = 'reading' | 'rates' | 'accounts' | 'rows' | 'pairing' | 'rules' | 'done';

/** The fields of an import job this needs. */
export interface JobProgress {
  state: 'running' | 'done' | 'failed';
  stage: ImportStage;
  done: number;
  total: number;
}

/** Each stage's share of the bar: the rows take most of the time, then the final pass. */
const SPAN: Record<ImportStage, [number, number]> = {
  reading: [0, 2],
  rates: [2, 6],
  accounts: [6, 8],
  rows: [8, 80],
  pairing: [80, 90],
  rules: [90, 100],
  done: [100, 100],
};

/** How full the bar is, 0 to 100: the stage's span, filled by rows done of the total. */
export function progressPercent(job: JobProgress): number {
  if (job.state === 'done') return 100;
  const [from, to] = SPAN[job.stage] ?? [0, 0];
  const share = job.total > 0 ? Math.min(1, Math.max(0, job.done / job.total)) : 0;
  return Math.round(from + (to - from) * share);
}

/** What the job is doing, in words. */
export function stageLabel(job: JobProgress, fmt: (n: number) => string = String): string {
  if (job.state === 'failed') return 'The import stopped';
  switch (job.stage) {
    case 'reading':
      return 'Reading the file…';
    case 'rates':
      return 'Fetching exchange rates…';
    case 'accounts':
      return 'Setting up the accounts…';
    case 'rows':
      return `Importing lines: ${fmt(job.done)} of ${fmt(job.total)}`;
    case 'pairing':
      return 'Matching transfers…';
    case 'rules':
      return job.total > 0 ? `Applying rules: ${fmt(job.done)} of ${fmt(job.total)}` : 'Applying rules…';
    case 'done':
      return 'Done';
  }
  return 'Importing…';
}
