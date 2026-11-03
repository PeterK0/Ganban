import { create } from 'zustand';

/**
 * The project update being written. There is one draft, held in memory, and
 * every update composer shows it, so it follows you across project switches:
 * Home's Project dropdown, Home's project tabs, and the sidebar on Project >
 * Home or Comments. Posting or cancelling discards it. Its tags are not part of
 * the draft: tasks belong to one project, so each composer starts its own.
 *
 * Not in localStorage: a draft is content, not a cosmetic preference
 * (docs/dev/TAB_SPEC.md).
 */
interface UpdateDraft {
  open: boolean;
  text: string;
}

export const useUpdateDraft = create<UpdateDraft>(() => ({ open: false, text: '' }));

export const openUpdateDraft = () => useUpdateDraft.setState({ open: true });
export const setUpdateDraftText = (text: string) => useUpdateDraft.setState({ text });
export const discardUpdateDraft = () => useUpdateDraft.setState({ open: false, text: '' });
