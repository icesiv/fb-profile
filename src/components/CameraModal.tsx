"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface CameraModalProps {
  open: boolean;
  onClose: () => void;
  onCaptureFile: (file: File) => void;
  onFallbackNativeCamera: () => void;
}

export function CameraModal({
  open,
  onClose,
  onCaptureFile,
  onFallbackNativeCamera,
}: CameraModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="camera-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) {
          onClose();
        }
      }}
      className="m-auto w-[min(94dvw,28rem)] rounded-2xl border border-slate-700/80 bg-slate-900 p-0 text-slate-100 shadow-2xl backdrop:bg-slate-950/75 backdrop:backdrop-blur-sm"
    >
      {open ? (
        <CameraSession
          onClose={onClose}
          onCaptureFile={onCaptureFile}
          onFallbackNativeCamera={onFallbackNativeCamera}
        />
      ) : null}
    </dialog>
  );
}

interface CameraSessionProps {
  onClose: () => void;
  onCaptureFile: (file: File) => void;
  onFallbackNativeCamera: () => void;
}

function CameraSession({
  onClose,
  onCaptureFile,
  onFallbackNativeCamera,
}: CameraSessionProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(true);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia
    ) {
      Promise.resolve().then(() => {
        if (!cancelled) {
          setIsStarting(false);
          setError(
            "Live camera preview is unavailable in this browser context. Use your device camera app instead."
          );
        }
      });
      return () => {
        cancelled = true;
      };
    }

    navigator.mediaDevices
      .getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1280 },
          height: { ideal: 1280 },
        },
        audio: false,
      })
      .then((stream) => {
        if (cancelled) {
          for (const track of stream.getTracks()) {
            track.stop();
          }
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => {});
        }
        setIsStarting(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof Error && err.name === "NotAllowedError"
            ? "Camera permission was denied. Allow access in your browser or use your device camera app."
            : "Could not start live camera. You can still take a photo using your device camera app.";
        setError(message);
        setIsStarting(false);
      });

    return () => {
      cancelled = true;
      stopStream();
    };
  }, [facingMode, stopStream]);

  const handleClose = () => {
    stopStream();
    onClose();
  };

  const handleFlipCamera = () => {
    stopStream();
    setError(null);
    setIsStarting(true);
    setFacingMode((prev) => (prev === "user" ? "environment" : "user"));
  };

  const handleSnap = () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (facingMode === "user") {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File([blob], `camera-photo-${Date.now()}.png`, {
          type: "image/png",
        });
        stopStream();
        onCaptureFile(file);
        onClose();
      },
      "image/png",
      1.0
    );
  };

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2
          id="camera-dialog-title"
          className="text-base font-semibold text-white"
        >
          Take a Photo
        </h2>
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close camera"
          className="inline-flex items-center justify-center rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm font-medium text-slate-200 hover:bg-slate-700"
        >
          Close
        </button>
      </div>

      <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-slate-950 ring-1 ring-white/10">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`h-full w-full object-cover ${
            facingMode === "user" ? "-scale-x-100" : ""
          }`}
        />

        {!error && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center p-3"
          >
            <div className="h-full w-full rounded-full border-2 border-dashed border-white/60 shadow-[0_0_0_9999px_rgba(2,6,23,0.35)]" />
          </div>
        )}

        {isStarting && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/70 text-sm text-slate-200">
            Starting camera…
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-slate-950/90 p-5 text-center">
            <p className="text-sm text-slate-300">{error}</p>
            <button
              type="button"
              onClick={() => {
                handleClose();
                onFallbackNativeCamera();
              }}
              className="inline-flex items-center justify-center rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500"
            >
              Open Device Camera App
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <button
          type="button"
          onClick={handleFlipCamera}
          disabled={isStarting}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2.5 text-sm font-medium text-slate-100 hover:bg-slate-700 disabled:opacity-50"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-4 w-4"
          >
            <path d="M21 7v6h-6" />
            <path d="M3 17v-6h6" />
            <path d="M21 13a9 9 0 0 0-15.5-6.3L3 9" />
            <path d="M3 11a9 9 0 0 0 15.5 6.3L21 15" />
          </svg>
          Flip Camera
        </button>

        <button
          type="button"
          onClick={handleSnap}
          disabled={Boolean(error) || isStarting}
          className="inline-flex flex-[1.4] items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-4 w-4"
          >
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="4" fill="currentColor" />
          </svg>
          Capture Photo
        </button>
      </div>

      <button
        type="button"
        onClick={() => {
          handleClose();
          onFallbackNativeCamera();
        }}
        className="text-center text-xs font-medium text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline"
      >
        Or open your phone’s native camera app
      </button>
    </div>
  );
}
