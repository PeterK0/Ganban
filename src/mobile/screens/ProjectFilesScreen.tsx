import { useMemo, useState } from "react";
import { confirmDialog } from '../../lib/confirm';
import type { Project } from "../../types";
import { getProjectStorage, type ProjectStorage } from "../../lib/api";
import {
  listProjectFiles,
  listProjectAttachments,
  uploadProjectFile,
  deleteProjectFile,
  downloadProjectFile,
  downloadSharedFile,
  reindexProject,
  type ProjectFile,
  type ProjectAttachment,
} from "../../lib/daemon";
import { useNav } from "../nav";
import {
  Badge,
  EmptyState,
  ErrorBanner,
  RefreshBtn,
  Screen,
  SectionHeader,
  Segmented,
  Select,
  Spinner,
  errMsg,
  useAsync,
} from "../ui";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function fileGlyph(name: string, type?: string | null): string {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const t = type || "";
  if (t.startsWith("image/")) return "🖼️";
  if (t.startsWith("video/")) return "🎬";
  if (t.startsWith("audio/")) return "🎵";
  if (ext === "pdf") return "📕";
  if (["md", "txt", "rtf"].includes(ext)) return "📄";
  if (["doc", "docx"].includes(ext)) return "📘";
  if (["xls", "xlsx", "csv"].includes(ext)) return "📊";
  if (["zip", "tar", "gz", "7z", "rar"].includes(ext)) return "🗜️";
  return "📎";
}

interface Row {
  kind: "project" | "task";
  id: number;
  name: string;
  type?: string | null;
  size: number;
  uploaded: string;
  taskTitle?: string;
}

type GroupBy = "All" | "By task";
type SortBy = "Newest" | "Oldest" | "Name" | "Size";

