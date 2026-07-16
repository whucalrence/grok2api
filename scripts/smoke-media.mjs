import { readFile } from "node:fs/promises";

let baseURL;
let apiKey;
let requestTimeoutMs;
let videoTimeoutMs;
let pollIntervalMs;
let existingVideoRequestID = "";
const startedAt = Date.now();

class SmokeError extends Error {
  constructor(step, message, status, code) {
    super(message);
    this.step = step;
    this.status = status;
    this.code = code;
  }
}

function parseBaseURL(value) {
  const parsed = new URL(value);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("GROK2API_BASE_URL must be a credential-free HTTP(S) URL");
  }
  return parsed.href.replace(/\/$/, "");
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function initialize() {
  try {
    baseURL = parseBaseURL(process.env.GROK2API_BASE_URL ?? "http://127.0.0.1:8000");
  } catch {
    throw new SmokeError("startup", "GROK2API_BASE_URL is invalid", undefined, "invalid_config");
  }
  requestTimeoutMs = parsePositiveInteger(process.env.GROK2API_MEDIA_SMOKE_REQUEST_TIMEOUT_MS, 4 * 60 * 1000);
  videoTimeoutMs = parsePositiveInteger(process.env.GROK2API_MEDIA_SMOKE_VIDEO_TIMEOUT_MS, 12 * 60 * 1000);
  pollIntervalMs = parsePositiveInteger(process.env.GROK2API_MEDIA_SMOKE_POLL_INTERVAL_MS, 5000);

  const apiKeyFile = process.env.GROK2API_API_KEY_FILE;
  if (!apiKeyFile) {
    throw new SmokeError("startup", "GROK2API_API_KEY_FILE is required", undefined, "invalid_config");
  }
  try {
    apiKey = (await readFile(apiKeyFile, "utf8")).trim();
  } catch {
    throw new SmokeError("startup", "API key file could not be read", undefined, "invalid_config");
  }
  if (apiKey.length < 20 || apiKey.length > 4096 || /\s/.test(apiKey)) {
    throw new SmokeError("startup", "API key file is invalid", undefined, "invalid_config");
  }

  const videoRequestIDFile = process.env.GROK2API_MEDIA_SMOKE_VIDEO_REQUEST_ID_FILE;
  if (videoRequestIDFile) {
    try {
      existingVideoRequestID = (await readFile(videoRequestIDFile, "utf8")).trim();
    } catch {
      throw new SmokeError("startup", "video request ID file could not be read", undefined, "invalid_config");
    }
    if (existingVideoRequestID.length < 8 || existingVideoRequestID.length > 512 || /\s/.test(existingVideoRequestID)) {
      throw new SmokeError("startup", "video request ID file is invalid", undefined, "invalid_config");
    }
  }
}

function log(step, fields = {}) {
  process.stdout.write(`${JSON.stringify({ step, ...fields })}\n`);
}

