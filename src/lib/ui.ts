// Shared UI constants.

// The Assistant tabs (Chats, Corpus, Indexing, Models) all use ONE left-column
// width, so the tree/list doesn't jump as you switch tabs. Kept compact — the
// list is a navigator, not the content. (The literal must stay here so Tailwind
// generates the class; interpolated `${...}` elsewhere reuses it.)
export const ASSISTANT_TREE_W = 'w-72';
