# Task visibility is enforced on the host, a hidden task is absent, and areas are the lever

Members of a project no longer all see every task in it. A task's audience is the owner, the project's admins, the
task's assignees, and whoever its visibility admits: by default the members its area allows (everyone, unless the area
is restricted to its area members), or selected members, or admins only. The host enforces this on every path that
returns task data, through the same access rules and result filters as project membership: commands, file routes,
search, the assistant's tools, notifications. Outside the audience a task is absent, not shown as a placeholder: it is
missing from lists and counts, and asking for it says "not found", the way another project's rows look. Areas carry
the restriction so a team sets it up once ("Finance" is Ana and Bo) and every task filed there is covered. A task can
only narrow from its area, and only admins change who can see a task.

## Considered options

- **A locked placeholder ("🔒 Private task") in lists and counts:** rejected. It leaks that work exists, and how much.
- **Four flat per-task levels, with "its area's members" as one choice:** rejected. Every task would need setting, and
  areas would do nothing by themselves.
- **Keeping restricted tasks out of the search index:** rejected. Search hits are filtered for the asking member
  instead, so admins' assistants still find everything.

## Consequences

- Removing someone from a project also drops them from its areas and its tasks' selected members.
- Assigning someone to a task lets them see it. Any member who can see a task may assign.
- Deleting a restricted area turns its tasks into "selected members" with the area's members, so nothing becomes
  visible by accident.
- The desktop app and the host's own agents run as the owner and see everything. A member's assistant reads through
  the command table as that member.
- A proposal or an agent action about a task goes with the task: it's recognised by the task its arguments name.
- A chat thread published to the project isn't filtered: publishing is the author's deliberate share, and its answers
  may draw on tasks other members can't see.
- Area members and selected members live on the host only, like assignments. The owner's offline replica syncs a
  task's visibility setting and an area's restriction, but not those lists.