async function requestJSON(step, path, options = {}, timeoutMs = requestTimeoutMs) {
  let response;
  try {
    response = await fetch(`${baseURL}${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw networkSmokeError(step, error);
  }
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new SmokeError(step, "response was not JSON", response.status, "invalid_response");
  }
  if (!response.ok) {
    throw new SmokeError(step, "API request failed", response.status, body?.error?.code ?? "unknown");
  }
  return body;
}

function decodeImage(step, body) {
  const encoded = body?.data?.[0]?.b64_json;
  if (typeof encoded !== "string" || encoded.length < 1024 || encoded.length > 128 * 1024 * 1024) {
    throw new SmokeError(step, "image response did not contain bounded base64 data", 200, "invalid_image");
  }
  const bytes = Buffer.from(encoded, "base64");
  const mimeType = detectImageMIME(bytes);
  if (!mimeType || bytes.length < 512) {
    throw new SmokeError(step, "image payload signature was invalid", 200, "invalid_image");
  }
  return { encoded, bytes, mimeType };
}

function detectImageMIME(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return "";
}

async function verifyVideoContent(value) {
  let parsed;
  try {
    parsed = new URL(value, `${baseURL}/`);
  } catch {
    throw new SmokeError("video_content", "video URL was invalid", 200, "invalid_video");
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new SmokeError("video_content", "video URL was unsafe", 200, "invalid_video");
  }
  const headers = { range: "bytes=0-65535" };
  if (parsed.origin === new URL(baseURL).origin) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  let response;
  try {
    response = await fetch(parsed, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    throw networkSmokeError("video_content", error);
  }
  if (!response.ok) {
    throw new SmokeError("video_content", "video content was unavailable", response.status, "video_unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new SmokeError("video_content", "video content had no body", response.status, "invalid_video");
  }
  const first = await reader.read();
  await reader.cancel().catch(() => {});
  const bytes = Buffer.from(first.value ?? []);
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  const mp4 = bytes.subarray(4, 8).toString("ascii") === "ftyp";
  const webm = bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (!contentType.startsWith("video/") && !mp4 && !webm) {
    throw new SmokeError("video_content", "video payload signature was invalid", response.status, "invalid_video");
  }
  return { bytes: bytes.length, contentType: contentType || (mp4 ? "video/mp4" : "video/webm") };
}

function networkSmokeError(step, error) {
  const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
  return new SmokeError(step, timeout ? "network request timed out" : "network request failed", undefined, timeout ? "timeout" : "network_error");
}

async function run() {
  await initialize();

  let requestID = existingVideoRequestID;
  let videoStartedAt = Date.now();
  if (!requestID) {
    const imageStartedAt = Date.now();
    const generatedBody = await requestJSON("image_generation", "/v1/images/generations", {
      method: "POST",
      body: JSON.stringify({
        model: "grok-imagine-image",
        prompt: "A single red paper airplane on a clean white studio background, no text",
        n: 1,
        resolution: "1k",
        response_format: "b64_json",
      }),
    });
    const generated = decodeImage("image_generation", generatedBody);
    log("image_generation", {
      status: "ok",
      elapsedMs: Date.now() - imageStartedAt,
      bytes: generated.bytes.length,
      mimeType: generated.mimeType,
    });

    const editStartedAt = Date.now();
    const editedBody = await requestJSON("image_edit", "/v1/images/edits", {
      method: "POST",
      body: JSON.stringify({
        model: "grok-imagine-image-edit",
        prompt: "Change only the background to pale blue and keep the red paper airplane",
        image: { url: `data:${generated.mimeType};base64,${generated.encoded}` },
        n: 1,
        resolution: "1k",
        response_format: "b64_json",
      }),
    });
    const edited = decodeImage("image_edit", editedBody);
    log("image_edit", {
      status: "ok",
      elapsedMs: Date.now() - editStartedAt,
      bytes: edited.bytes.length,
      mimeType: edited.mimeType,
    });

    videoStartedAt = Date.now();
    const submitted = await requestJSON("video_submit", "/v1/videos/generations", {
      method: "POST",
      body: JSON.stringify({
        model: "grok-imagine-video",
        prompt: "A red paper airplane glides slowly across a clear studio background, static camera",
        duration: 1,
        aspect_ratio: "16:9",
        resolution: "480p",
      }),
    });
    requestID = submitted?.request_id;
    if (typeof requestID !== "string" || requestID.length < 8 || requestID.length > 512) {
      throw new SmokeError("video_submit", "video request ID was invalid", 200, "invalid_response");
    }
    log("video_submit", { status: "ok", elapsedMs: Date.now() - videoStartedAt });
  } else {
    log("video_resume", { status: "ok" });
  }

  let lastProgress = -1;
  const deadline = Date.now() + videoTimeoutMs;
  while (Date.now() < deadline) {
    const state = await requestJSON("video_poll", `/v1/videos/${encodeURIComponent(requestID)}`, { method: "GET" });
    if (state?.status === "failed") {
      throw new SmokeError("video_poll", "video task failed", 200, state?.error?.code ?? "unknown");
    }
    if (state?.status === "done") {
      const verified = await verifyVideoContent(state?.video?.url);
      log("video_generation", {
        status: "ok",
        elapsedMs: Date.now() - videoStartedAt,
        duration: state?.video?.duration,
        sampledBytes: verified.bytes,
        contentType: verified.contentType,
      });
      log("complete", { status: "ok", elapsedMs: Date.now() - startedAt });
      return;
    }
    const progress = Number.isFinite(state?.progress) ? Math.max(0, Math.min(99, Math.trunc(state.progress))) : 0;
    if (progress !== lastProgress) {
      lastProgress = progress;
      log("video_progress", { progress });
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new SmokeError("video_poll", "video task timed out", 408, "timeout");
}

try {
  await run();
} catch (error) {
  const known = error instanceof SmokeError;
  process.stderr.write(
    `${JSON.stringify({
      step: known ? error.step : "startup",
      status: "failed",
      httpStatus: known ? error.status : undefined,
      errorCode: known ? error.code : "smoke_test_failed",
      message: known ? error.message : "media smoke test failed",
    })}\n`,
  );
  process.exitCode = 1;
}
