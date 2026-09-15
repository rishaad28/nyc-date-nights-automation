import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";

const exec = promisify(execFile);
const baseUrl = String(process.env.NYCDN_MEDIA_BASE_URL || "").replace(/\/$/, "");
const token = String(process.env.NYCDN_MEDIA_UPLOAD_TOKEN || "");
const cookiesBase64 = String(process.env.NYCDN_INSTAGRAM_COOKIES_B64 || "");
const ytDlpPath = String(process.env.YT_DLP_PATH || "yt-dlp");
const jobLimit = Math.max(1, Math.min(12, Number(process.env.RECOVERY_JOB_LIMIT || 4)));

if (!baseUrl || !token) throw new Error("NYCDN_MEDIA_BASE_URL and NYCDN_MEDIA_UPLOAD_TOKEN are required.");
if (!cookiesBase64) throw new Error("NYCDN_INSTAGRAM_COOKIES_B64 is required for protected Reel recovery.");
if (!ffmpegPath) throw new Error("The bundled ffmpeg executable is unavailable.");

const headers = { authorization: `Bearer ${token}` };
const response = await fetch(`${baseUrl}/api/admin/media-upload`, {
  headers,
  signal: AbortSignal.timeout(60_000),
});
if (!response.ok) throw new Error(`Media recovery job request failed (${response.status}).`);
const payload = await response.json();
const jobs = Array.isArray(payload.recoveryJobs) ? payload.recoveryJobs.slice(0, jobLimit) : [];

const safeShortcode = (value) => String(value || "").replace(/[^a-zA-Z0-9_-]/g, "");

async function downloadInstagramVideo(job, workspace) {
  const cookiesPath = path.join(workspace, "instagram-cookies.txt");
  const outputTemplate = path.join(workspace, "source.%(ext)s");
  await writeFile(cookiesPath, Buffer.from(cookiesBase64, "base64"), { mode: 0o600 });

  await exec(ytDlpPath, [
    "--no-playlist",
    "--no-warnings",
    "--socket-timeout", "20",
    "--retries", "3",
    "--extractor-retries", "2",
    "--download-sections", "*0-6.5",
    "--ffmpeg-location", ffmpegPath,
    "-f", "bv[ext=mp4]/bv/b[ext=mp4]/b",
    "--cookies", cookiesPath,
    "-o", outputTemplate,
    String(job.permalink || `https://www.instagram.com/reel/${job.shortcode}/`),
  ], { timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });

  const candidates = (await readdir(workspace))
    .filter((name) => /^source\.(?!.*(?:part|ytdl|json|txt)$).+/i.test(name))
    .map((name) => path.join(workspace, name));
  if (!candidates.length) throw new Error("Instagram recovery did not produce a video stream.");

  const ranked = await Promise.all(candidates.map(async (candidate) => ({
    candidate,
    bytes: (await stat(candidate)).size,
  })));
  ranked.sort((a, b) => b.bytes - a.bytes);
  return ranked[0].candidate;
}

async function normalizedPreview(source, output) {
  await exec(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", source,
    "-t", "5.5",
    "-an",
    "-vf", "scale=540:-2:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    output,
  ], { timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
}

async function upload(job, file) {
  const bytes = await readFile(file);
  const uploadResponse = await fetch(`${baseUrl}/api/admin/media-upload?reelId=${encodeURIComponent(job.reelId)}&kind=video`, {
    method: "POST",
    headers: { ...headers, "content-type": "video/mp4" },
    body: bytes,
    signal: AbortSignal.timeout(120_000),
  });
  if (!uploadResponse.ok) {
    const detail = await uploadResponse.text();
    throw new Error(`Recovered video upload failed (${uploadResponse.status}): ${detail.slice(0, 220)}`);
  }
}

let recovered = 0;
let failed = 0;
for (const job of jobs) {
  const shortcode = safeShortcode(job.shortcode);
  const workspace = await mkdtemp(path.join(tmpdir(), "nycdn-recovery-"));
  try {
    if (!shortcode || !job.reelId) throw new Error("The recovery job is missing its Reel identity.");
    const source = await downloadInstagramVideo(job, workspace);
    const preview = path.join(workspace, "recovered.mp4");
    await normalizedPreview(source, preview);
    await upload(job, preview);
    recovered += 1;
    console.log(`Recovered playable media for ${shortcode}.`);
  } catch (error) {
    failed += 1;
    console.error(`${shortcode || "unknown Reel"}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({ queued: jobs.length, recovered, failed }));
if (failed) process.exitCode = 1;
