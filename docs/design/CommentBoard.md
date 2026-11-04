# Comment board — one update, several tasks

**Status:** BUILT 2026-10-12.

## Why

The owner leaves an end-of-day comment on progress. With 5+ live tasks, one
day's note usually covers two or three of them ("learn the vessels topic" and
"answer the questions" moved together), and copying it onto each task, or
picking one, both lose. The board makes the note ONE comment tagged with
every task it covers, and shows the project's comments as one feed.

## Model

- `comments.task_id` stays the comment's **home** task (NOT NULL, unchanged),
  so every existing comment, client and sync path keeps working.
- `comment_tasks (comment_id, task_id)` holds the **extra** tags. It never
  duplicates the home task, and every tag must be in the home task's project
  (ops refuses otherwise). There's a cap of 50.
- `Comment.task_ids` = home first, then extras. It's filled by every comment read
  and is never a column.
- **Replies follow their thread.** A reply carries no tags and lives on its
  thread's home task. A client replying from a *tagged* task's thread may
  send that task id; `create_comment` swaps in the parent's home task when it's
  in the same project, and refuses a cross-project parent.
- **Retag** (`set_comment_tags`) is for top-level comments only, and needs at least one task. If
  the home task is dropped, the first remaining task becomes home and the
  whole thread moves (recursive update, `updated_at` bumped so replicas pull it).
  Unchanged tags keep their row, so a no-op retag writes nothing.
- **Task threads** (`get_task_comments`, the task editor / detail pane / mobile)
  include comments tagged with the task, plus every reply under them. Reaction
  tallies (`/tasks/:id/reactions`) follow the same thread.
- **Bin:** the board shows a comment while at least one of its tasks is out
  of the Bin. **Permanent delete** of a home task first re-homes comments
  that are tagged elsewhere, so the cascade only takes single-task comments.

## The board (`get_project_comment_board`)

`{ comments, task_counts, has_more, time_since }`:

- **comments:** top-level comments newest first (`julianday` order, because rows mix
  `T`/space timestamp spellings), at most `limit` (default 50, max 1000),
  optionally only those tagged with ANY of `taskIds`. Each comes with all of its replies.
- **task_counts:** top-level comments per task, for the whole project.
- **time_since:** seconds tracked per task since `since` (the client's local
  midnight). This feeds the composer's "⏱ worked on today" suggestions.

Reactions for the whole board: `GET /projects/:id/reactions`.

## Where it shows

| Surface | What |
|---|---|
| Project › Comments | Tasks grouped by area on the left, with counts; click to filter (multi-select, ANY). With one task picked, the old task header shows (description, time tracked). Full board on the right; the composer pre-tags the filtered tasks. |
| Project › Home | "Updates": latest 5 + composer; chips open the task in the detail pane. "Open Comments →" goes to the Comments tab. |
| Home | "Updates" with a tab per project plus **All** (merged across workspaces). It follows the sidebar's project filter. Each project's board talks to that project's **own** workspace (`workspaceBoardApi`), so posting from Home lands on the right host. Pasted images and reactions only show when that workspace is the active transport. With a project selected, "Open {project}'s Comments →" sets `commentBoardIntent`, so the project opens on its Comments tab. |

## The composer

- **Text field** (`MarkdownField.tsx`, inside `CommentEditor.tsx`): it grows with its text up to about 60% of the
  window, then scrolls. Its handle drags a height of your own (arrow keys too); a double-click resets it. One height
  is remembered per device for every composer.
- **Preview:** beside the text when the composer is at least 720px wide (its own width, not the window's), under it
  when narrower. It shows once there's text, and the toolbar's Preview toggle hides it (remembered per device).
- **Tag picker** (`TaskTagPicker.tsx`): arrow keys and Enter pick rows. When the search matches no task title
  exactly, the last row is `Create task "…"`: it calls `create_task` on the board's host with the usual defaults
  for a new task (To Do, Medium, no area) and tags the new task. A refusal shows the host's error in the picker and
  tags nothing.

The code is in `src/components/comments/`: `boardApi.ts` (transport adapter), `TaskTagPicker.tsx`,
`CommentBoard.tsx` (composer, feed, `useBoard`), `HomeUpdates.tsx`.

## Sync, scope, older hosts

- `comment_tasks` mirrors `task_contacts`. It's in `SYNC_TABLES`, `PUSH_TABLES` and
  `CAPTURED_TABLES`, and gets sync_uuid/updated_at/deleted_at from groundwork. Both FKs
  remap by parent sync_uuid. This is tested both ways with shifted id spaces
  (`crates/core/tests/comment_board.rs`).
- `get_project_comment_board` needs project membership, and `set_comment_tags`
  needs membership of the comment's project. Both are access rules in the command
  table (`crates/server/src/commands/comments.rs`), where a command without one is
  refused (ADR 0001).
- A host that predates this answers `unknown command`. The board then says to
  update the host, and Home's All feed lists that project as "not shown".

## Not built (yet)

- Untagged project-wide notes. These would need `comments.task_id` nullable,
  which means a table rebuild of a synced table. Tag a task for now.
- A board on mobile (task threads there already include tagged comments).
- Choosing ALL-of instead of ANY-of when filtering by several tasks.
