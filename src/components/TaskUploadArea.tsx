import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { getProjectStorage, setProjectQuota } from '../lib/api';
import { canUploadFromDisk, listUploadFiles, uploadTaskFile, type DiskFile } from '../lib/daemon';
import { filesFromDrop, filesFromInput } from '../lib/folderDrop';
import { fmtBytes, isActive, retryFailedUploads, useUploadSummary, useUploads } from '../lib/uploads';

type Item = { file: File | DiskFile; relPath?: string };

interface Props {
  taskId: number;
  projectId: number;
  taskTitle: string;
  /** A project admin or the owner: may raise the quota on the spot. */
  canManage: boolean;
  /** Off where there's no host to upload to: just the children. */
  enabled?: boolean;
  /** Re-read the task's files and the project's storage. */
  onUploaded: () => void;
  /** Show the drop strip with its Upload buttons (default); off when a file
   * browser's toolbar has them and calls `pick` through the ref. */
  buttons?: boolean;
  children: ReactNode;
}

/** For a parent with its own Upload buttons: pick files or a folder into `dir`. */
export interface TaskUploadHandle {
  pick: (folder: boolean, dir?: string) => void;
}

const MB = 1024 * 1024;

/**
 * A task's Files tab as an upload target: drop or pick files or a whole folder
 * and each file goes to the host as the task's attachment, keeping its path
 * under the folder. Uploads stream (desktop: Rust reads the disk; web: the
 * browser sends each File without reading it in) through the upload manager,
 * so the UploadTray shows every file and the total. A folder that doesn't fit
 * the project's free storage is stopped before a byte moves; an admin can
 * raise the limit right here.
 */