export default function ProjectFilesScreen({ project }: { project: Project }) {
  const nav = useNav();
  const { data, loading, error, reload } = useAsync(
    () =>
      Promise.all([
        listProjectFiles(project.id),
        listProjectAttachments(project.id),
        getProjectStorage(project.id),
      ]).then(([files, attachments, storage]) => ({ files, attachments, storage })),
    [project.id]
  );

  const [groupBy, setGroupBy] = useState<GroupBy>("All");
  const [sortBy, setSortBy] = useState<SortBy>("Newest");
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const files: ProjectFile[] = data?.files ?? [];
  const attachments: ProjectAttachment[] = data?.attachments ?? [];
  const storage: ProjectStorage | undefined = data?.storage;

  const rows = useMemo<Row[]>(() => {
    const all: Row[] = [
      ...files.map((f) => ({
        kind: "project" as const,
        id: f.id,
        name: f.file_name,
        type: f.file_type,
        size: f.size_bytes,
        uploaded: f.created_at,
      })),
      ...attachments.map((a) => ({
        kind: "task" as const,
        id: a.id,
        name: a.file_name,
        type: a.file_type,
        size: a.storage_size,
        uploaded: a.created_at,
        taskTitle: a.task_title,
      })),
    ];
    all.sort((a, b) => {
      switch (sortBy) {
        case "Oldest":
          return new Date(a.uploaded).getTime() - new Date(b.uploaded).getTime();
        case "Name":
          return a.name.localeCompare(b.name);
        case "Size":
          return b.size - a.size;
        default:
          return new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime();
      }
    });
    return all;
  }, [files, attachments, sortBy]);

  const groups = useMemo<{ label: string; rows: Row[] }[]>(() => {
    if (groupBy === "All") return [{ label: "", rows }];
    const project_ = rows.filter((r) => r.kind === "project");
    const byTask = new Map<string, Row[]>();
    for (const r of rows) {
      if (r.kind !== "task") continue;
      const k = r.taskTitle || "Untitled task";
      (byTask.get(k) ?? byTask.set(k, []).get(k)!).push(r);
    }
    const out: { label: string; rows: Row[] }[] = [];
    if (project_.length) out.push({ label: "Project files", rows: project_ });
    for (const k of [...byTask.keys()].sort((a, b) => a.localeCompare(b))) out.push({ label: k, rows: byTask.get(k)! });
    return out;
  }, [rows, groupBy]);

  async function onPick(list: FileList | null) {
    if (!list || list.length === 0) return;
    const arr = Array.from(list);
    setActionErr(null);
    for (let i = 0; i < arr.length; i++) {
      setUploading({ done: i, total: arr.length });
      try {
        await uploadProjectFile(project.id, arr[i], undefined, { target: project.name });
      } catch (e) {
        setActionErr(`${arr[i].name}: ${errMsg(e)}`);
        break;
      }
    }
    setUploading(null);
    reload();
  }

  async function onDelete(r: Row) {
    if (r.kind !== "project") return;
    if (!await confirmDialog(`Delete "${r.name}"? This removes it from the host.`)) return;
    try {
      await deleteProjectFile(r.id);
      reload();
    } catch (e) {
      setActionErr(errMsg(e));
    }
  }

  async function onDownload(r: Row) {
    try {
      if (r.kind === "project") await downloadProjectFile(r.id, r.name);
      else await downloadSharedFile(r.id, r.name);
    } catch (e) {
      setActionErr(`Download failed: ${errMsg(e)}`);
    }
  }

  async function onReindex() {
    setIndexing(true);
    setNote(null);
    try {
      await reindexProject(project.id);
      setNote("Indexing started — it runs in the background on the host and may take a few minutes.");
    } catch (e) {
      setNote(`Could not start indexing: ${errMsg(e)}`);
    } finally {
      setIndexing(false);
    }
  }

  const usedPct = storage && storage.quota > 0 ? Math.min(100, Math.round((storage.used / storage.quota) * 100)) : 0;
  const nearFull = usedPct >= 90;

  return (
    <Screen
      title="Files"
      subtitle={project.name}
      onBack={nav.pop}
      right={<RefreshBtn onClick={reload} />}
    >
      {error && <ErrorBanner message={error} onRetry={reload} />}
      {actionErr && <ErrorBanner message={actionErr} />}

      {/* Storage */}
      {storage && (
        <div className="px-4 pt-3">
          <div className="flex justify-between items-baseline text-xs gm-mut mb-1.5">
            <span className="g-flbl mb-0">Storage</span>
            <span className={nearFull ? "text-error font-medium" : ""}>
              {formatBytes(storage.used)} / {formatBytes(storage.quota)}
            </span>
          </div>
          <div className="h-1.5 bg-surface-0 rounded-sm overflow-hidden">
            <div className={`h-full ${nearFull ? "bg-error" : "bg-gold"}`} style={{ width: `${usedPct}%` }} />
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 px-4 pt-3">
        <label className={`g-btn g-btn-pri flex-1 min-h-[44px] text-[15px] cursor-pointer active:bg-primary-hover ${uploading ? "opacity-50" : ""}`}>
          {uploading ? `Uploading ${uploading.done + 1}/${uploading.total}…` : "Upload files"}
          <input
            type="file"
            multiple
            className="hidden"
            disabled={!!uploading}
            onChange={(e) => {
              onPick(e.target.files);
              e.currentTarget.value = "";
            }}
          />
        </label>
        <button
          onClick={onReindex}
          disabled={indexing}
          className="g-btn g-btn-gilt min-h-[44px] active:bg-gilt-b"
        >
          {indexing ? "Starting…" : "Update AI"}
        </button>
      </div>
      {note && <p className="px-4 pt-2 text-xs gm-mut">{note}</p>}

      {/* Group / sort */}
      {rows.length > 0 && (
        <div className="px-4 pt-3 grid grid-cols-2 gap-2">
          <Segmented options={["All", "By task"] as const} value={groupBy} onChange={setGroupBy} />
          <Select
            value={sortBy}
            onChange={setSortBy}
            options={(["Newest", "Oldest", "Name", "Size"] as const).map((o) => ({ value: o, label: o }))}
          />
        </div>
      )}

      {/* List */}
      {loading && !data ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState text="No files yet. Upload files here, or attach them to tasks — they all show up in this project." />
      ) : (
        <div className="pb-24 pt-2">
          {groups.map((g) => (
            <div key={g.label || "_all"}>
              {g.label && <SectionHeader>{g.label}</SectionHeader>}
              {g.rows.map((r) => (
                <div key={`${r.kind}-${r.id}`} className="flex items-center gap-3 pl-4 pr-1 py-2 min-h-[60px] border-b border-gilt-b">
                  <span className="text-xl shrink-0">{fileGlyph(r.name, r.type)}</span>
                  <button onClick={() => onDownload(r)} className="flex-1 min-w-0 min-h-[44px] text-left active:opacity-60">
                    <div className="text-[15px] truncate flex items-center gap-2">
                      <span className="truncate">{r.name}</span>
                      {r.kind === "task" && groupBy === "All" && r.taskTitle && (
                        <Badge>{r.taskTitle}</Badge>
                      )}
                    </div>
                    <div className="text-sm gm-mut">
                      {formatBytes(r.size)} · {new Date(r.uploaded).toLocaleDateString()}
                    </div>
                  </button>
                  {r.kind === "project" && (
                    <button onClick={() => onDelete(r)} aria-label="Delete" className="min-w-[44px] min-h-[44px] text-error active:opacity-60">
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Screen>
  );
}
