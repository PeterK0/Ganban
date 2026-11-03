// In-page QR scanning for the BROWSER join screens (the native app has the
// Tauri barcode plugin; a Home Screen web app or a Safari tab has only what the
// web platform gives it). Two modes, chosen by what the platform allows:
//
//   live   — getUserMedia viewfinder, decoded ~7×/s. Exists only in a SECURE
//            context (https, or localhost). Over the plain http most tailnet
//            hosts serve, `navigator.mediaDevices` is undefined — not denied,
//            absent.
//   photo  — <input type="file" accept="image/*" capture="environment">: the
//            OS camera takes ONE still, we decode it. Works over http, needs no
//            permission prompt, and is the same tap count for the person.
//
// Both decode with jsQR (pure JS, no deps), loaded lazily — a join screen
// shouldn't carry a decoder until someone taps Scan. Whatever the QR held is
// handed back verbatim; callers run it through extractEnrollToken().

import { useEffect, useRef, useState } from 'react';

type Decoder = (data: Uint8ClampedArray, width: number, height: number, opts?: { inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst' }) => { data: string } | null;

let decoderPromise: Promise<Decoder> | null = null;
function loadDecoder(): Promise<Decoder> {
  decoderPromise ??= import('jsqr').then((m) => (m.default ?? m) as unknown as Decoder);
  return decoderPromise;
}

/** Can this page open a live camera stream? False over plain http (insecure
 * context) — the photo mode is the honest fallback there, not an error. */
export function canScanLive(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

/** Decode a QR from a still image. Tries the natural size, then a downscale —
 * phone photos are 12 MP and jsQR wants ≲ 1500 px on the long side to be quick. */
async function decodeImageFile(file: File): Promise<string | null> {
  const jsQR = await loadDecoder();
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("couldn't read that image"));
      i.src = url;
    });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    for (const maxSide of [1400, 800, 500]) {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const hit = jsQR(px.data, px.width, px.height, { inversionAttempts: 'attemptBoth' });
      if (hit?.data) return hit.data;
    }
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const live = canScanLive();
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Live mode can fail (permission denied, no camera) — then offer the photo path.
  const [liveFailed, setLiveFailed] = useState(false);
  const done = useRef(false);

  // ---- live viewfinder -----------------------------------------------------
  useEffect(() => {
    if (!live) return;
    let stream: MediaStream | null = null;
    let timer: number | null = null;
    let cancelled = false;
    (async () => {
      try {
        const jsQR = await loadDecoder();
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) return;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('no 2d canvas');
        const tick = () => {
          if (cancelled || done.current) return;
          if (video.readyState >= 2 && video.videoWidth > 0) {
            // Decode at ≤ 640 px wide: plenty for a QR filling a third of the
            // frame, and cheap enough for a phone at 7 fps.
            const scale = Math.min(1, 640 / video.videoWidth);
            canvas.width = Math.round(video.videoWidth * scale);
            canvas.height = Math.round(video.videoHeight * scale);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const hit = jsQR(px.data, px.width, px.height, { inversionAttempts: 'dontInvert' });
            if (hit?.data) {
              done.current = true;
              onResult(hit.data);
              return;
            }
          }
          timer = window.setTimeout(tick, 140);
        };
        tick();
      } catch (e) {
        if (cancelled) return;
        const name = (e as { name?: string })?.name;
        setLiveFailed(true);
        setError(
          name === 'NotAllowedError'
            ? 'Camera permission was denied. Allow it for this site, or take a photo of the code instead.'
            : name === 'NotFoundError'
              ? 'No camera found on this device — take a photo of the code instead.'
              : `Couldn't start the camera (${e instanceof Error ? e.message : String(e)}). Take a photo of the code instead.`,
        );
      }
    })();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [live, onResult]);

  // ---- photo mode: open the OS camera immediately -------------------------
  useEffect(() => {
    if (!live) fileRef.current?.click();
  }, [live]);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      const text = await decodeImageFile(f);
      if (text) {
        done.current = true;
        onResult(text);
      } else {
        setError('No QR code found in that photo. Try again closer, with the whole code in frame and in focus.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black text-white flex flex-col" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-crust/90 text-text border-b border-gilt-a">
        <span className="g-stitle truncate">{live && !liveFailed ? 'Point the camera at the code' : 'Scan a code'}</span>
        <button onClick={onClose} className="g-btn g-btn-sm g-btn-gilt shrink-0 !min-h-[44px] sm:!min-h-[32px]">
          Cancel
        </button>
      </div>

      {live && !liveFailed ? (
        <div className="relative flex-1 min-h-0 overflow-hidden">
          <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" playsInline muted autoPlay />
          {/* framing guide */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="g-corners w-64 h-64 border border-gold/80 rounded outline outline-1 outline-gilt-b -outline-offset-[6px] shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" />
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center p-6">
        <div className="g-card g-corners text-text flex flex-col items-center gap-4 px-8 py-8 max-w-sm text-center">
          <div className="text-5xl">📷</div>
          <p className="text-sm text-subtext-1">
            {live
              ? 'Take a photo of the QR code and it will be read from the picture.'
              : 'Live camera needs a secure (https) connection, which this host isn’t using — so take a photo of the QR code instead. It’s read from the picture.'}
          </p>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="g-btn g-btn-pri !min-h-[44px]"
          >
            {busy ? 'Reading…' : 'Take a photo of the code'}
          </button>
        </div>
        </div>
      )}

      {error && <p className="px-4 py-3 text-sm text-warning bg-crust/90 border-t border-gilt-a">{error}</p>}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
    </div>
  );
}
