export const OUTPUT_SIZE = 1080;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 5;

export type RotationDegrees = 0 | 90 | 180 | 270;

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface TransformState {
  /** Multiplier on top of the base cover scale (>= 1). */
  zoom: number;
  /** Horizontal offset as a fraction of frame size (0 = centered). */
  panX: number;
  /** Vertical offset as a fraction of frame size (0 = centered). */
  panY: number;
  rotation: RotationDegrees;
}

export interface RenderFrameOptions {
  photo: HTMLImageElement | null;
  transform: TransformState;
  cover: HTMLImageElement | null;
}

export const DEFAULT_TRANSFORM: TransformState = {
  zoom: 1,
  panX: 0,
  panY: 0,
  rotation: 0,
};

/** Returns natural dimensions after accounting for 90°/270° rotation. */
export function getRotatedDimensions(
  dims: ImageDimensions,
  rotation: RotationDegrees
): ImageDimensions {
  if (rotation === 90 || rotation === 270) {
    return { width: dims.height, height: dims.width };
  }
  return dims;
}

/**
 * Computes the normalized image size (relative to a 1x1 square frame)
 * when scaled to cover the frame at the given zoom level.
 */
export function getNormalizedCoverSize(
  dims: ImageDimensions,
  zoom: number,
  rotation: RotationDegrees
): { width: number; height: number; baseCoverScale: number } {
  const rotated = getRotatedDimensions(dims, rotation);
  if (rotated.width <= 0 || rotated.height <= 0) {
    return { width: 1, height: 1, baseCoverScale: 1 };
  }
  const baseCoverScale = Math.max(1 / rotated.width, 1 / rotated.height);
  return {
    width: rotated.width * baseCoverScale * zoom,
    height: rotated.height * baseCoverScale * zoom,
    baseCoverScale,
  };
}

/** Clamps zoom and pan so the photo always covers the square frame without gaps. */
export function clampTransform(
  transform: TransformState,
  dims: ImageDimensions | null
): TransformState {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, transform.zoom));
  if (!dims || dims.width <= 0 || dims.height <= 0) {
    return { ...transform, zoom, panX: 0, panY: 0 };
  }

  const { width, height } = getNormalizedCoverSize(
    dims,
    zoom,
    transform.rotation
  );
  const maxPanX = Math.max(0, (width - 1) / 2);
  const maxPanY = Math.max(0, (height - 1) / 2);

  return {
    ...transform,
    zoom,
    panX: Math.min(maxPanX, Math.max(-maxPanX, transform.panX)),
    panY: Math.min(maxPanY, Math.max(-maxPanY, transform.panY)),
  };
}

/**
 * Renders the square framed profile image onto a 2D canvas context.
 * Uses identical normalized math for both the live preview and 1080x1080 export.
 */
export function renderFramedProfile(
  ctx: CanvasRenderingContext2D,
  size: number,
  options: RenderFrameOptions
): void {
  const { photo, transform, cover } = options;

  ctx.save();
  ctx.clearRect(0, 0, size, size);

  // Neutral dark backdrop when no photo is loaded or behind transparent PNGs
  ctx.fillStyle = photo ? "#0f172a" : "#1e293b";
  ctx.fillRect(0, 0, size, size);

  if (photo && photo.naturalWidth > 0 && photo.naturalHeight > 0) {
    const dims: ImageDimensions = {
      width: photo.naturalWidth,
      height: photo.naturalHeight,
    };
    const { baseCoverScale } = getNormalizedCoverSize(
      dims,
      transform.zoom,
      transform.rotation
    );
    const pixelScale = baseCoverScale * size * transform.zoom;
    const drawWidth = dims.width * pixelScale;
    const drawHeight = dims.height * pixelScale;

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.translate(
      size / 2 + transform.panX * size,
      size / 2 + transform.panY * size
    );
    ctx.rotate((transform.rotation * Math.PI) / 180);
    ctx.drawImage(
      photo,
      -drawWidth / 2,
      -drawHeight / 2,
      drawWidth,
      drawHeight
    );
    ctx.restore();
  } else {
    // Subtle checkerboard / placeholder grid when empty
    const step = size / 12;
    ctx.fillStyle = "rgba(255, 255, 255, 0.03)";
    for (let row = 0; row < 12; row++) {
      for (let col = 0; col < 12; col++) {
        if ((row + col) % 2 === 0) {
          ctx.fillRect(col * step, row * step, step, step);
        }
      }
    }
  }

  // Full-bleed transparent frame cover overlay on top
  if (cover && cover.naturalWidth > 0) {
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(cover, 0, 0, size, size);
    ctx.restore();
  }

  ctx.restore();
}

export function loadImageFromSrc(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

export async function exportFramedPngBlob(options: {
  photo: HTMLImageElement;
  transform: TransformState;
  cover: HTMLImageElement | null;
}): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not initialize 2D export canvas.");
  }

  renderFramedProfile(ctx, OUTPUT_SIZE, {
    photo: options.photo,
    transform: options.transform,
    cover: options.cover,
  });

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Failed to encode PNG image."));
          return;
        }
        resolve(blob);
      },
      "image/png",
      1.0
    );
  });
}
