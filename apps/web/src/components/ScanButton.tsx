/**
 * Scan a barcode with the device's camera: phones, tablets, laptops with a
 * webcam. It reads the number printed under the bars and hands it back, as if
 * it had been typed.
 *
 * A USB or Bluetooth barcode scanner needs none of this: it behaves like a
 * keyboard, typing the number into whichever box has the cursor and pressing
 * Enter. The camera is for devices without one.
 *
 * Uses the browser's own barcode reader where there is one (Chrome on Android),
 * and otherwise a bundled reader (iPhone, Windows, Firefox), loaded only when
 * the camera is first opened.
 */

import { useEffect, useRef, useState } from 'react';

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar', 'qr_code'];

interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}

let detectorPromise: Promise<Detector> | null = null;

async function makeDetector(): Promise<Detector> {
  const Native = (globalThis as { BarcodeDetector?: { new (o: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector;
  if (Native !== undefined) {
    try {
      const supported = await Native.getSupportedFormats();
      const formats = FORMATS.filter((f) => supported.includes(f));
      if (formats.includes('ean_13')) return new Native({ formats });
    } catch {
      // fall through to the bundled reader
    }
  }
  const [{ BarcodeDetector, prepareZXingModule }, { default: wasmUrl }] = await Promise.all([
    import('barcode-detector/ponyfill'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ]);
  // Served from this site, not a third-party CDN.
  prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) } });
  return new BarcodeDetector({ formats: FORMATS as never[] }) as unknown as Detector;
}

function cameraError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'The camera was not allowed. Allow the camera for this site in the browser’s settings, then try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device. Type the barcode, or use a barcode scanner.';
  if (name === 'NotReadableError') return 'The camera is busy in another app. Close it there and try again.';
  return 'The camera could not be started. Type the barcode instead.';
}

export function ScanButton({ onCode, label = 'Scan with camera' }: { onCode: (code: string) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const supported = typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia !== undefined;
  if (!supported) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={label}
        aria-label={label}
        data-testid="scan-camera"
        className="ring-ink-200 text-ink-600 hover:bg-ink-50 inline-flex shrink-0 items-center justify-center rounded-lg bg-white px-2 py-1.5 ring-1 ring-inset"
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
          <path d="M7 8v8M10 8v8M13 8v8M16 8v8" />
        </svg>
      </button>
      {open && (
        <CameraDialog
          onClose={() => setOpen(false)}
          onCode={(c) => {
            setOpen(false);
            onCode(c);
          }}
        />
      )}
    </>
  );
}

function CameraDialog({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    const stop = () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
        if (stopped || video.current === null) return stop();
        video.current.srcObject = stream;
        await video.current.play();
        detectorPromise ??= makeDetector();
        const detector = await detectorPromise;
        setStarting(false);
        const tick = async () => {
          if (stopped || video.current === null) return;
          try {
            if (video.current.readyState >= 2) {
              const found = await detector.detect(video.current);
              const code = found.find((f) => f.rawValue.trim() !== '')?.rawValue.trim();
              if (code !== undefined && !stopped) {
                navigator.vibrate?.(60);
                stop();
                onCode(code);
                return;
              }
            }
          } catch {
            // a frame that could not be read; try the next
          }
          timer = window.setTimeout(() => void tick(), 120);
        };
        void tick();
      } catch (e) {
        detectorPromise = null;
        setStarting(false);
        setError(cameraError(e));
      }
    })();
    return stop;
  }, [onCode]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Scan a barcode" onClick={onClose}>
      <div className="w-full max-w-md overflow-hidden rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="border-ink-100 flex items-center justify-between border-b px-4 py-2.5">
          <div className="text-[13px] font-semibold">Scan a barcode</div>
          <button type="button" onClick={onClose} className="text-ink-500 hover:text-ink-900 text-[12.5px]">
            Close
          </button>
        </div>
        {error === null ? (
          <div className="relative bg-black">
            <video ref={video} playsInline muted className="aspect-[4/3] w-full object-cover" />
            <div className="pointer-events-none absolute inset-x-8 top-1/2 h-24 -translate-y-1/2 rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]" />
            <div className="absolute inset-x-0 bottom-2 text-center text-[12px] text-white/90">
              {starting ? 'Starting the camera…' : 'Hold the barcode inside the box'}
            </div>
          </div>
        ) : (
          <p className="px-4 py-6 text-[12.5px] text-red-700">{error}</p>
        )}
      </div>
    </div>
  );
}