const TaskUploadArea = forwardRef<TaskUploadHandle, Props>(function TaskUploadArea(
  { taskId, projectId, taskTitle, canManage, enabled = true, onUploaded, buttons = true, children },
  ref,
) {
  const group = `task:${taskId}`;
  const fromDisk = enabled && canUploadFromDisk();
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ items: Item[]; dir: string; total: number; free: number; used: number; folder: boolean } | null>(null);
  const [newLimitMb, setNewLimitMb] = useState('');
  const [raising, setRaising] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // The folder a web picker's files land in (its onChange can't take an argument).
  const dirRef = useRef('');

  // Files landing (first runs and retries alike) refresh the list, debounced.
  const { done, active } = useUploadSummary(group);
  const failed = useUploads((s) => s.items.filter((i) => i.group === group && i.status === 'error').length);
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;
  useEffect(() => {
    if (done === 0) return;
    const t = setTimeout(() => onUploadedRef.current(), active ? 1500 : 300);
    return () => clearTimeout(t);
  }, [done, active]);

  /** Check the batch against the project's free storage, then queue it. */
  /** Upload into `dir` (the browser's open folder; "" is the task's top level). */
  async function upload(items: Item[], dir = '') {
    setError(null);
    setNotice(null);
    if (items.length === 0) {
      setNotice('Nothing to upload there: the folder is empty, or holds only hidden files.');
      return;
    }
    const total = items.reduce((n, i) => n + i.file.size, 0);
    {
      const s = await getProjectStorage(projectId).catch(() => null);
      if (s) {
        // Bytes still on their way from an earlier drop count as used.
        const pending = useUploads
          .getState()
          .items.filter((i) => i.group === group && isActive(i))
          .reduce((n, i) => n + i.size - i.sent, 0);
        const free = Math.max(0, s.quota - s.used - pending);
        if (total > free) {
          setBlocked({ items, dir, total, free, used: s.used, folder: items.some((i) => i.relPath) });
          // Room for this batch plus a tenth, rounded up to a whole 100 MB.
          setNewLimitMb(String(Math.ceil((s.used + total * 1.1) / MB / 100) * 100));
          return;
        }
      }
    }
    setBlocked(null);
    // Failures show through the group's failed count below (with Retry), so
    // they clear themselves once a retry lands.
    await Promise.allSettled(
      items.map(({ file, relPath }) => {
        const path = dir ? `${dir}/${relPath || file.name}` : relPath;
        return uploadTaskFile(taskId, file, path, { target: taskTitle, group });
      }),
    );
    onUploadedRef.current();
  }

  async function raiseAndUpload() {
    if (!blocked) return;
    const mb = Number(newLimitMb);
    if (!Number.isFinite(mb) || mb <= 0) {
      setError('Enter the new limit in megabytes.');
      return;
    }
    setRaising(true);
    try {
      await setProjectQuota(projectId, Math.round(mb * MB));
    } catch (e) {
      setError(`Could not raise the limit: ${e instanceof Error ? e.message : String(e)}`);
      return;
    } finally {
      setRaising(false);
    }
    onUploadedRef.current();
    // Checked again: a limit that's still too small blocks with the new figures.
    void upload(blocked.items, blocked.dir);
  }

  /** Desktop: the files behind picked or dropped paths (folders expand). */
  async function uploadPaths(paths: string[], dir = '') {
    try {
      const entries = await listUploadFiles(paths);
      if (!entries.length) {
        setNotice('Nothing to upload there: the folder is empty, or it couldn’t be read.');
        return;
      }
      await upload(entries.map((e) => ({ file: e, relPath: e.relPath ?? undefined })), dir);
    } catch (e) {
      setError(`Could not read the files: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  useImperativeHandle(ref, () => ({ pick: (folder: boolean, dir = '') => void pick(folder, dir) }));

  async function pick(folder: boolean, dir = '') {
    if (!fromDisk) {
      // A web picker answers through its input's onChange: the folder waits here.
      dirRef.current = dir;
      (folder ? folderInput : fileInput).current?.click();
      return;
    }
    const picked = await open({ multiple: true, directory: folder, title: folder ? 'Upload a folder to this task' : 'Upload files to this task' });
    if (picked) await uploadPaths(Array.isArray(picked) ? picked : [picked], dir);
  }

  // Desktop drops come as native window-wide events with paths; only a drop
  // over this area counts (as in the project's Files tab).
  const uploadPathsRef = useRef(uploadPaths);
  uploadPathsRef.current = uploadPaths;
  useEffect(() => {
    if (!fromDisk) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    const over = (pos: { x: number; y: number }) => {
      const r = rootRef.current?.getBoundingClientRect();
      const x = pos.x / window.devicePixelRatio;
      const y = pos.y / window.devicePixelRatio;
      return !!r && r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    void import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((e) => {
          const p = e.payload;
          if (p.type === 'enter' || p.type === 'over') setDragOver(over(p.position));
          else if (p.type === 'leave') setDragOver(false);
          else if (p.type === 'drop') {
            setDragOver(false);
            if (p.paths.length && over(p.position)) void uploadPathsRef.current(p.paths);
          }
        }),
      )
      .then((un) => (alive ? (unlisten = un) : un()))
      .catch((e) => console.warn('Task files: native drop unavailable', e));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [fromDisk]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (fromDisk) return; // the native handler above has it
    void filesFromDrop(e.dataTransfer)
      .then((items) => upload(items))
      .catch((err) => setError(`Could not read the dropped files: ${err instanceof Error ? err.message : String(err)}`));
  };

  if (!enabled) return <div className="flex flex-col gap-4">{children}</div>;

  return (
    <div
      ref={rootRef}
      onDragOver={(e) => {
        if (fromDisk || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={onDrop}
      className="flex flex-col gap-4"
    >
      {buttons ? (
        <div className={`g-drop ${dragOver ? 'g-over' : ''} px-3 py-3 text-center`}>
          <p className="text-[13px] text-subtext-0 mb-2">Drop files or a folder here to upload them to the host</p>
          <div className="flex justify-center gap-2 flex-wrap">
            <button onClick={() => void pick(false)} className="g-btn g-btn-sm g-btn-ghost">Upload files</button>
            <button onClick={() => void pick(true)} className="g-btn g-btn-sm g-btn-ghost">Upload folder</button>
          </div>
        </div>
      ) : (
        dragOver && <div className="g-drop g-over px-3 py-3 text-center text-[13px] text-gold">Drop to upload to this task</div>
      )}
      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          void upload(filesFromInput(e.target.files, false), dirRef.current);
          e.target.value = '';
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        className="hidden"
        // @ts-expect-error non-standard but widely supported folder picker
        webkitdirectory=""
        directory=""
        onChange={(e) => {
          void upload(filesFromInput(e.target.files, true), dirRef.current);
          e.target.value = '';
        }}
      />

      {blocked && (
        <div className="g-inset text-[13px] space-y-2" role="alert">
          <p className="text-text">
            {blocked.folder ? 'This folder is' : blocked.items.length === 1 ? 'This file is' : 'These files are'}{' '}
            <b className="tabular-nums">{fmtBytes(blocked.total)}</b>; the project has{' '}
            <b className="tabular-nums">{fmtBytes(blocked.free)}</b> free.
          </p>
          {canManage ? (
            <div className="flex items-end gap-2 flex-wrap">
              <label className="flex-1 min-w-[140px]">
                <span className="g-flbl">New storage limit (MB)</span>
                <input
                  type="number"
                  min={1}
                  value={newLimitMb}
                  onChange={(e) => setNewLimitMb(e.target.value)}
                  className="g-field g-field-sm w-full tabular-nums"
                />
              </label>
              <button onClick={() => void raiseAndUpload()} disabled={raising} className="g-btn g-btn-sm g-btn-pri">
                {raising ? 'Raising…' : 'Raise and upload'}
              </button>
              <button onClick={() => setBlocked(null)} className="g-btn g-btn-sm g-btn-ghost">Cancel</button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <p className="flex-1 text-subtext-1">Ask a project admin to raise the project’s storage limit.</p>
              <button onClick={() => setBlocked(null)} className="g-btn g-btn-sm g-btn-ghost">OK</button>
            </div>
          )}
        </div>
      )}
      {(error || (failed > 0 && !active)) && (
        <div className="flex items-center gap-2 text-[13px] text-error" role="alert">
          <span className="flex-1">{error ?? `${failed} file${failed === 1 ? '' : 's'} didn’t upload.`}</span>
          {failed > 0 && !active && (
            <button
              onClick={() => {
                setError(null);
                retryFailedUploads(group);
              }}
              className="g-btn g-btn-sm g-btn-gilt"
            >
              Retry {failed === 1 ? 'the failed file' : `${failed} failed`}
            </button>
          )}
        </div>
      )}
      {notice && <p className="text-[13px] text-subtext-0">{notice}</p>}
      {children}
    </div>
  );
});

export default TaskUploadArea;
