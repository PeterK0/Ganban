// User-facing documentation pages. Authored as markdown in this folder and
// imported raw (Vite `?raw`) so they're bundled with the app — readable in
// Settings → Documentation and seeded into the welcome project for new users.
import welcome from './welcome.md?raw';
import projects from './projects-tasks-events.md?raw';
import tabs from './tabs.md?raw';
import workflows from './assistant-workflows.md?raw';
import aiTools from './ai-tools.md?raw';
import team from './team-and-sharing.md?raw';

export interface DocPage {
  id: string;
  title: string;
  /** One-line summary for lists / cards. */
  blurb: string;
  content: string;
}

/** Order = display order. The first page is the default / welcome page. */
export const DOC_PAGES: DocPage[] = [
  { id: 'welcome', title: 'Welcome to Ganban', blurb: 'What Ganban is and how it fits together.', content: welcome },
  { id: 'projects', title: 'Projects, tasks & events', blurb: 'The core flow: projects hold tasks, tasks play out as events.', content: projects },
  { id: 'tabs', title: 'Tabs — extending a project', blurb: 'Optional panels & tool bundles you add per project.', content: tabs },
  { id: 'workflows', title: 'Working with the assistant', blurb: 'Instruct the agent to run real workflows — with examples.', content: workflows },
  { id: 'ai-tools', title: 'AI: tools, connectors & loadouts', blurb: 'Shape what the assistant can do — including the web.', content: aiTools },
  { id: 'team', title: 'Your team — people, profiles & assistants', blurb: 'Profiles, easy invites, and equipping your assistants.', content: team },
];

export const getDocPage = (id: string): DocPage | undefined => DOC_PAGES.find((p) => p.id === id);
