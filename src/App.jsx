import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */
const SEG_LEN = 30; // seconds
const BG_W = 54; // tiny canvas used for cheap, universal blur (Safari has no ctx.filter)
const BG_H = 96;
const WA_MAX_BYTES = 16 * 1024 * 1024;

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.64002A,mp4a.40.2',
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=h264,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

const MODES = [
  { id: 'original', label: 'Original' },
  { id: 'blur', label: 'Blur BG' },
  { id: 'letterbox', label: 'Letterbox' },
  { id: 'fill', label: 'Fill' },
];

const RESOLUTIONS = [720, 1080];
const FPS_OPTIONS = [30, 60];
const BITRATES = [3.2, 5, 8];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
let bgCanvas = null;

function pickMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  for (const m of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* try next */
    }
  }
  return '';
}

function even(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

/* Output canvas size.
   original -> keep the source's own shape, scale DOWN only (never upscale)
   others   -> 9:16 canvas at the chosen resolution */
function outputDims(info, mode, res) {
  const longSide = even((res * 16) / 9);
  if (mode === 'original') {
    const portrait = info.h >= info.w;
    const boxW = portrait ? res : longSide;
    const boxH = portrait ? longSide : res;
    const s = Math.min(boxW / info.w, boxH / info.h, 1);
    return { w: even(info.w * s), h: even(info.h * s) };
  }
  return { w: res, h: longSide };
}

function fmtTime(s) {
  if (!isFinite(s)) return '--:--';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtDur(s) {
  if (!isFinite(s)) return '--';
  if (s >= 60) return `${Math.floor(s / 60)}m ${(s % 60).toFixed(0)}s`;
  return `${s.toFixed(1)}s`;
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function ratioLabel(w, h) {
  const r = w / h;
  const table = [
    [9 / 16, '9:16'],
    [16 / 9, '16:9'],
    [1, '1:1'],
    [4 / 5, '4:5'],
    [5 / 4, '5:4'],
    [3 / 4, '3:4'],
    [4 / 3, '4:3'],
  ];
  for (const [v, l] of table) if (Math.abs(r - v) < 0.02) return l;
  return `${r.toFixed(2)}:1`;
}

function diagnose(info) {
  const warnings = [];
  if (info.duration > SEG_LEN + 0.05) warnings.push(`${fmtDur(info.duration)} > 30s limit`);
  const longSide = Math.max(info.w, info.h);
  const shortSide = Math.min(info.w, info.h);
  if (longSide > 1280 || shortSide > 720) warnings.push('Above 720×1280');
  if (Math.abs(info.w / info.h - 9 / 16) > 0.02) warnings.push('Not 9:16');
  if (info.size > WA_MAX_BYTES) warnings.push('File > 16 MB');
  return warnings;
}

function buildSegments(duration, split) {
  if (!split || duration <= SEG_LEN + 0.05) return [{ start: 0, end: duration }];
  const segs = [];
  for (let s = 0; s < duration - 0.001; s += SEG_LEN) {
    segs.push({ start: s, end: Math.min(s + SEG_LEN, duration) });
  }
  // Drop imperceptible tails
  if (segs.length > 1) {
    const last = segs[segs.length - 1];
    if (last.end - last.start < 0.4) segs.pop();
  }
  return segs;
}

function seekTo(video, t) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 0.001 && video.readyState >= 2) {
      resolve();
      return;
    }
    let timer;
    const done = () => {
      video.removeEventListener('seeked', done);
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(done, 1500);
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

function paintFrame(canvas, video, mode) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const contain = Math.min(W / vw, H / vh);
  const cover = Math.max(W / vw, H / vh);

  if (mode === 'original') {
    ctx.drawImage(video, 0, 0, W, H);
    return;
  }

  if (mode === 'fill') {
    const dw = vw * cover;
    const dh = vh * cover;
    ctx.drawImage(video, Math.round((W - dw) / 2), Math.round((H - dh) / 2), Math.ceil(dw), Math.ceil(dh));
    return;
  }

  if (mode === 'blur') {
    if (!bgCanvas) {
      bgCanvas = document.createElement('canvas');
      bgCanvas.width = BG_W;
      bgCanvas.height = BG_H;
    }
    const bctx = bgCanvas.getContext('2d');
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = 'high';
    const cs = Math.max(BG_W / vw, BG_H / vh);
    bctx.drawImage(video, (BG_W - vw * cs) / 2, (BG_H - vh * cs) / 2, vw * cs, vh * cs);
    ctx.drawImage(bgCanvas, 0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  const dw = vw * contain;
  const dh = vh * contain;
  ctx.drawImage(video, Math.round((W - dw) / 2), Math.round((H - dh) / 2), Math.ceil(dw), Math.ceil(dh));
}

function canShareFile(file) {
  try {
    return (
      typeof navigator !== 'undefined' &&
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [file] })
    );
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Icons                                                              */
/* ------------------------------------------------------------------ */
const Svg = ({ children, size = 20, ...rest }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...rest}
  >
    {children}
  </svg>
);

const IconDownload = (p) => (
  <Svg {...p}>
    <path d="M12 3v12" />
    <path d="m7 11 5 5 5-5" />
    <path d="M5 21h14" />
  </Svg>
);

const IconWhatsApp = (p) => (
  <Svg {...p}>
    <path d="M3 21l1.6-4.6A8.5 8.5 0 1 1 8 19.6L3 21z" />
    <path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1.2-1.4-1.9-1-0.9 0.6c-0.8-0.4-1.5-1.1-1.9-1.9l0.6-0.9-1-1.9L9 9.5z" />
  </Svg>
);

const IconSwap = (p) => (
  <Svg {...p}>
    <path d="M4 7h13l-3-3" />
    <path d="M20 17H7l3 3" />
  </Svg>
);

const IconX = (p) => (
  <Svg {...p}>
    <path d="M6 6l12 12" />
    <path d="M18 6 6 18" />
  </Svg>
);

const IconPlay = (p) => (
  <Svg {...p} fill="currentColor" stroke="none">
    <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />
  </Svg>
);

/* ------------------------------------------------------------------ */
/*  Small UI pieces                                                    */
/* ------------------------------------------------------------------ */
function Pill({ active, disabled, onClick, children }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={[
        'pill h-10 shrink-0 rounded-full px-4 text-[13px] font-semibold tracking-tight transition-colors duration-150',
        active ? 'bg-emerald-500 text-black' : 'border border-zinc-800 bg-zinc-950 text-zinc-300',
        disabled ? 'opacity-40' : '',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function Label({ children }) {
  return (
    <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
      {children}
    </div>
  );
}

function Stat({ k, v }) {
  return (
    <div className="flex items-baseline justify-between border-b border-zinc-900 py-2 last:border-b-0">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">{k}</span>
      <span className="font-mono text-[13px] font-semibold text-zinc-100">{v}</span>
    </div>
  );
}

function SegmentCard({ seg, index }) {
  const vref = useRef(null);
  const shareable = useMemo(() => canShareFile(seg.file), [seg.file]);
  const [playing, setPlaying] = useState(false);
  const [shareErr, setShareErr] = useState('');

  const toggle = () => {
    const v = vref.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  const share = async () => {
    setShareErr('');
    try {
      await navigator.share({ files: [seg.file] });
    } catch (e) {
      if (e && e.name !== 'AbortError') setShareErr('Share failed — use Save');
    }
  };

  return (
    <div className="card-in flex gap-3 rounded-3xl border border-zinc-900 bg-zinc-950 p-3">
      <button
        type="button"
        onClick={toggle}
        className="relative aspect-[9/16] w-[72px] shrink-0 overflow-hidden rounded-2xl bg-black"
        aria-label={`Preview part ${index + 1}`}
      >
        <video
          ref={vref}
          src={seg.url}
          playsInline
          loop
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          className="h-full w-full object-contain"
        />
        {!playing && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/30 text-white">
            <IconPlay size={22} />
          </span>
        )}
      </button>

      <div className="flex min-w-0 flex-1 flex-col justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-emerald-400">
              Part {index + 1}
            </span>
            <span className="rounded-full border border-zinc-800 px-2 py-[1px] font-mono text-[9px] font-semibold uppercase tracking-wider text-zinc-400">
              {seg.ext}
            </span>
          </div>
          <div className="mt-1 font-mono text-[12px] text-zinc-400">
            {fmtTime(seg.start)}–{fmtTime(seg.end)} · {fmtSize(seg.size)}
          </div>
          {shareErr && <div className="mt-1 text-[11px] text-amber-400">{shareErr}</div>}
        </div>

        <div className="mt-3 flex items-center gap-2">
          {shareable ? (
            <>
              <button
                type="button"
                onClick={share}
                className="pill flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-emerald-500 text-[13px] font-bold text-black"
              >
                <IconWhatsApp size={18} />
                Share to WhatsApp
              </button>
              <a
                href={seg.url}
                download={seg.file.name}
                aria-label="Save to device"
                className="pill flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 text-zinc-200"
              >
                <IconDownload size={18} />
              </a>
            </>
          ) : (
            <a
              href={seg.url}
              download={seg.file.name}
              className="pill flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-emerald-500 text-[13px] font-bold text-black"
            >
              <IconDownload size={18} />
              Save video
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */
export default function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const inputRef = useRef(null);
  const audioRef = useRef(null);
  const cancelRef = useRef(false);
  const busyRef = useRef(false);
  const lastPctRef = useRef(-1);
  const resultsRef = useRef([]);
  const sourceRef = useRef(null);

  const [source, setSource] = useState(null); // { url, file }
  const [info, setInfo] = useState(null); // { w, h, duration, size, name }
  const [mode, setMode] = useState('original');
  const [split, setSplit] = useState(true);
  const [res, setRes] = useState(720);
  const [fps, setFps] = useState(30);
  const [bitrate, setBitrate] = useState(5);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null); // { pct, seg, total }
  const [results, setResults] = useState([]);
  const [error, setError] = useState('');
  const [confirmExit, setConfirmExit] = useState(false);

  const warnings = useMemo(() => (info ? diagnose(info) : []), [info]);
  const segments = useMemo(() => (info ? buildSegments(info.duration, split) : []), [info, split]);
  const dims = useMemo(() => (info ? outputDims(info, mode, res) : { w: 720, h: 1280 }), [info, mode, res]);

  useEffect(() => {
    resultsRef.current = results;
  }, [results]);
  useEffect(() => {
    sourceRef.current = source;
  }, [source]);

  useEffect(
    () => () => {
      resultsRef.current.forEach((r) => URL.revokeObjectURL(r.url));
      if (sourceRef.current) URL.revokeObjectURL(sourceRef.current.url);
    },
    []
  );

  /* Close the exit sheet with Escape */
  useEffect(() => {
    if (!confirmExit) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setConfirmExit(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmExit]);

  /* Live preview frame (before / after processing, and when settings change) */
  useEffect(() => {
    if (!info || busy) return undefined;
    let alive = true;
    (async () => {
      const v = videoRef.current;
      const c = canvasRef.current;
      if (!v || !c) return;
      if (v.readyState < 2) {
        await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
      }
      if (!alive || busyRef.current) return;
      await seekTo(v, Math.min(0.1, (v.duration || 0) / 2));
      if (alive && !busyRef.current) paintFrame(c, v, mode);
    })();
    return () => {
      alive = false;
    };
  }, [info, mode, dims, busy]);

  const clearResults = () => {
    resultsRef.current.forEach((r) => URL.revokeObjectURL(r.url));
    resultsRef.current = [];
    setResults([]);
  };

  const openPicker = () => {
    if (!busy) inputRef.current?.click();
  };

  const onPick = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    clearResults();
    setInfo(null);
    if (sourceRef.current) URL.revokeObjectURL(sourceRef.current.url);
    setSource({ url: URL.createObjectURL(file), file });
  };

  const onMeta = () => {
    const v = videoRef.current;
    if (!v || !sourceRef.current) return;
    if (!isFinite(v.duration) || !v.videoWidth) {
      setError('Unreadable video file.');
      return;
    }
    setInfo({
      w: v.videoWidth,
      h: v.videoHeight,
      duration: v.duration,
      size: sourceRef.current.file.size,
      name: sourceRef.current.file.name,
    });
  };

  const onVideoError = () => {
    if (sourceRef.current) setError('This browser cannot decode that video.');
  };

  /* Exit editor -> back to the Select video screen */
  const exitEditor = () => {
    cancelRef.current = true; // stops any running capture loop
    const v = videoRef.current;
    if (v) {
      try {
        v.pause();
      } catch {
        /* ignore */
      }
    }
    clearResults();
    if (sourceRef.current) URL.revokeObjectURL(sourceRef.current.url);
    sourceRef.current = null;
    setSource(null);
    setInfo(null);
    setError('');
    setProgress(null);
    setConfirmExit(false);
  };

  const ensureAudio = async (video) => {
    if (audioRef.current) {
      try {
        await audioRef.current.ctx.resume();
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const src = ctx.createMediaElementSource(video);
      const dest = ctx.createMediaStreamDestination();
      src.connect(dest); // intentionally NOT connected to speakers
      audioRef.current = { ctx, dest };
      await ctx.resume();
    } catch {
      audioRef.current = null;
    }
  };

  const recordSegment = async (start, end, renderMode, mbps, targetFps, mime, onProgress) => {
    const video = videoRef.current;
    const canvas = canvasRef.current;

    await seekTo(video, start);
    paintFrame(canvas, video, renderMode);

    const canvasStream = canvas.captureStream(targetFps);
    const tracks = [...canvasStream.getVideoTracks()];
    if (audioRef.current) tracks.push(...audioRef.current.dest.stream.getAudioTracks());
    const stream = new MediaStream(tracks);

    const opts = {
      videoBitsPerSecond: Math.round(mbps * 1_000_000),
      audioBitsPerSecond: 128_000,
    };
    if (mime) opts.mimeType = mime;

    const recorder = new MediaRecorder(stream, opts);
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = (e) => reject((e && e.error) || new Error('Recorder error'));
    });

    recorder.start(500);
    await video.play();

    // Draw exactly when the decoder presents a frame (no timer drift / duplicate frames)
    const useRVFC = typeof video.requestVideoFrameCallback === 'function';
    const minGap = 1 / targetFps - 0.004;

    await new Promise((resolve) => {
      let handle = 0;
      let lastMedia = -1;
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        if (useRVFC) video.cancelVideoFrameCallback(handle);
        else cancelAnimationFrame(handle);
        video.removeEventListener('ended', finish);
        resolve();
      };
      video.addEventListener('ended', finish);

      const step = (t) => {
        if (cancelRef.current) {
          finish();
          return;
        }
        if (lastMedia < 0 || t - lastMedia >= minGap) {
          lastMedia = t;
          paintFrame(canvas, video, renderMode);
        }
        onProgress(Math.min(1, Math.max(0, (t - start) / Math.max(0.001, end - start))));
        if (t >= end - 0.03 || video.ended) {
          finish();
          return;
        }
        schedule();
      };

      const schedule = () => {
        handle = useRVFC
          ? video.requestVideoFrameCallback((_now, meta) => step(meta.mediaTime))
          : requestAnimationFrame(() => step(video.currentTime));
      };

      schedule();
    });

    video.pause();
    paintFrame(canvas, video, renderMode);
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    canvasStream.getTracks().forEach((t) => t.stop());

    if (cancelRef.current) throw new Error('CANCELLED');

    const type = (recorder.mimeType || mime || 'video/webm').split(';')[0] || 'video/webm';
    return new Blob(chunks, { type });
  };

  const handleProcess = async () => {
    if (!info || busyRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (typeof MediaRecorder === 'undefined' || !canvas || typeof canvas.captureStream !== 'function') {
      setError('MediaRecorder / canvas capture is not supported in this browser.');
      return;
    }

    setError('');
    clearResults();
    cancelRef.current = false;
    busyRef.current = true;
    lastPctRef.current = -1;
    setBusy(true);

    const segs = buildSegments(video.duration || info.duration, split);
    const total = segs.length;
    setProgress({ pct: 0, seg: 1, total });

    // Unlock audio + playback inside the user gesture
    video.muted = false;
    video.volume = 1;
    video.playbackRate = 1;
    const audioReady = ensureAudio(video);
    const unlock = video.play().catch(() => {});
    await Promise.all([audioReady, unlock]);
    video.pause();

    let wake = null;
    try {
      wake = (await navigator.wakeLock?.request('screen')) || null;
    } catch {
      wake = null;
    }

    const mime = pickMime();
    const base =
      (info.name || 'clip').replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40) || 'clip';
    const out = [];

    try {
      for (let i = 0; i < total; i += 1) {
        const { start, end } = segs[i];
        const blob = await recordSegment(start, end, mode, bitrate, fps, mime, (local) => {
          const pct = ((i + local) / total) * 100;
          if (Math.abs(pct - lastPctRef.current) >= 0.4) {
            lastPctRef.current = pct;
            setProgress({ pct, seg: i + 1, total });
          }
        });

        const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
        const file = new File([blob], `clipfix_${base}_part${i + 1}.${ext}`, { type: blob.type });
        out.push({
          id: `${Date.now()}_${i}`,
          start,
          end,
          size: blob.size,
          ext,
          file,
          url: URL.createObjectURL(blob),
        });
        resultsRef.current = [...out];
        setResults([...out]);
      }
      setProgress({ pct: 100, seg: total, total });
    } catch (e) {
      if (!e || e.message !== 'CANCELLED') {
        setError(`Processing failed: ${(e && e.message) || 'unknown error'}`);
      }
    } finally {
      try {
        video.pause();
      } catch {
        /* ignore */
      }
      if (wake) wake.release().catch(() => {});
      busyRef.current = false;
      setBusy(false);
      setProgress(null);
    }
  };

  const handleCancel = () => {
    cancelRef.current = true;
  };

  const inEditor = Boolean(source);
  const specLine = `${dims.w}×${dims.h} · ${fps} FPS · ${bitrate} Mbps`;

  return (
    <div className="min-h-[100dvh] bg-black text-zinc-100">
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col px-4 pt-[max(env(safe-area-inset-top),1rem)]">
        {/* Header */}
        <header className="flex h-12 items-center justify-between">
          {inEditor ? (
            <button
              type="button"
              onClick={() => setConfirmExit(true)}
              aria-label="Exit editor"
              className="pill -ml-2 flex h-10 items-center gap-2 rounded-full px-2"
            >
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
              <span className="text-[15px] font-bold tracking-tight">ClipFix</span>
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
              <span className="text-[15px] font-bold tracking-tight">ClipFix</span>
            </div>
          )}
          {info && (
            <button
              type="button"
              onClick={openPicker}
              disabled={busy}
              className="pill flex h-9 items-center gap-2 rounded-full border border-zinc-800 bg-zinc-950 px-3.5 text-[12px] font-semibold text-zinc-300 disabled:opacity-40"
            >
              <IconSwap size={15} />
              Change
            </button>
          )}
        </header>

        {error && (
          <div className="card-in mt-2 flex items-start justify-between gap-3 rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-[13px] text-red-300">
            <span>{error}</span>
            <button type="button" onClick={() => setError('')} aria-label="Dismiss" className="mt-0.5 text-red-300">
              <IconX size={16} />
            </button>
          </div>
        )}

        {/* Empty state: shutter-style picker */}
        {!info && !source && (
          <div className="flex flex-1 flex-col items-center justify-center pb-24">
            <button
              type="button"
              onClick={openPicker}
              aria-label="Select video"
              className="shutter relative flex h-28 w-28 items-center justify-center rounded-full border-[3px] border-emerald-500"
            >
              <span className="shutter-core h-[88px] w-[88px] rounded-full bg-emerald-500" />
            </button>
            <div className="mt-6 font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-zinc-500">
              Select video
            </div>
          </div>
        )}

        {/* Loading state */}
        {!info && source && !error && (
          <div className="flex flex-1 items-center justify-center pb-24">
            <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-zinc-500">
              Reading file…
            </div>
          </div>
        )}

        {/* Loaded state */}
        {info && (
          <main className="flex flex-1 flex-col gap-5 pb-4 pt-2">
            {/* Preview + diagnostics */}
            <section className="flex gap-4">
              <div className="relative flex aspect-[9/16] w-[38%] shrink-0 items-center justify-center overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950">
                <canvas
                  ref={canvasRef}
                  width={dims.w}
                  height={dims.h}
                  className="max-h-full max-w-full object-contain"
                  style={{ aspectRatio: `${dims.w} / ${dims.h}` }}
                />
                {busy && (
                  <>
                    <div className="scanline pointer-events-none absolute inset-x-0 top-0 h-16" />
                    <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5 rounded-full bg-black/70 px-2 py-1">
                      <span className="rec-dot h-1.5 w-1.5 rounded-full bg-red-500" />
                      <span className="font-mono text-[9px] font-bold tracking-widest text-white">REC</span>
                    </div>
                  </>
                )}
              </div>

              <div className="flex min-w-0 flex-1 flex-col justify-between">
                <div>
                  <Label>Diagnostics</Label>
                  <div className="rounded-2xl border border-zinc-900 bg-zinc-950 px-3.5">
                    <Stat k="Res" v={`${info.w}×${info.h}`} />
                    <Stat k="Dur" v={fmtDur(info.duration)} />
                    <Stat k="Ratio" v={ratioLabel(info.w, info.h)} />
                    <Stat k="Size" v={fmtSize(info.size)} />
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {warnings.length === 0 ? (
                    <span className="rounded-full border border-emerald-900 bg-emerald-950/50 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                      Within limits
                    </span>
                  ) : (
                    warnings.map((w) => (
                      <span
                        key={w}
                        className="rounded-full border border-amber-900/70 bg-amber-950/40 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-amber-400"
                      >
                        {w}
                      </span>
                    ))
                  )}
                </div>
              </div>
            </section>

            {/* Controls */}
            <section className="flex flex-col gap-4">
              <div>
                <Label>Frame</Label>
                <div className="flex gap-2 overflow-x-auto">
                  {MODES.map((m) => (
                    <Pill key={m.id} active={mode === m.id} disabled={busy} onClick={() => setMode(m.id)}>
                      {m.label}
                    </Pill>
                  ))}
                </div>
              </div>

              <div>
                <Label>Resolution</Label>
                <div className="flex gap-2">
                  {RESOLUTIONS.map((r) => (
                    <Pill key={r} active={res === r} disabled={busy} onClick={() => setRes(r)}>
                      {r}p
                    </Pill>
                  ))}
                </div>
              </div>

              <div>
                <Label>Frame rate</Label>
                <div className="flex gap-2">
                  {FPS_OPTIONS.map((f) => (
                    <Pill key={f} active={fps === f} disabled={busy} onClick={() => setFps(f)}>
                      {f} FPS
                    </Pill>
                  ))}
                </div>
              </div>

              <div>
                <Label>Bitrate</Label>
                <div className="flex gap-2">
                  {BITRATES.map((b) => (
                    <Pill key={b} active={bitrate === b} disabled={busy} onClick={() => setBitrate(b)}>
                      {b} Mbps
                    </Pill>
                  ))}
                </div>
              </div>

              <div>
                <Label>Split</Label>
                <div className="flex gap-2">
                  <Pill active={split} disabled={busy} onClick={() => setSplit(true)}>
                    30s segments
                  </Pill>
                  <Pill active={!split} disabled={busy} onClick={() => setSplit(false)}>
                    Single clip
                  </Pill>
                </div>
              </div>

              <div className="font-mono text-[11px] tracking-wide text-zinc-600">
                <div>{specLine}</div>
                {fps === 60 && <div className="mt-1">60 FPS only helps if the source is 60 FPS.</div>}
              </div>
            </section>

            {/* Results */}
            {results.length > 0 && (
              <section className="flex flex-col gap-3">
                <Label>Output · {results.length}</Label>
                {results.map((seg, i) => (
                  <SegmentCard key={seg.id} seg={seg} index={i} />
                ))}
              </section>
            )}
          </main>
        )}

        {/* Sticky action bar */}
        {info && (
          <div className="sticky bottom-0 -mx-4 bg-gradient-to-t from-black via-black to-transparent px-4 pb-[max(env(safe-area-inset-bottom),1rem)] pt-4">
            {busy && progress ? (
              <div className="rounded-3xl border border-zinc-800 bg-zinc-950 p-3.5">
                <div className="mb-2.5 flex items-center justify-between font-mono text-[11px] font-semibold uppercase tracking-[0.16em]">
                  <span className="text-zinc-400">
                    Clip {progress.seg}/{progress.total}
                  </span>
                  <span className="text-emerald-400">{Math.floor(progress.pct)}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-900">
                  <div
                    className="progress-fill h-full rounded-full bg-emerald-500"
                    style={{ width: `${progress.pct}%` }}
                  />
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-600">
                    Real-time · keep app open
                  </span>
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="pill flex h-9 items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-4 text-[12px] font-semibold text-zinc-200"
                  >
                    <IconX size={14} />
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleProcess}
                className="pill flex h-14 w-full items-center justify-center rounded-full bg-emerald-500 text-[15px] font-bold tracking-tight text-black"
              >
                {results.length > 0 ? 'Process again' : 'Process'} · {segments.length}{' '}
                {segments.length === 1 ? 'clip' : 'clips'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Exit confirmation */}
      {confirmExit && (
        <div
          className="fade-in fixed inset-0 z-50 flex items-end justify-center bg-black/70 px-4 pb-[max(env(safe-area-inset-bottom),1rem)]"
          role="dialog"
          aria-modal="true"
          aria-label="Exit editor"
          onClick={() => setConfirmExit(false)}
        >
          <div
            className="sheet-in w-full max-w-md rounded-3xl border border-zinc-800 bg-zinc-950 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[17px] font-bold tracking-tight">Exit editor?</div>
            <p className="mt-1 text-[13px] leading-relaxed text-zinc-400">
              {busy ? 'Processing will stop. ' : ''}
              {results.length > 0 ? 'Generated clips will be discarded.' : 'Your selection will be cleared.'}
            </p>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmExit(false)}
                className="pill h-12 flex-1 rounded-full border border-zinc-800 bg-zinc-900 text-[14px] font-semibold text-zinc-200"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={exitEditor}
                className="pill h-12 flex-1 rounded-full bg-red-500 text-[14px] font-bold text-white"
              >
                Exit
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden decode element (kept in DOM for iOS) */}
      <video
        ref={videoRef}
        src={source ? source.url : undefined}
        className="clipfix-probe"
        playsInline
        preload="auto"
        onLoadedMetadata={onMeta}
        onError={onVideoError}
      />

      <input ref={inputRef} type="file" accept="video/*" className="hidden" onChange={onPick} />
    </div>
  );
}