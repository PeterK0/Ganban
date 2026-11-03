import type { OracleDefinition } from './daemon';

// The Oracle template library: installable starting points, grouped by what
// they teach/do. Deliberately one or two blanks away from runnable (a project
// picker, a URL) — filling them IS the tutorial. Compiled-in for now; a
// shareable community library waits on the protocol-signing trust story
// (PROTOCOLS.md, R.3+).

export interface OracleTemplate {
  name: string;
  category: string;
  blurb: string;
  def: OracleDefinition;
}

const row = (nodes: OracleDefinition['nodes'], wires: OracleDefinition['wires']): OracleDefinition => ({ nodes, wires });

export const ORACLE_TEMPLATES: OracleTemplate[] = [
  {
    name: 'News digest → comment',
    category: 'Monitoring',
    blurb: 'Fetch a news page hourly, summarize the top stories, file the digest as a gated comment on a task.',
    def: row(
      [
        { id: 't', type: 'trigger.schedule', x: 24, y: 48, params: { every: '1 hour' } },
        { id: 'f', type: 'fetch.http', x: 264, y: 48, params: { url: 'https://news.ycombinator.com' } },
        { id: 'l', type: 'llm.transform', x: 504, y: 48, params: { instruction: 'Summarize the top 3 stories into bullets, one source per claim.' } },
        { id: 'w', type: 'write.comment', x: 744, y: 48, params: {} },
      ],
      [{ from: 't', to: 'f' }, { from: 'f', to: 'l' }, { from: 'l', to: 'w' }]
    ),
  },
  {
    name: 'Price / index watch',
    category: 'Monitoring',
    blurb: 'Pull a data page on a schedule and extract just the figures that matter into a comment.',
    def: row(
      [
        { id: 't', type: 'trigger.schedule', x: 24, y: 48, params: { every: '6 hours' } },
        { id: 'f', type: 'fetch.http', x: 264, y: 48, params: { url: '' } },
        { id: 'l', type: 'llm.transform', x: 504, y: 48, params: { instruction: 'Extract the headline figures (name, value, change) as a compact table. Data only — no commentary.' } },
        { id: 'w', type: 'write.comment', x: 744, y: 48, params: {} },
      ],
      [{ from: 't', to: 'f' }, { from: 'f', to: 'l' }, { from: 'l', to: 'w' }]
    ),
  },
  {
    name: 'Page → new task',
    category: 'Intake',
    blurb: 'Fetch any page, extract the gist, and propose a NEW task carrying it as the description.',
    def: row(
      [
        { id: 't', type: 'trigger.manual', x: 24, y: 48 },
        { id: 'f', type: 'fetch.http', x: 264, y: 48, params: { url: '' } },
        { id: 'l', type: 'llm.transform', x: 504, y: 48, params: { instruction: 'Extract the page title and a two-sentence summary.' } },
        { id: 'w', type: 'write.task', x: 744, y: 48, params: { title: 'Page snapshot' } },
      ],
      [{ from: 't', to: 'f' }, { from: 'f', to: 'l' }, { from: 'l', to: 'w' }]
    ),
  },
  {
    name: 'Dataset → answer',
    category: 'Data',
    blurb: 'Read a CSV from a project’s files and ask the model one question about it — the seam the Python nodes will extend.',
    def: row(
      [
        { id: 't', type: 'trigger.manual', x: 24, y: 48 },
        { id: 'r', type: 'file.read', x: 264, y: 48, params: {} },
        { id: 'l', type: 'llm.transform', x: 504, y: 48, params: { instruction: 'What columns does this dataset have, and roughly how many rows? Answer in two lines.' } },
      ],
      [{ from: 't', to: 'r' }, { from: 'r', to: 'l' }]
    ),
  },
  {
    name: 'Morning brief',
    category: 'Digests',
    blurb: 'Every morning at 07:00, fetch a source and file a three-bullet brief with citations.',
    def: row(
      [
        { id: 't', type: 'trigger.schedule', x: 24, y: 48, params: { every: '07:00' } },
        { id: 'f', type: 'fetch.http', x: 264, y: 48, params: { url: '' } },
        { id: 'l', type: 'llm.transform', x: 504, y: 48, params: { instruction: 'Write a three-bullet brief (≤90 words) with a source per claim.' } },
        { id: 'w', type: 'write.comment', x: 744, y: 48, params: {} },
      ],
      [{ from: 't', to: 'f' }, { from: 'f', to: 'l' }, { from: 'l', to: 'w' }]
    ),
  },
];

export const TEMPLATE_CATEGORIES = [...new Set(ORACLE_TEMPLATES.map((t) => t.category))];
