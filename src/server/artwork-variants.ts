import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const WIDTHS = [64, 128, 256, 384, 640, 1024];
const inFlight = new Map<string, Promise<string>>();
const MAX_ACTIVE_VARIANTS = 4;
const MAX_PENDING_VARIANTS = 64;
const pendingVariants: Array<() => void> = [];
let activeVariants = 0;

function queueVariant(convert: () => Promise<string>): Promise<string> | null {
  if (activeVariants >= MAX_ACTIVE_VARIANTS && pendingVariants.length >= MAX_PENDING_VARIANTS) return null;
  return new Promise((resolve, reject) => {
    const start = () => {
      activeVariants++;
      void convert().then(resolve, reject).finally(() => {
        activeVariants--;
        pendingVariants.shift()?.();
      });
    };
    if (activeVariants < MAX_ACTIVE_VARIANTS) start();
    else pendingVariants.push(start);
  });
}

export function artworkWidth(value: string | null): number | null {
  if (!value) return null;
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return null;
  return WIDTHS.find((width) => width >= requested) ?? WIDTHS[WIDTHS.length - 1];
}

/** Called only after the source image's ownership and real path are checked. */
export async function getArtworkVariant(sourcePath: string, cacheDir: string, width: number): Promise<string> {
  const normalizedWidth = artworkWidth(String(width));
  if (!normalizedWidth) return sourcePath;
  width = normalizedWidth;
  const source = await stat(sourcePath);
  if (!source.isFile() || source.size > 20 * 1024 * 1024) return sourcePath;
  const key = createHash("sha256")
    .update(`square-v2:${sourcePath}:${source.size}:${source.mtimeMs}:${width}`)
    .digest("hex");
  const outputDir = resolve(cacheDir, "variants");
  const outputPath = resolve(outputDir, `${key}.webp`);
  if (await Bun.file(outputPath).exists()) return outputPath;
  const pending = inFlight.get(outputPath);
  if (pending) return pending;
  // Queue normal grids behind four conversions instead of sending full-size
  // originals for every cover after the first four. Overflow remains bounded.
  const job = queueVariant(async () => {
    const { default: sharp } = await import("sharp");
    await mkdir(outputDir, { recursive: true });
    const temporary = `${outputPath}.${randomUUID()}.tmp`;
    try {
      await sharp(sourcePath, { limitInputPixels: 40_000_000, animated: false })
        .rotate()
        .resize({ width, height: width, fit: "cover", position: "centre", withoutEnlargement: true })
        .webp({ quality: 80, effort: 3 })
        .toFile(temporary);
      await rename(temporary, outputPath);
      return outputPath;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  });
  if (!job) return sourcePath;
  inFlight.set(outputPath, job);
  try {
    return await job;
  } finally {
    inFlight.delete(outputPath);
  }
}
