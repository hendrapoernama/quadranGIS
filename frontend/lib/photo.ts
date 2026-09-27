'use client';

export interface CompressedPhoto {
  image: Blob;
  thumb: Blob;
  width: number;
  height: number;
}

async function draw(bmp: ImageBitmap, maxDim: number): Promise<HTMLCanvasElement> {
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  return cv;
}

function toBlob(cv: HTMLCanvasElement, q: number): Promise<Blob> {
  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', q));
}

/**
 * Kompres foto kamera di perangkat: sisi terpanjang ≤ maxDim, JPEG, ukuran ≤ maxKB
 * (kualitas diturunkan bertahap), plus thumbnail 320 px. Orientasi EXIF diterapkan browser.
 */
export async function compressPhoto(file: Blob, maxDim = 1600, maxKB = 1500): Promise<CompressedPhoto> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as any);
  try {
    let dim = maxDim;
    let cv = await draw(bmp, dim);
    let q = 0.82;
    let image = await toBlob(cv, q);
    while (image.size > maxKB * 1024 && (q > 0.5 || dim > 900)) {
      if (q > 0.5) q -= 0.1;
      else {
        dim = Math.round(dim * 0.8);
        cv = await draw(bmp, dim);
      }
      image = await toBlob(cv, q);
    }
    const thumb = await toBlob(await draw(bmp, 320), 0.7);
    return { image, thumb, width: cv.width, height: cv.height };
  } finally {
    bmp.close();
  }
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
