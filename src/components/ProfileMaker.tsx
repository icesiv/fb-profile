"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { CameraModal } from "./CameraModal";
import {
  clampTransform,
  DEFAULT_TRANSFORM,
  exportFramedPngBlob,
  loadImageFromSrc,
  MAX_ZOOM,
  MIN_ZOOM,
  OUTPUT_SIZE,
  renderFramedProfile,
  type ImageDimensions,
  type RotationDegrees,
  type TransformState,
} from "@/lib/frameRenderer";

const DEFAULT_COVER_SRC = "/logos/cover.png";

interface PointerPoint {
  x: number;
  y: number;
}

function getDistance(a: PointerPoint, b: PointerPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function getMidpoint(a: PointerPoint, b: PointerPoint): PointerPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

const emptySubscribe = () => () => {};

function getCanShareSnapshot(): boolean {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.canShare !== "function"
  ) {
    return false;
  }
  try {
    const probe = new File([new Uint8Array([1])], "probe.png", {
      type: "image/png",
    });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

export function ProfileMaker() {
  const stageContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nativeCameraInputRef = useRef<HTMLInputElement>(null);

  const photoUrlRef = useRef<string | null>(null);

  const [photo, setPhoto] = useState<HTMLImageElement | null>(null);
  const [photoDims, setPhotoDims] = useState<ImageDimensions | null>(null);
  const [cover, setCover] = useState<HTMLImageElement | null>(null);

  const [transform, setTransform] = useState<TransformState>(DEFAULT_TRANSFORM);
  const transformRef = useRef<TransformState>(DEFAULT_TRANSFORM);
  useEffect(() => {
    transformRef.current = transform;
  }, [transform]);

  const [stageSize, setStageSize] = useState(360);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>("");

  const canShareFile = useSyncExternalStore(
    emptySubscribe,
    getCanShareSnapshot,
    () => false
  );

  // Active pointers for 1-finger pan and 2-finger pinch-zoom
  const pointersRef = useRef<Map<number, PointerPoint>>(new Map());
  const pinchStateRef = useRef<{
    distance: number;
    midpoint: PointerPoint;
  } | null>(null);

  // Load cover overlay on mount
  useEffect(() => {
    let cancelled = false;

    void loadImageFromSrc(DEFAULT_COVER_SRC)
      .then((coverImg) => {
        if (cancelled) return;
        setCover(coverImg);
      })
      .catch(() => {
        if (!cancelled) {
          setStatusMessage("Could not load frame cover overlay.");
        }
      });

    return () => {
      cancelled = true;
      if (photoUrlRef.current) {
        URL.revokeObjectURL(photoUrlRef.current);
      }
    };
  }, []);

  // Measure responsive square stage
  useEffect(() => {
    const el = stageContainerRef.current;
    if (!el) return;

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0) {
        setStageSize(Math.round(rect.width));
      }
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Render preview canvas whenever state changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || stageSize <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelSize = Math.round(stageSize * dpr);
    if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
      canvas.width = pixelSize;
      canvas.height = pixelSize;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    renderFramedProfile(ctx, pixelSize, {
      photo,
      transform,
      cover,
    });
  }, [photo, transform, cover, stageSize]);

  const applyTransform = useCallback(
    (updater: (prev: TransformState) => TransformState) => {
      setTransform((prev) => {
        const next = clampTransform(updater(prev), photoDims);
        transformRef.current = next;
        return next;
      });
    },
    [photoDims]
  );

  const loadPhotoFile = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) {
      setStatusMessage("Please select an image file (JPG, PNG, WebP, or HEIC).");
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    void loadImageFromSrc(objectUrl)
      .then((img) => {
        if (photoUrlRef.current) {
          URL.revokeObjectURL(photoUrlRef.current);
        }
        photoUrlRef.current = objectUrl;
        setPhoto(img);
        setPhotoDims({ width: img.naturalWidth, height: img.naturalHeight });
        setTransform(DEFAULT_TRANSFORM);
        transformRef.current = DEFAULT_TRANSFORM;
        setStatusMessage(
          "Photo loaded. Drag to move and pinch or slide to zoom."
        );
      })
      .catch(() => {
        URL.revokeObjectURL(objectUrl);
        setStatusMessage("Could not read that image. Please try another photo.");
      });
  }, []);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      loadPhotoFile(file);
    }
    e.target.value = "";
  };

  // Non-passive wheel listener for smooth zoom toward cursor
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (e: WheelEvent) => {
      if (!photo) return;
      e.preventDefault();

      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0) return;

      const factor = Math.exp(-e.deltaY * 0.0022);
      const cursorNormX = (e.clientX - rect.left) / rect.width - 0.5;
      const cursorNormY = (e.clientY - rect.top) / rect.height - 0.5;

      applyTransform((prev) => {
        const nextZoom = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, prev.zoom * factor)
        );
        const ratio = nextZoom / prev.zoom;
        return {
          ...prev,
          zoom: nextZoom,
          panX: cursorNormX - (cursorNormX - prev.panX) * ratio,
          panY: cursorNormY - (cursorNormY - prev.panY) * ratio,
        };
      });
    };

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [photo, applyTransform]);

  const handlePointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!photo) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size === 2) {
      const [p1, p2] = Array.from(pointersRef.current.values());
      pinchStateRef.current = {
        distance: Math.max(1, getDistance(p1, p2)),
        midpoint: getMidpoint(p1, p2),
      };
    } else {
      pinchStateRef.current = null;
    }
  };

  const handlePointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!photo) return;
    const prevPoint = pointersRef.current.get(e.pointerId);
    if (!prevPoint) return;

    const nextPoint: PointerPoint = { x: e.clientX, y: e.clientY };
    pointersRef.current.set(e.pointerId, nextPoint);

    const rect = e.currentTarget.getBoundingClientRect();
    const size = rect.width || stageSize;
    if (size <= 0) return;

    if (pointersRef.current.size === 1) {
      const dx = (nextPoint.x - prevPoint.x) / size;
      const dy = (nextPoint.y - prevPoint.y) / size;
      applyTransform((prev) => ({
        ...prev,
        panX: prev.panX + dx,
        panY: prev.panY + dy,
      }));
    } else if (pointersRef.current.size === 2) {
      const [p1, p2] = Array.from(pointersRef.current.values());
      const newDist = Math.max(1, getDistance(p1, p2));
      const newMid = getMidpoint(p1, p2);
      const prevPinch = pinchStateRef.current;

      if (prevPinch) {
        const zoomFactor = newDist / prevPinch.distance;
        const prevMidNormX = (prevPinch.midpoint.x - rect.left) / size - 0.5;
        const prevMidNormY = (prevPinch.midpoint.y - rect.top) / size - 0.5;
        const nextMidNormX = (newMid.x - rect.left) / size - 0.5;
        const nextMidNormY = (newMid.y - rect.top) / size - 0.5;

        applyTransform((prev) => {
          const nextZoom = Math.min(
            MAX_ZOOM,
            Math.max(MIN_ZOOM, prev.zoom * zoomFactor)
          );
          const ratio = nextZoom / prev.zoom;
          return {
            ...prev,
            zoom: nextZoom,
            panX: nextMidNormX - (prevMidNormX - prev.panX) * ratio,
            panY: nextMidNormY - (prevMidNormY - prev.panY) * ratio,
          };
        });
      }

      pinchStateRef.current = { distance: newDist, midpoint: newMid };
    }
  };

  const handlePointerUpOrCancel = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    pointersRef.current.delete(e.pointerId);

    if (pointersRef.current.size < 2) {
      pinchStateRef.current = null;
    }
  };

  const handleStageKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    if (!photo) return;
    const step = 0.025;

    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        applyTransform((p) => ({ ...p, panX: p.panX - step }));
        break;
      case "ArrowRight":
        e.preventDefault();
        applyTransform((p) => ({ ...p, panX: p.panX + step }));
        break;
      case "ArrowUp":
        e.preventDefault();
        applyTransform((p) => ({ ...p, panY: p.panY - step }));
        break;
      case "ArrowDown":
        e.preventDefault();
        applyTransform((p) => ({ ...p, panY: p.panY + step }));
        break;
      case "+":
      case "=":
        e.preventDefault();
        applyTransform((p) => ({ ...p, zoom: p.zoom + 0.15 }));
        break;
      case "-":
      case "_":
        e.preventDefault();
        applyTransform((p) => ({ ...p, zoom: p.zoom - 0.15 }));
        break;
      case "0":
        e.preventDefault();
        setTransform(DEFAULT_TRANSFORM);
        break;
    }
  };

  const handleRotate = () => {
    if (!photo) return;
    applyTransform((prev) => ({
      ...prev,
      rotation: ((prev.rotation + 90) % 360) as RotationDegrees,
    }));
  };

  const handleReset = () => {
    if (!photo) return;
    setTransform(DEFAULT_TRANSFORM);
    setStatusMessage("Reset photo framing.");
  };

  const handleDownload = async () => {
    if (!photo || isExporting) return;
    setIsExporting(true);
    setStatusMessage("Generating 1080×1080 Facebook profile image…");

    try {
      const blob = await exportFramedPngBlob({
        photo,
        transform: transformRef.current,
        cover,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `facebook-profile-${OUTPUT_SIZE}x${OUTPUT_SIZE}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setStatusMessage("Downloaded 1080×1080 Facebook profile image.");
    } catch {
      setStatusMessage("Could not export the image. Please try again.");
    } finally {
      setIsExporting(false);
    }
  };

  const handleShare = async () => {
    if (!photo || isExporting || !canShareFile) return;
    setIsExporting(true);
    try {
      const blob = await exportFramedPngBlob({
        photo,
        transform: transformRef.current,
        cover,
      });
      const file = new File(
        [blob],
        `facebook-profile-${OUTPUT_SIZE}x${OUTPUT_SIZE}.png`,
        { type: "image/png" }
      );
      await navigator.share({
        files: [file],
        title: "Facebook Profile Photo",
      });
      setStatusMessage("Shared profile image.");
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        setStatusMessage("Could not open share sheet. Try Download instead.");
      }
    } finally {
      setIsExporting(false);
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      loadPhotoFile(file);
    }
  };

  const zoomPercent = Math.round(transform.zoom * 100);
  const zoomProgress = useMemo(() => {
    return `${((transform.zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)) * 100}%`;
  }, [transform.zoom]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center gap-5 px-4 py-5 sm:px-6 sm:py-8">
      <main className="grid grid-cols-1 items-start gap-6 md:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] md:gap-8">
        {/* Interactive Frame Stage */}
        <section
          aria-label="Photo framing preview"
          className="flex flex-col gap-3"
        >
          <div
            ref={stageContainerRef}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDraggingOver(true);
            }}
            onDragLeave={() => setIsDraggingOver(false)}
            onDrop={handleDrop}
            className={`relative aspect-square w-full overflow-hidden rounded-2xl border bg-slate-900 shadow-2xl transition-colors ${
              isDraggingOver
                ? "border-blue-400 ring-2 ring-blue-400/40"
                : "border-slate-700/80"
            }`}
          >
            <canvas
              ref={canvasRef}
              tabIndex={photo ? 0 : -1}
              role="img"
              aria-label={
                photo
                  ? "Interactive profile photo frame. Drag to move, pinch or scroll to zoom, or use arrow keys."
                  : "Empty profile photo frame with cover overlay."
              }
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUpOrCancel}
              onPointerCancel={handlePointerUpOrCancel}
              onKeyDown={handleStageKeyDown}
              className={`block h-full w-full select-none touch-none ${
                photo ? "cursor-grab active:cursor-grabbing" : "cursor-default"
              }`}
            />

            {!photo && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center p-6 text-center">
                <div className="pointer-events-auto flex max-w-xs flex-col items-center gap-3 rounded-2xl border border-white/15 bg-slate-950/75 p-5 shadow-xl backdrop-blur-md">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-500/20 text-blue-300">
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      className="h-6 w-6"
                    >
                      <rect x="3" y="5" width="18" height="14" rx="3" />
                      <circle cx="12" cy="12" r="3.5" />
                      <path d="M8 5l1.2-2h5.6L16 5" />
                    </svg>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-white">
                      Add your photo
                    </p>
                    <p className="text-xs text-slate-300">
                      Take a photo or choose one from your device.
                    </p>
                  </div>
                  <div className="flex w-full flex-col gap-2 sm:flex-row">
                    <button
                      type="button"
                      onClick={() => setIsCameraOpen(true)}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-blue-500"
                    >
                      Camera
                    </button>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-slate-600 bg-slate-800 px-3 py-2.5 text-sm font-semibold text-slate-100 hover:bg-slate-700"
                    >
                      Upload
                    </button>
                  </div>
                </div>
              </div>
            )}

            {photo && (
              <div className="pointer-events-none absolute inset-x-3 bottom-3 flex justify-center">
                <span className="rounded-full bg-slate-950/70 px-3 py-1 text-[11px] font-medium text-slate-200 backdrop-blur-sm">
                  Drag to move • Pinch or scroll to zoom
                </span>
              </div>
            )}
          </div>
        </section>

        {/* Controls Panel */}
        <section
          aria-label="Photo controls and download"
          className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl sm:p-5"
        >
          {/* Hidden file inputs */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="visually-hidden"
            aria-label="Upload photo from device"
          />
          <input
            ref={nativeCameraInputRef}
            type="file"
            accept="image/*"
            capture="user"
            onChange={handleFileChange}
            className="visually-hidden"
            aria-label="Take photo with device camera"
          />

          {/* Step 1: Source */}
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-slate-100">
              1. Choose Photo
            </h2>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => setIsCameraOpen(true)}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2.5 text-sm font-medium text-white hover:bg-slate-700"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="h-4 w-4 text-blue-400"
                >
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
                {photo ? "Retake" : "Take Photo"}
              </button>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2.5 text-sm font-medium text-white hover:bg-slate-700"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="h-4 w-4 text-indigo-400"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                {photo ? "Change File" : "Choose File"}
              </button>
            </div>
          </div>

          <hr className="border-slate-800" />

          {/* Step 2: Adjust */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="zoom-slider"
                className="text-sm font-semibold text-slate-100"
              >
                2. Zoom &amp; Position
              </label>
              <span className="rounded-md bg-slate-800 px-2 py-0.5 font-mono text-xs text-slate-300">
                {zoomPercent}%
              </span>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                aria-label="Zoom out"
                disabled={!photo || transform.zoom <= MIN_ZOOM}
                onClick={() =>
                  applyTransform((p) => ({ ...p, zoom: p.zoom - 0.15 }))
                }
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-800 text-lg font-semibold text-slate-100 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                −
              </button>

              <input
                id="zoom-slider"
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={0.01}
                disabled={!photo}
                value={transform.zoom}
                style={{ ["--progress" as string]: zoomProgress }}
                onChange={(e) => {
                  const nextZoom = Number.parseFloat(e.target.value);
                  applyTransform((p) => ({ ...p, zoom: nextZoom }));
                }}
                className="w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
              />

              <button
                type="button"
                aria-label="Zoom in"
                disabled={!photo || transform.zoom >= MAX_ZOOM}
                onClick={() =>
                  applyTransform((p) => ({ ...p, zoom: p.zoom + 0.15 }))
                }
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-800 text-lg font-semibold text-slate-100 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                +
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                disabled={!photo}
                onClick={handleRotate}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800/80 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="h-4 w-4"
                >
                  <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                  <path d="M21 3v5h-5" />
                </svg>
                Rotate 90°
              </button>

              <button
                type="button"
                disabled={!photo}
                onClick={handleReset}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800/80 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="h-4 w-4"
                >
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
                Reset Fit
              </button>
            </div>
          </div>

          <hr className="border-slate-800" />

          {/* Step 3: Download */}
          <div className="flex flex-col gap-2.5">
            <h2 className="text-sm font-semibold text-slate-100">
              3. Export for Facebook
            </h2>
            <button
              type="button"
              disabled={!photo || isExporting}
              onClick={() => void handleDownload()}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-base font-semibold text-white shadow-lg shadow-blue-600/25 hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 disabled:shadow-none"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="h-5 w-5"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {isExporting
                ? "Preparing PNG…"
                : `Download Image (${OUTPUT_SIZE}×${OUTPUT_SIZE})`}
            </button>

            {canShareFile && (
              <button
                type="button"
                disabled={!photo || isExporting}
                onClick={() => void handleShare()}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-100 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Save / Share to Photos
              </button>
            )}

            <p
              role="status"
              aria-live="polite"
              className="min-h-[1.25rem] text-xs text-slate-300"
            >
              {statusMessage ||
                "Processed locally on your device — photos are never uploaded."}
            </p>
          </div>
        </section>
      </main>

      <CameraModal
        open={isCameraOpen}
        onClose={() => setIsCameraOpen(false)}
        onCaptureFile={loadPhotoFile}
        onFallbackNativeCamera={() => nativeCameraInputRef.current?.click()}
      />
    </div>
  );
}
