import { useCallback, useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { deleteEventFile, getEventFiles } from '../lib/api';
import {
  canUploadFromDisk,
  downloadEventFile,
  hasDaemon,
  listUploadFiles,
  openEventFile,
  uploadEventFile,
  type DiskFile,
} from '../lib/daemon';
import { filesFromDrop, filesFromInput } from '../lib/folderDrop';
import { confirmDialog } from '../lib/confirm';
import { useDataPulse } from '../lib/livePulse';
import { fmtBytes, retryFailedUploads, useUploadSummary, useUploads } from '../lib/uploads';
import type { EventAttachment } from '../types';

type Item = { file: File | DiskFile; relPath?: string };

interface Props {
  eventId: number;
  eventTitle: string;
  /** The number of files, whenever the list loads (for the tab's count). */
  onCount?: (n: number) => void;
}

/**
 * An event's files: stored on the host, against no project's quota. The owner
 * and the workspace admins drop or pick files and folders here (each upload
 * goes through the upload manager, so the tray shows it); everyone who sees the
 * event opens and downloads them.
 */
export default function EventFiles({ eventId, eventTitle, onCount }: Props) {
  const group = `event:${eventId}`;
  const online = hasDaemon();
  const [files, setFiles] = useState<EventAttachment[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fromDisk = online && canManage && canUploadFromDisk();
  const onCountRef = useRef(onCount);
  onCountRef.current = onCount;

  const load = useCallback(async () => {
    try {
      const r = await getEventFiles(eventId);
      setFiles(r.files);
      setCanManage(r.canManage);
      onCountRef.current?.(r.files.length);
    } catch (e) {
      setError(`Couldn't load the files: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoaded(true);
    }
  }, [eventId]);

  useEffect(() => {
    setFiles([]);
    setLoaded(false);
    setError(null);
    setNotice(null);
    void load();
  }, [load]);
  useDataPulse(() => void load(), ['events']);

  // Files landing (first runs and retries alike) refresh the list, debounced.
  const { done, active } = useUploadSummary(group);
  const failed = useUploads((s) => s.items.filter((i) => i.group === group && i.status === 'error').length);
  useEffect(() => {
    if (done === 0) return;
    const t = setTimeout(() => void load(), active ? 1500 : 300);
    return () => clearTimeout(t);
  }, [done, active, load]);

  async function upload(items: Item[]) {
    setError(null);
    setNotice(null);
    if (items.length === 0) {
      setNotice('Nothing to upload there: the folder is empty, or holds only hidden files.');
      return;
    }
    await Promise.allSettled(
      items.map(({ file, relPath }) => uploadEventFile(eventId, file, relPath, { target: eventTitle, group })),
    );
    void load();
  }

  /** Desktop: the files behind picked or dropped paths (folders expand). */
  async function uploadPaths(paths: string[]) {
    try {
      const entries = await listUploadFiles(paths);
      if (!entries.length) {
        setNotice('Nothing to upload there: the folder is empty, or it couldn’t be read.');
        return;
      }
      await upload(entries.map((e) => ({ file: e, relPath: e.relPath ?? undefined })));
    } catch (e) {
      setError(`Could not read the files: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function pick(folder: boolean) {
    if (!fromDisk) {
      (folder ? folderInput : fileInput).current?.click();
      return;
    }
    const picked = await open({ multiple: true, directory: folder, title: folder ? 'Upload a folder to this event' : 'Upload files to this event' });
    if (picked) await uploadPaths(Array.isArray(picked) ? picked : [picked]);
  }

  // Desktop drops come as native window-wide events with paths; only a drop
  // over this area counts.
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
      .catch((e) => console.warn('Event files: native drop unavailable', e));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [fromDisk]);

  const remove = async (f: EventAttachment) => {
    if (!(await confirmDialog(`Delete "${f.rel_path || f.file_name}" from this event? This can't be undone.`))) return;
    try {
      await deleteEventFile(f.id);
      await load();
    } catch (e) {
      setError(`Couldn't delete the file: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const total = files.reduce((n, f) => n + f.size_bytes, 0);
  const uploads = online && canManage;

  return (
    <div
      ref={rootRef}
      onDragOver={(e) => {
        if (!uploads || fromDisk || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(e) => {
        if (!uploads) return;
        e.preventDefault();
        setDragOver(false);
        if (fromDisk) return; // the native handler above has it
        void filesFromDrop(e.dataTransfer)
          .then((items) => upload(items))
          .catch((err) => setError(`Could not read the dropped files: ${err instanceof Error ? err.message : String(err)}`));
      }}
      className="flex flex-col gap-4"
    >
      {!online ? (
        <p className="g-inset text-[13px] text-subtext-0">Event files live on the host. Connect to it to see them.</p>
      ) : canManage ? (
        <div className={`g-drop ${dragOver ? 'g-over' : ''} px-3 py-3 text-center`}>
          <p className="text-[13px] text-subtext-0 mb-2">Drop files or a folder here to attach them to this event</p>
          <div className="flex justify-center gap-2 flex-wrap">
            <button onClick={() => void pick(false)} className="g-btn g-btn-sm g-btn-ghost">Upload files</button>
            <button onClick={() => void pick(true)} className="g-btn g-btn-sm g-btn-ghost">Upload folder</button>
          </div>
        </div>
      ) : null}
      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          void upload(filesFromInput(e.target.files, false));
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
          void upload(filesFromInput(e.target.files, true));
          e.target.value = '';
        }}
      />

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

      {online && loaded && files.length === 0 && (
        <p className="text-sm text-[color:var(--g-mut)]">
          No files yet.{canManage ? '' : ' The owner or a project admin can attach some.'}
        </p>
      )}
      {files.length > 0 && (
        <div>
          <p className="g-cap mb-1">
            {files.length} file{files.length === 1 ? '' : 's'} · <span className="tabular-nums">{fmtBytes(total)}</span>
          </p>
          {files.map((f) => {
            const path = f.rel_path || f.file_name;
            const slash = path.lastIndexOf('/');
            return (
              <div key={f.id} className="g-frow flex items-center gap-2 py-1.5">
                <button
                  onClick={() => void openEventFile(f.id, f.file_name)}
                  className="flex-1 min-w-0 text-left hover:text-gold"
                  title={`Open ${path}`}
                >
                  <span className="block text-sm font-medium text-text truncate">{f.file_name}</span>
                  <span className="block text-xs text-[color:var(--g-mut)] truncate">
                    <span className="tabular-nums">{fmtBytes(f.size_bytes)}</span>
                    {slash > 0 && ` · ${path.slice(0, slash)}/`}
                  </span>
                </button>
                <button
                  onClick={() => void downloadEventFile(f.id, f.file_name)}
                  className="g-iconbtn !w-8 !h-8 shrink-0"
                  title="Download"
                  aria-label={`Download ${f.file_name}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                </button>
                {canManage && (
                  <button
                    onClick={() => void remove(f)}
                    className="g-iconbtn !w-8 !h-8 shrink-0 hover:!text-error"
                    title="Delete"
                    aria-label={`Delete ${f.file_name}`}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
