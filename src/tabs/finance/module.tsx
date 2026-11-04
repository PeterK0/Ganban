import { lazy } from 'react';
import type { TabModule } from '../modules';

/**
 * Finance: the personal ledger (docs/design/FINANCE.md). A top-level view of its own rather than a
 * project tab, shown when the host has it and the user turned it on in Settings → Plug-ins.
 */
const finance: TabModule = {
  id: 'finance',
  icon: 'finance',
  rail: {
    label: 'Finance',
    icon: 'finance',
    view: lazy(() => import('./FinanceView')),
    description: 'Your accounts, imported bank statements and categories. Private to you: nobody else on this host sees it.',
  },
};

export default finance;
