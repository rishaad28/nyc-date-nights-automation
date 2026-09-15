import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

const exec = promisify(execFile);
const baseUrl = String(process.env.NYCDN_MEDIA_BASE_URL || "").replace(/\/$/, "");
const token = String(process.env.NYCDN_MEDIA_UPLOAD_TOKEN || "");
const jobLimit = Math.max(1, Math.min(100, Number(process.env.PREVIEW_JOB_LIMIT || 20)));

if (!baseUrl || !token) throw new Error("NYCDN_MEDIA_BASE_URL and NYCDN_MEDIA_UPLOAD_TOKEN are required.");
if (!ffmpegPath) throw new Error("The bundled ffmpeg executable is unavailable.");

const headers = { authorization: `Bearer ${token}` };
const response = await fetch(`${baseUrl}/api/admin/media-upload`, {
  headers,
  signal: AbortSignal.timeout(60_000),
});
if (!response.ok) throw new Error(`Preview job request failed (${response.status}).`);
const payload = await response.json();
const jobs = Array.isArray(payload.jobs) ? payload.jobs.slice(0, jobLimit) : [];

const variants = {
  mini: { duration: 2.5, width: 360, fps: 15, crf: 28, maximumBytes: 2 * 1024 * 1024 },
  featured: { duration: 4.5, width: 540, fps: 24, crf: 25, maximumBytes: 5 * 1024 * 1024 },
};

async function transcode(input, output, settings) {
  const keyframes = settings.fps * 2;
  await exec(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-stream_loop", "-1", "-i", input,
    "-t", String(settings.duration),
    "-an",
    "-vf", `scale=${settings.width}:-2:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=${settings.fps}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", String(settings.crf),
    "-pix_fmt", "yuv420p",
    "-g", String(keyframes), "-keyint_min", String(keyframes), "-sc_threshold", "0",
    "-movflags", "+faststart",
    output,
  ], { timeout: 120_000, maxBuffer: 1024 * 1024 });
}

async function upload(reelId, kind, settings, file) {
  const bytes = await readFile(file);
  if (!bytes.byteLength || bytes.byteLength > settings.maximumBytes) {
    throw new Error(`${kind} preview has an invalid size (${bytes.byteLength} bytes).`);
  }
  const uploadResponse = await fetch(`${baseUrl}/api/admin/media-upload?reelId=${encodeURIComponent(reelId)}&kind=${kind}`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "video/mp4",
      "x-preview-duration": String(settings.duration),
      "x-preview-width": String(settings.width),
    },
    body: bytes,
    signal: AbortSignal.timeout(120_000),
  });
  if (!uploadResponse.ok) {
    const detail = await uploadResponse.text();
    throw new Error(`${kind} upload failed (${uploadResponse.status}): ${detail.slice(0, 300)}`);
  }
}

let processed = 0;
let failed = 0;
for (const job of jobs) {
  const workspace = await mkdtemp(path.join(tmpdir(), "nycdn-previews-"));
  try {
    const sourceResponse = await fetch(job.sourceUrl, { signal: AbortSignal.timeout(120_000) });
    if (!sourceResponse.ok) throw new Error(`Source download failed (${sourceResponse.status}).`);
    const source = path.join(workspace, "source.mp4");
    await writeFile(source, new Uint8Array(await sourceResponse.arrayBuffer()));
    for (const [kind, settings] of Object.entries(variants)) {
      if (kind === "mini" && !job.needsMini) continue;
      if (kind === "featured" && !job.needsFeatured) continue;
      const output = path.join(workspace, `${kind}.mp4`);
      await transcode(source, output, settings);
      await upload(job.reelId, kind, settings, output);
    }
    processed += 1;
    console.log(`Generated requested previews for ${job.shortcode}.`);
  } catch (error) {
    failed += 1;
    console.error(`${job.shortcode}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({ queued: jobs.length, processed, failed }));
if (failed) process.exitCode = 1;
