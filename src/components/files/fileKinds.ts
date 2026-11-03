// What kind of file a name is: the browser's type filter, its icons and its
// thumbnails. Pure, so it can be shared and tested without a DOM.

export type FileCategory = 'documents' | 'images' | 'video' | 'audio' | 'archives' | 'other';

export const CATEGORIES: { id: FileCategory; label: string }[] = [
  { id: 'documents', label: 'Documents' },
  { id: 'images', label: 'Images' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'archives', label: 'Archives' },
  { id: 'other', label: 'Other' },
];

const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'avif', 'tif', 'tiff'];
const VIDEO = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'];
const AUDIO = ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac'];
const ARCHIVE = ['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'bz2', 'xz'];
const DOCUMENT = [
  'pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'pages',
  'xls', 'xlsx', 'ods', 'csv', 'tsv', 'numbers',
  'ppt', 'pptx', 'odp', 'key', 'html', 'htm', 'epub',
];
/** Images a browser can draw as a thumbnail. */
const DRAWABLE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'];

/** The lowercased extension ("" for none). */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function categoryOf(name: string, type?: string | null): FileCategory {
  const ext = extOf(name);
  const t = type || '';
  if (t.startsWith('image/') || IMAGE.includes(ext)) return 'images';
  if (t.startsWith('video/') || VIDEO.includes(ext)) return 'video';
  if (t.startsWith('audio/') || AUDIO.includes(ext)) return 'audio';
  if (ARCHIVE.includes(ext)) return 'archives';
  if (DOCUMENT.includes(ext) || t.startsWith('text/') || t === 'application/pdf') return 'documents';
  return 'other';
}

/** Whether a thumbnail can be drawn for it (an image a browser renders). */
export function isDrawable(name: string, type?: string | null): boolean {
  const ext = extOf(name);
  return DRAWABLE.includes(ext) || (!!type && /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml|avif)$/.test(type));
}

export function iconFor(name: string, type?: string | null): string {
  const ext = extOf(name);
  switch (categoryOf(name, type)) {
    case 'images':
      return '🖼️';
    case 'video':
      return '🎬';
    case 'audio':
      return '🎵';
    case 'archives':
      return '🗜️';
    case 'documents':
      if (ext === 'pdf') return '📕';
      if (['xls', 'xlsx', 'csv', 'tsv', 'ods', 'numbers'].includes(ext)) return '📊';
      if (['ppt', 'pptx', 'odp', 'key'].includes(ext)) return '📙';
      if (['doc', 'docx', 'odt', 'pages'].includes(ext)) return '📘';
      return '📄';
    default:
      if (['py', 'rs', 'ts', 'tsx', 'js', 'jsx', 'json', 'toml', 'yaml', 'yml', 'go', 'ipynb'].includes(ext)) return '🧩';
      return '📎';
  }
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}
