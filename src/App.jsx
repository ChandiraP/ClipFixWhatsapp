import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './App.css';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */
const BG_W = 54; // tiny canvas used for cheap, universal blur (Safari has no ctx.filter)
const BG_H = 96;
const WA_MAX_BYTES = 16 * 1024 * 1024;
const MAX_STATUS_SECONDS = 60;
const SCALE_FLOOR = 0.85; // smallest UI scale the auto-fit will use

/* original -> export the video as it is (any shape, no crop / padding / blur)
   blur     -> convert any video to 9:16 with a blurred background; true 9:16 stays as it is */
const MODES = [
  { id: 'original', label: 'Original' },
  { id: 'blur', label: 'Blur BG' },
];

const SPLITS = [
  { id: 0, label: 'Single' },
  { id: 60, label: '1 min' },
  { id: 30, label: '30s' },
];

const RESOLUTIONS = [
  { id: 720, label: '720p' },
  { id: 1080, label: '1080p' },
];

const FPS_OPTIONS = [
  { id: 30, label: '30 FPS' },
  { id: 60, label: '60 FPS' },
];

const BITRATES = [
  { id: 3.2, label: '3.2' },
  { id: 5, label: '5' },
  { id: 8, label: '8' },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
let bgCanvas = null;

function readViewport() {
  if (typeof window === 'undefined') return { w: 390, h: 800 };
  const vv = window.visualViewport;
  return {
    w: Math.round((vv && vv.width) || window.innerWidth),
    h: Math.round((vv && vv.height) || window.innerHeight),
  };
}

function isNineSixteen(info) {
  return Math.abs(info.w / info.h - 9 / 16) <= 0.02;
}

/* H.264 High profile. Level 4.1 for 720p30, level 4.2 for 1080p / 60 FPS. */
function pickMime(fps, res) {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const level = res >= 1080 || fps >= 60 ? '64002A' : '640029';
  const candidates = [
    `video/mp4;codecs=avc1.${level},mp4a.40.2`,
    'video/mp4;codecs=avc1.640029,mp4a.40.2',
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const m of candidates) {
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
   blur     -> 9:16 canvas at the chosen resolution */
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

function orientationLabel(w, h) {
  const r = w / h;
  if (Math.abs(r - 1) < 0.03) return 'Square';
  return h > w ? 'Vertical' : 'Landscape';
}

function fmtTime(s) {
  if (!isFinite(s) || s < 0) return '0:00';
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
  if (info.duration > MAX_STATUS_SECONDS + 0.05) warnings.push(`${fmtDur(info.duration)} · over 1 min`);
  const longSide = Math.max(info.w, info.h);
  const shortSide = Math.min(info.w, info.h);
  if (longSide > 1280 || shortSide > 720) warnings.push('Above 720×1280');
  if (info.size > WA_MAX_BYTES) warnings.push('File over 16 MB');
  return warnings;
}

function buildSegments(duration, segLen) {
  if (!segLen || duration <= segLen + 0.05) return [{ start: 0, end: duration }];
  const segs = [];
  for (let s = 0; s < duration - 0.001; s += segLen) {
    segs.push({ start: s, end: Math.min(s + segLen, duration) });
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

  /* As is: the canvas already has the video's own shape, so the video fills it exactly */
  if (mode === 'original') {
    ctx.drawImage(video, 0, 0, W, H);
    return;
  }

  /* Blur BG: whole video fitted inside the frame, gap filled with a blurred copy */
  const contain = Math.min(W / vw, H / vh);
  const dw = vw * contain;
  const dh = vh * contain;
  const x = Math.round((W - dw) / 2);
  const y = Math.round((H - dh) / 2);

  // Nothing to fill: the video already covers the whole frame
  if (dw >= W - 1 && dh >= H - 1) {
    ctx.drawImage(video, 0, 0, W, H);
    return;
  }

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

  // Stretching the tiny copy back up is what produces the blur
  ctx.drawImage(bgCanvas, 0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.fillRect(0, 0, W, H);

  ctx.drawImage(video, x, y, Math.ceil(dw), Math.ceil(dh));
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

const IconUpload = (p) => (
  <Svg {...p}>
    <path d="M12 16V4" />
    <path d="m7 9 5-5 5 5" />
    <path d="M5 20h14" />
  </Svg>
);

/* ------------------------------------------------------------------ */
/*  Small UI pieces (all sizes in rem so the auto-fit scale applies)   */
/* ------------------------------------------------------------------ */

/* Compact pill-shaped segmented toggle */
function Seg({ options, value, onChange, disabled, compact }) {
  return (
    <div
      role="radiogroup"
      className={[
        'flex min-w-0 flex-1 gap-0.5 rounded-full border border-zinc-700 bg-zinc-950 p-0.5',
        disabled ? 'opacity-40' : '',
      ].join(' ')}
    >
      {options.map((o) => {
        const active = value === o.id;
        return (
          <button
            key={String(o.id)}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(o.id)}
            className={[
              'pill min-w-0 flex-1 truncate rounded-full px-1 text-[0.9375rem] font-semibold tracking-tight transition-colors duration-150',
              compact ? 'h-8' : 'h-10',
              active ? 'bg-emerald-500 text-black' : 'text-zinc-200',
            ].join(' ')}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function SettingRow({ label, children }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-[4.5rem] shrink-0 text-sm font-semibold text-zinc-400">{label}</span>
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-sm font-semibold leading-none text-zinc-400">{label}</span>
      <div className="flex">{children}</div>
    </div>
  );
}

/* Bottom sheet window (Exporting, Output, confirm) */
function Sheet({ title, onClose, dim = false, z = 'z-50', children }) {
  return (
    <div
      className={`fade-in fixed inset-0 ${z} flex items-end justify-center ${dim ? 'bg-black/40' : 'bg-black/70'}`}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="sheet-in flex max-h-[90dvh] w-full max-w-md flex-col rounded-t-3xl border border-b-0 border-zinc-700 bg-zinc-950"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <div className="text-xl font-bold tracking-tight">{title}</div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="pill flex h-10 w-10 items-center justify-center rounded-full bg-zinc-900 text-zinc-200"
            >
              <IconX size={18} />
            </button>
          )}
        </div>
        <div className="overflow-y-auto px-5 pb-[max(env(safe-area-inset-bottom),1.25rem)] pt-3">{children}</div>
      </div>
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
      if (e && e.name !== 'AbortError') setShareErr('Share failed. Use Save instead.');
    }
  };

  return (
    <div className="flex gap-3 rounded-3xl border border-zinc-800 bg-black p-3">
      <button
        type="button"
        onClick={toggle}
        className="relative flex h-[9.33rem] w-[5.25rem] shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-zinc-950"
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
          className="max-h-full max-w-full object-contain"
        />
        {!playing && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/30 text-white">
            <IconPlay size={24} />
          </span>
        )}
      </button>

      <div className="flex min-w-0 flex-1 flex-col justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[0.9375rem] font-bold text-emerald-400">Part {index + 1}</span>
            <span className="rounded-full border border-zinc-700 px-2.5 py-0.5 text-sm font-semibold uppercase text-zinc-300">
              {seg.ext}
            </span>
          </div>
          <div className="mt-1 text-sm tabular-nums text-zinc-300">
            {fmtTime(seg.start)}–{fmtTime(seg.end)} · {fmtSize(seg.size)}
          </div>
          {shareErr && <div className="mt-1 text-sm text-amber-400">{shareErr}</div>}
        </div>

        <div className="mt-3 flex items-center gap-2">
          {shareable ? (
            <>
              <button
                type="button"
                onClick={share}
                className="pill flex h-12 min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-emerald-500 text-[0.9375rem] font-bold text-black"
              >
                <IconWhatsApp size={20} />
                <span className="truncate">Share to WhatsApp</span>
              </button>
              <a
                href={seg.url}
                download={seg.file.name}
                aria-label="Save to device"
                className="pill flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-zinc-100"
              >
                <IconDownload size={20} />
              </a>
            </>
          ) : (
            <a
              href={seg.url}
              download={seg.file.name}
              className="pill flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-emerald-500 text-[0.9375rem] font-bold text-black"
            >
              <IconDownload size={20} />
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
  const stageRef = useRef(null);
  const mainRef = useRef(null);
  const inputRef = useRef(null);
  const audioRef = useRef(null);
  const cancelRef = useRef(false);
  const busyRef = useRef(false);
  const lastPctRef = useRef(-1);
  const lastPosRef = useRef(0);
  const resultsRef = useRef([]);
  const sourceRef = useRef(null);
  const seededRef = useRef(null);
  const fitKeyRef = useRef('');

  const [source, setSource] = useState(null); // { url, file }
  const [info, setInfo] = useState(null); // { w, h, duration, size, name }
  const [mode, setMode] = useState('original');
  const [segLen, setSegLen] = useState(0); // 0 = single clip
  const [res, setRes] = useState(720);
  const [fps, setFps] = useState(30);
  const [bitrate, setBitrate] = useState(3.2);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null); // { pct, seg, total }
  const [results, setResults] = useState([]);
  const [error, setError] = useState('');
  const [confirmExit, setConfirmExit] = useState(false);
  const [panel, setPanel] = useState('none'); // 'none' | 'output'
  const [previewing, setPreviewing] = useState(false);
  const [pos, setPos] = useState(0);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [vp, setVp] = useState(readViewport);

  const landscape = vp.w > vp.h;

  /* Base UI scale from the real screen size; auto-fit may lower it further */
  const baseScale = useMemo(() => {
    const k = landscape ? Math.min(vp.h / 400, vp.w / 800) : Math.min(vp.h / 780, vp.w / 390);
    return Math.min(1.1, Math.max(0.9, Math.round(k * 1000) / 1000));
  }, [vp, landscape]);
  const [uiScale, setUiScale] = useState(baseScale);

  const hasInfo = Boolean(info);
  const warnings = useMemo(() => (info ? diagnose(info) : []), [info]);
  const segments = useMemo(() => (info ? buildSegments(info.duration, segLen) : []), [info, segLen]);
  const mime = useMemo(() => pickMime(fps, res), [fps, res]);

  /* Effective render mode:
     original -> as is
     blur     -> blurred 9:16 frame, except a true 9:16 video which stays as it is */
  const effMode = useMemo(() => {
    if (!info) return 'original';
    if (mode === 'original') return 'original';
    return isNineSixteen(info) ? 'original' : 'blur';
  }, [info, mode]);

  const dims = useMemo(() => (info ? outputDims(info, effMode, res) : { w: 720, h: 1280 }), [info, effMode, res]);

  /* Preview box: fitted into the free space at the exact output shape, kept compact */
  const fit = useMemo(() => {
    if (!stage.w || !stage.h) return { w: 0, h: 0 };
    const a = dims.w / dims.h;
    const baseCap = (landscape ? 560 : 300) * uiScale;
    const maxW = Math.min(stage.w * 0.94, a > 1 ? baseCap * 1.2 : baseCap);
    const maxH = stage.h * 0.97;
    let w = maxW;
    let h = w / a;
    if (h > maxH) {
      h = maxH;
      w = h * a;
    }
    return { w: Math.floor(w), h: Math.floor(h) };
  }, [stage, dims, landscape, uiScale]);

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

  /* Track the visible screen size (browser toolbars, rotation, split-screen) */
  useEffect(() => {
    const on = () => {
      const n = readViewport();
      setVp((p) => (p.w === n.w && p.h === n.h ? p : n));
    };
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', on);
    return () => {
      window.removeEventListener('resize', on);
      window.removeEventListener('orientationchange', on);
      if (window.visualViewport) window.visualViewport.removeEventListener('resize', on);
    };
  }, []);

  /* Apply the UI scale to every rem-based size */
  useLayoutEffect(() => {
    const el = document.documentElement;
    const prev = el.style.fontSize;
    el.style.fontSize = `${(16 * uiScale).toFixed(2)}px`;
    return () => {
      el.style.fontSize = prev;
    };
  }, [uiScale]);

  /* Auto-fit: restart from the base scale when the screen / video changes,
     then shrink step by step until nothing overflows */
  useLayoutEffect(() => {
    const key = `${baseScale}|${landscape}|${info ? `${info.name}${info.w}${info.h}` : ''}`;
    if (fitKeyRef.current !== key) {
      fitKeyRef.current = key;
      if (uiScale !== baseScale) {
        setUiScale(baseScale);
        return;
      }
    }
    if (!info) return;
    const m = mainRef.current;
    if (!m) return;
    const over = m.scrollHeight > m.clientHeight + 1 || m.scrollWidth > m.clientWidth + 1;
    if (over && uiScale > SCALE_FLOOR + 0.001) {
      setUiScale(Math.max(SCALE_FLOOR, Math.round((uiScale - 0.03) * 1000) / 1000));
    }
  }, [
    uiScale,
    baseScale,
    landscape,
    info,
    vp,
    warnings.length,
    fps,
    bitrate,
    res,
    mode,
    segLen,
    results.length,
    error,
  ]);

  /* Measure the preview stage in pixels */
  useEffect(() => {
    if (!hasInfo) return undefined;
    const el = stageRef.current;
    if (!el) return undefined;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setStage({ w: r.width, h: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasInfo]);

  /* Escape closes the top-most window */
  useEffect(() => {
    if (!confirmExit && panel === 'none') return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (confirmExit) setConfirmExit(false);
      else if (!busyRef.current) setPanel('none');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmExit, panel]);

  /* Still frame: first frame on load, repaint when frame mode / size changes */
  useEffect(() => {
    if (!info || busy || previewing) return undefined;
    let alive = true;
    (async () => {
      const v = videoRef.current;
      const c = canvasRef.current;
      if (!v || !c) return;
      if (v.readyState < 2) {
        await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
      }
      if (!alive || busyRef.current) return;
      if (seededRef.current !== info) {
        seededRef.current = info;
        await seekTo(v, Math.min(0.1, (v.duration || 0) / 2));
        if (alive) setPos(v.currentTime);
      }
      if (alive && !busyRef.current) paintFrame(c, v, effMode);
    })();
    return () => {
      alive = false;
    };
  }, [info, effMode, dims, busy, previewing]);

  /* Silent live preview playback, drawn exactly per decoded frame */
  useEffect(() => {
    if (!previewing || !info || busy) return undefined;
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) return undefined;

    let alive = true;
    let handle = 0;
    const useRVFC = typeof v.requestVideoFrameCallback === 'function';

    v.muted = true;
    if (v.ended || v.currentTime >= (v.duration || 0) - 0.05) v.currentTime = 0;

    const onEnd = () => setPreviewing(false);
    v.addEventListener('ended', onEnd);

    const step = () => {
      if (!alive) return;
      paintFrame(c, v, effMode);
      const t = v.currentTime;
      if (Math.abs(t - lastPosRef.current) > 0.1) {
        lastPosRef.current = t;
        setPos(t);
      }
      schedule();
    };
    const schedule = () => {
      handle = useRVFC ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);
    };

    v.play()
      .then(() => {
        if (alive) schedule();
      })
      .catch(() => setPreviewing(false));

    return () => {
      alive = false;
      if (useRVFC) v.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
      v.removeEventListener('ended', onEnd);
      if (!busyRef.current) v.pause();
    };
  }, [previewing, info, busy, effMode, dims]);

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
    setPreviewing(false);
    setPanel('none');
    setPos(0);
    seededRef.current = null;
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

  const togglePreview = () => {
    if (busy) return;
    setPreviewing((p) => !p);
  };

  const onScrub = async (e) => {
    const t = parseFloat(e.target.value);
    const v = videoRef.current;
    const c = canvasRef.current;
    setPreviewing(false);
    setPos(t);
    if (!v || !c || busyRef.current) return;
    v.pause();
    await seekTo(v, t);
    if (!busyRef.current) paintFrame(c, v, effMode);
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
    seededRef.current = null;
    setSource(null);
    setInfo(null);
    setError('');
    setProgress(null);
    setPreviewing(false);
    setPanel('none');
    setPos(0);
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

  const recordSegment = async (start, end, renderMode, mbps, targetFps, mimeType, onProgress) => {
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
    if (mimeType) opts.mimeType = mimeType;

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

    const type = (recorder.mimeType || mimeType || 'video/webm').split(';')[0] || 'video/webm';
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
    setPanel('none');
    setPreviewing(false);
    cancelRef.current = false;
    busyRef.current = true;
    lastPctRef.current = -1;
    setBusy(true);
    video.pause();

    const segs = buildSegments(video.duration || info.duration, segLen);
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

    const base =
      (info.name || 'clip').replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40) || 'clip';
    const out = [];

    try {
      for (let i = 0; i < total; i += 1) {
        const { start, end } = segs[i];
        const blob = await recordSegment(start, end, effMode, bitrate, fps, mime, (local) => {
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
      setPanel('output');
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
      if (sourceRef.current) {
        seekTo(video, 0).then(() => {
          if (!busyRef.current && sourceRef.current && canvasRef.current) {
            setPos(0);
            paintFrame(canvasRef.current, video, effMode);
          }
        });
      }
    }
  };

  const handleCancel = () => {
    cancelRef.current = true;
  };

  const inEditor = Boolean(source);
  const atFloor = uiScale <= SCALE_FLOOR + 0.001;
  const totalOutBytes = results.reduce((n, r) => n + r.size, 0);
  const summary = `${dims.w}×${dims.h} · ${fps} FPS · ${bitrate} Mbps · ${
    mime.includes('mp4') ? 'MP4' : 'WebM'
  } · ${segments.length} ${segments.length === 1 ? 'clip' : 'clips'}`;
  const keptAs916 = Boolean(info) && mode === 'blur' && isNineSixteen(info);
  const showChips = warnings.length > 0 || fps === 60 || keptAs916;

  const chips = showChips && (
    <div className="flex flex-wrap gap-1.5">
      {warnings.map((w) => (
        <span
          key={w}
          className="rounded-full border border-amber-800/70 bg-amber-950/40 px-3 py-1 text-sm font-semibold text-amber-400"
        >
          {w}
        </span>
      ))}
      {fps === 60 && (
        <span className="rounded-full border border-amber-800/70 bg-amber-950/40 px-3 py-1 text-sm font-semibold text-amber-400">
          60 FPS needs a 60 FPS source
        </span>
      )}
      {keptAs916 && (
        <span className="rounded-full border border-emerald-800 bg-emerald-950/50 px-3 py-1 text-sm font-semibold text-emerald-400">
          Already 9:16 · kept as is
        </span>
      )}
    </div>
  );

  return (
    <div
      className={`mx-auto flex w-full flex-col overflow-hidden bg-black pt-[max(env(safe-area-inset-top),0.5rem)] text-zinc-100 ${
        landscape ? 'max-w-4xl' : 'max-w-md'
      }`}
      style={{
        height: vp.h > 0 ? vp.h : '100dvh',
        paddingLeft: 'max(env(safe-area-inset-left), 1rem)',
        paddingRight: 'max(env(safe-area-inset-right), 1rem)',
      }}
    >
      {/* Header */}
      <header className={`flex shrink-0 items-center justify-between gap-2 ${landscape ? 'h-12' : 'h-14'}`}>
        {inEditor ? (
          <button
            type="button"
            onClick={() => setConfirmExit(true)}
            aria-label="Exit editor"
            className="pill -ml-2 flex h-11 shrink-0 items-center gap-2 rounded-full px-2"
          >
            <span className="h-3 w-3 rounded-full bg-emerald-500" />
            <span className="text-[1.125rem] font-bold tracking-tight">ClipFix</span>
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-full bg-emerald-500" />
            <span className="text-[1.125rem] font-bold tracking-tight">ClipFix</span>
          </div>
        )}

        {info && (
          <div className="flex min-w-0 items-center gap-2">
            {results.length > 0 && (
              <button
                type="button"
                onClick={() => setPanel('output')}
                disabled={busy}
                className={`pill rounded-full border border-zinc-700 bg-zinc-950 px-3.5 text-[0.9375rem] font-semibold text-zinc-100 disabled:opacity-40 ${
                  landscape ? 'h-10' : 'h-11'
                }`}
              >
                Output · {results.length}
              </button>
            )}
            <button
              type="button"
              onClick={handleProcess}
              disabled={busy}
              className={`pill flex items-center gap-2 rounded-full bg-emerald-500 px-4 text-[0.9375rem] font-bold text-black disabled:opacity-40 ${
                landscape ? 'h-10' : 'h-11'
              }`}
            >
              <IconUpload size={18} />
              Export
            </button>
          </div>
        )}
      </header>

      {error && (
        <div className="card-in mb-2 flex shrink-0 items-start justify-between gap-3 rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-[0.9375rem] text-red-300">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')} aria-label="Dismiss" className="mt-0.5 text-red-300">
            <IconX size={18} />
          </button>
        </div>
      )}

      {/* Empty state: shutter-style picker */}
      {!info && !source && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center pb-16">
          <button
            type="button"
            onClick={openPicker}
            aria-label="Select video"
            className="shutter relative flex h-28 w-28 items-center justify-center rounded-full border-[3px] border-emerald-500"
          >
            <span className="shutter-core h-[5.5rem] w-[5.5rem] rounded-full bg-emerald-500" />
          </button>
          <div className="mt-6 text-base font-semibold tracking-wide text-zinc-300">Select video</div>
        </div>
      )}

      {/* Loading state */}
      {!info && source && !error && (
        <div className="flex flex-1 items-center justify-center pb-16">
          <div className="text-base font-semibold tracking-wide text-zinc-400">Reading file…</div>
        </div>
      )}

      {/* Editor */}
      {info && (
        <main
          ref={mainRef}
          className={`flex min-h-0 flex-1 pb-[max(env(safe-area-inset-bottom),0.5rem)] ${
            landscape ? 'flex-row gap-4' : 'flex-col gap-1'
          }`}
        >
          {/* Preview + timeline */}
          <div
            className={`flex min-w-0 flex-1 flex-col ${landscape || atFloor ? 'min-h-0' : 'min-h-[14rem]'}`}
          >
            <div ref={stageRef} className="relative min-h-0 flex-1">
              <div className="absolute inset-0 flex items-center justify-center">
                <div
                  className="relative overflow-hidden rounded-2xl bg-zinc-950 ring-1 ring-zinc-800"
                  style={{ width: fit.w, height: fit.h }}
                >
                  <canvas
                    ref={canvasRef}
                    width={dims.w}
                    height={dims.h}
                    style={{ width: '100%', height: '100%', display: 'block' }}
                  />
                  <button
                    type="button"
                    onClick={togglePreview}
                    disabled={busy}
                    aria-label={previewing ? 'Pause preview' : 'Play preview'}
                    className="absolute inset-0 flex items-center justify-center"
                  >
                    {!previewing && !busy && (
                      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/55 text-white">
                        <IconPlay size={26} />
                      </span>
                    )}
                  </button>
                  {busy && (
                    <>
                      <div className="scanline pointer-events-none absolute inset-x-0 top-0 h-16" />
                      <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1">
                        <span className="rec-dot h-2 w-2 rounded-full bg-red-500" />
                        <span className="text-sm font-bold tracking-wide text-white">REC</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-3 pt-1">
              <span className="w-11 text-sm tabular-nums text-zinc-300">{fmtTime(pos)}</span>
              <input
                type="range"
                className="scrub min-w-0 flex-1"
                min={0}
                max={info.duration}
                step={0.05}
                value={Math.min(pos, info.duration)}
                onChange={onScrub}
                disabled={busy}
                aria-label="Preview position"
              />
              <span className="w-11 text-right text-sm tabular-nums text-zinc-400">{fmtTime(info.duration)}</span>
            </div>
          </div>

          {/* Info + settings */}
          <div
            className={
              landscape
                ? 'flex w-[52%] max-w-[26rem] shrink-0 flex-col justify-center gap-2'
                : 'flex shrink-0 flex-col gap-2'
            }
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 truncate text-sm text-zinc-300">
                {info.w}×{info.h} · {orientationLabel(info.w, info.h)} · {ratioLabel(info.w, info.h)} ·{' '}
                {fmtSize(info.size)}
              </div>
              <button
                type="button"
                onClick={openPicker}
                disabled={busy}
                className="pill flex h-9 shrink-0 items-center gap-2 rounded-full border border-zinc-700 bg-zinc-950 px-3.5 text-sm font-semibold text-zinc-200 disabled:opacity-40"
              >
                <IconSwap size={15} />
                Change
              </button>
            </div>

            {chips}

            {landscape ? (
              <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                <Field label="Frame">
                  <Seg options={MODES} value={mode} onChange={setMode} disabled={busy} compact />
                </Field>
                <Field label="Split">
                  <Seg options={SPLITS} value={segLen} onChange={setSegLen} disabled={busy} compact />
                </Field>
                <Field label="Resolution">
                  <Seg options={RESOLUTIONS} value={res} onChange={setRes} disabled={busy} compact />
                </Field>
                <Field label="Frame rate">
                  <Seg options={FPS_OPTIONS} value={fps} onChange={setFps} disabled={busy} compact />
                </Field>
                <Field label="Bitrate (Mbps)">
                  <Seg options={BITRATES} value={bitrate} onChange={setBitrate} disabled={busy} compact />
                </Field>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <SettingRow label="Frame">
                  <Seg options={MODES} value={mode} onChange={setMode} disabled={busy} />
                </SettingRow>
                <SettingRow label="Split">
                  <Seg options={SPLITS} value={segLen} onChange={setSegLen} disabled={busy} />
                </SettingRow>
                <SettingRow label="Quality">
                  <div className="flex min-w-0 flex-1 gap-2">
                    <Seg options={RESOLUTIONS} value={res} onChange={setRes} disabled={busy} />
                    <Seg options={FPS_OPTIONS} value={fps} onChange={setFps} disabled={busy} />
                  </div>
                </SettingRow>
                <SettingRow label="Mbps">
                  <Seg options={BITRATES} value={bitrate} onChange={setBitrate} disabled={busy} />
                </SettingRow>
              </div>
            )}

            <div className="truncate text-sm tabular-nums text-zinc-400">{summary}</div>
          </div>
        </main>
      )}

      {/* Exporting window */}
      {info && busy && progress && (
        <Sheet title="Exporting" dim>
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between text-[0.9375rem] font-semibold">
              <span className="text-zinc-300">
                Clip {progress.seg} of {progress.total}
              </span>
              <span className="tabular-nums text-emerald-400">{Math.floor(progress.pct)}%</span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-zinc-900">
              <div className="progress-fill h-full rounded-full bg-emerald-500" style={{ width: `${progress.pct}%` }} />
            </div>
            <div className="text-sm text-zinc-400">Real-time export. Keep this screen open and don't lock your phone.</div>
            <button
              type="button"
              onClick={handleCancel}
              className="pill flex h-12 w-full items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-base font-semibold text-zinc-100"
            >
              Cancel
            </button>
          </div>
        </Sheet>
      )}

      {/* Output window */}
      {info && !busy && panel === 'output' && results.length > 0 && (
        <Sheet title="Export complete" onClose={() => setPanel('none')}>
          <div className="flex flex-col gap-3">
            <div className="text-sm text-zinc-400">
              {results.length} {results.length === 1 ? 'clip' : 'clips'} · {fmtSize(totalOutBytes)} total
            </div>
            {results.map((seg, i) => (
              <SegmentCard key={seg.id} seg={seg} index={i} />
            ))}
            <button
              type="button"
              onClick={() => setPanel('none')}
              className="pill mt-1 flex h-14 w-full items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-base font-semibold text-zinc-100"
            >
              Done
            </button>
          </div>
        </Sheet>
      )}

      {/* Exit confirmation */}
      {confirmExit && (
        <Sheet title="Exit editor?" onClose={() => setConfirmExit(false)} z="z-[60]">
          <p className="text-[0.9375rem] leading-relaxed text-zinc-300">
            {busy ? 'Export will stop. ' : ''}
            {results.length > 0 ? 'Exported clips will be discarded.' : 'Your selection will be cleared.'}
          </p>
          <div className="mt-5 flex gap-2">
            <button
              type="button"
              onClick={() => setConfirmExit(false)}
              className="pill h-12 flex-1 rounded-full border border-zinc-700 bg-zinc-900 text-base font-semibold text-zinc-100"
            >
              Keep editing
            </button>
            <button
              type="button"
              onClick={exitEditor}
              className="pill h-12 flex-1 rounded-full bg-red-500 text-base font-bold text-white"
            >
              Exit
            </button>
          </div>
        </Sheet>
      )}

      {/* Hidden decode element (kept in DOM for iOS) */}
      <video
        ref={videoRef}
        src={source ? source.url : undefined}
        className="clipfix-probe"
        playsInline
        muted
        preload="auto"
        onLoadedMetadata={onMeta}
        onError={onVideoError}
      />

      <input ref={inputRef} type="file" accept="video/*" className="hidden" onChange={onPick} />
    </div>
  );
}