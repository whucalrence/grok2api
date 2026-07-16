import http from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { isValidStatsigID, patchStatsigChunk, prepareStatsigDocument } from "./patcher.js";
import { inferAccountTier, isLoginURL } from "./session.js";

const port = parseInteger(process.env.PORT, 3000);
const baseURL = parseBaseURL(process.env.GROK_BASE_URL ?? "https://grok.com");
const navigationTimeoutMs = parseInteger(process.env.NAVIGATION_TIMEOUT_MS, 60000);
const signerTimeoutMs = parseInteger(process.env.SIGNER_TIMEOUT_MS, 30000);
const authCheckIntervalMs = parseInteger(process.env.AUTH_CHECK_INTERVAL_MS, 5 * 60 * 1000);
const tokenFile = process.env.GROK_SSO_TOKEN_FILE ?? "/run/secrets/grok-sso-token";
const maxBodyBytes = 32 * 1024;

let browser;
let context;
let page;
let activeMeta = "";
let ready = false;
let stopping = false;
let lastError = "starting";
let accountTier = "unknown";
let lastVerifiedAt = "";
let lastVerifiedAtMs = 0;
let activePatch = {};
let operationQueue = Promise.resolve();
let initializationTask;
let authMonitor;

function log(level, event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ level, event, ...fields, time: new Date().toISOString() })}\n`);
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBaseURL(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("GROK_BASE_URL must be a credential-free HTTPS URL");
  }
  return parsed.origin;
}

function serialize(task) {
  const result = operationQueue.then(task, task);
  operationQueue = result.catch(() => {});
  return result;
}

async function closeSession() {
  ready = false;
  activeMeta = "";
  accountTier = "unknown";
  activePatch = {};
  page = undefined;
  if (context) {
    const previous = context;
    context = undefined;
    await previous.close().catch(() => {});
  }
}

async function ensureBrowser() {
  if (browser?.isConnected()) {
    return browser;
  }
  const launchedBrowser = await chromium.launch({ headless: true });
  browser = launchedBrowser;
  launchedBrowser.on("disconnected", () => {
    if (browser === launchedBrowser) {
      browser = undefined;
      ready = false;
      lastError = "browser disconnected";
      scheduleInitialization();
    }
  });
  return browser;
}

async function readSSOToken() {
  let value;
  try {
    value = (await readFile(tokenFile, "utf8")).trim();
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Grok SSO token file is missing");
    }
    throw error;
  }
  if (value.length < 32 || value.length > 8192 || /\s/.test(value)) {
    throw new Error("Grok SSO token file is invalid");
  }
  return value;
}

async function createSession(metaContent) {
  await closeSession();
  const activeBrowser = await ensureBrowser();
  const ssoToken = await readSSOToken();
  const nextContext = await activeBrowser.newContext({
    locale: "zh-CN",
    serviceWorkers: "block",
    viewport: { width: 1280, height: 900 },
  });
  const patchState = { inspected: 0, patched: false, loaderModuleID: "", chunkPath: "" };
  let documentMeta = "";
  let documentPatchError;
  let resolveSignedResponse;
  const signedResponseSeen = new Promise((resolve) => {
    resolveSignedResponse = resolve;
  });
  const observeSignedResponse = (response) => {
    const request = response.request();
    let requestURL;
    try {
      requestURL = new URL(request.url());
    } catch {
      return;
    }
    const grokHost = requestURL.hostname === "grok.com" || requestURL.hostname.endsWith(".grok.com");
    const accepted = response.status() >= 200 && response.status() < 400;
    if (grokHost && requestURL.pathname.startsWith("/rest/") && accepted) {
      void request
        .allHeaders()
        .then((headers) => {
          if (isValidStatsigID(headers["x-statsig-id"])) {
            resolveSignedResponse();
          }
        })
        .catch(() => {});
    }
  };
  try {
    await nextContext.addCookies(
      ["sso", "sso-rw"].map((name) => ({
        name,
        value: ssoToken,
        domain: ".grok.com",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      })),
    );
    nextContext.on("response", observeSignedResponse);
    await nextContext.route(
      (url) => url.origin === baseURL && url.pathname === "/",
      async (route) => {
        if (route.request().resourceType() !== "document") {
          await route.continue();
          return;
        }
        try {
          const response = await route.fetch();
          if (isLoginURL(response.url(), baseURL)) {
            throw new Error("Grok SSO session was redirected to login");
          }
          const source = await response.text();
          const result = prepareStatsigDocument(source, metaContent);
          if (!result.found) {
            throw new Error("Grok page is missing the verification meta");
          }
          documentMeta = result.metaContent;
          await route.fulfill({ response, body: result.source });
        } catch (error) {
          documentPatchError = error;
          await route.abort("failed").catch(() => {});
        }
      },
    );
    await nextContext.route(/\/_next\/static\/chunks\/.*\.js(?:\?.*)?$/, async (route) => {
      if (patchState.patched) {
        await route.continue();
        return;
      }
      try {
        const response = await route.fetch();
        const source = await response.text();
        patchState.inspected += 1;
        const result = patchStatsigChunk(source);
        if (!result.patched) {
          await route.fulfill({ response, body: source });
          return;
        }
        patchState.patched = true;
        patchState.loaderModuleID = result.loaderModuleID;
        patchState.chunkPath = new URL(route.request().url()).pathname;
        await route.fulfill({ response, body: result.source });
      } catch (error) {
        log("warn", "chunk_route_failed", { error: String(error?.message ?? error) });
        await route.continue().catch(() => {});
      }
    });

    const nextPage = await nextContext.newPage();
    nextPage.setDefaultTimeout(signerTimeoutMs);
    nextPage.setDefaultNavigationTimeout(navigationTimeoutMs);
    let response;
    try {
      response = await nextPage.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
    } catch (error) {
      throw documentPatchError ?? error;
    }
    if (documentPatchError) {
      throw documentPatchError;
    }
    if (!response || response.status() >= 400) {
      throw new Error(`Grok page returned ${response?.status() ?? "no response"}`);
    }
    if (isLoginURL(nextPage.url(), baseURL)) {
      throw new Error("Grok SSO session was redirected to login");
    }
    try {
      await nextPage.waitForFunction(() => typeof globalThis.__grok2apiStatsigSign === "function", null, {
        timeout: signerTimeoutMs,
      });
    } catch (error) {
      if (!patchState.patched) {
        throw new Error(`Grok signer wrapper structure changed after inspecting ${patchState.inspected} chunks`);
      }
      throw error;
    }
    await withTimeout(signedResponseSeen, signerTimeoutMs, "Grok page did not initialize its signing session");
    nextContext.off("response", observeSignedResponse);
    const verification = await verifyAuthenticatedSession(nextPage);

    context = nextContext;
    page = nextPage;
    activeMeta = documentMeta;
    recordVerification(verification, false);
    activePatch = {
      version: "turbopack-wrapper-v1",
      loaderModuleID: patchState.loaderModuleID,
      chunkPath: patchState.chunkPath,
    };
    ready = true;
    lastError = "";
    log("info", "signer_ready", {
      inspectedChunks: patchState.inspected,
      loaderModuleID: patchState.loaderModuleID,
      chunkPath: patchState.chunkPath,
      tier: accountTier,
    });
  } catch (error) {
    nextContext.off("response", observeSignedResponse);
    await nextContext.close().catch(() => {});
    throw error;
  }
}

async function verifyAuthenticatedSession(targetPage) {
  const windows = await withTimeout(
    targetPage.evaluate(async () => {
      const results = [];
      for (const mode of ["auto", "fast"]) {
        const path = "/rest/rate-limits";
        const statsigID = await globalThis.__grok2apiStatsigSign(path, "POST");
        const response = await fetch(path, {
          method: "POST",
          credentials: "include",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-statsig-id": statsigID,
            "x-xai-request-id": crypto.randomUUID(),
          },
          body: JSON.stringify({ modelName: mode }),
        });
        let payload;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        results.push({
          mode,
          status: response.status,
          url: response.url,
          total: Number(payload?.totalQueries),
        });
      }
      return results;
    }),
    signerTimeoutMs,
    "authenticated Grok session probe timed out",
  );
  for (const window of windows) {
    if (window.url && isLoginURL(window.url, baseURL)) {
      throw new Error(
        `Grok protected quota probe was redirected (status ${window.status}, destination ${describeDestination(window.url)})`,
      );
    }
    if (window.status === 401) {
      throw new Error("Grok SSO session is unauthorized");
    }
    if (window.status === 403) {
      throw new Error("Grok rejected the browser signature or session");
    }
    if (window.status !== 200) {
      throw new Error(`Grok protected quota probe returned ${window.status}`);
    }
    if (!Number.isSafeInteger(window.total) || window.total <= 0) {
      throw new Error("Grok protected quota response is invalid");
    }
  }
  return { tier: inferAccountTier(windows) };
}

function describeDestination(value) {
  try {
    const parsed = new URL(value);
    return parsed.origin === baseURL ? parsed.pathname.split("/").slice(0, 2).join("/") || "/" : "foreign-origin";
  } catch {
    return "invalid-url";
  }
}

function recordVerification(verification, reportChange = true) {
  const previousTier = accountTier;
  accountTier = verification.tier;
  lastVerifiedAt = new Date().toISOString();
  lastVerifiedAtMs = Date.now();
  if (reportChange && previousTier !== "unknown" && accountTier !== previousTier) {
    log("warn", "account_tier_changed", { previousTier, tier: accountTier });
  }
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function signOnce(method, path, metaContent) {
  if (!page || !ready || activeMeta !== metaContent) {
    await createSession(metaContent);
  }
  const value = await withTimeout(
    page.evaluate(
      async ({ requestPath, requestMethod }) =>
        globalThis.__grok2apiStatsigSign(requestPath, requestMethod),
      { requestPath: path, requestMethod: method },
    ),
    signerTimeoutMs,
    "browser signature generation timed out",
  );
  if (!isValidStatsigID(value)) {
    throw new Error("browser returned an invalid Statsig ID");
  }
  return value.trim();
}

async function sign(method, path, metaContent) {
  return serialize(async () => {
    try {
      return await signOnce(method, path, metaContent);
    } catch (firstError) {
      ready = false;
      lastError = String(firstError?.message ?? firstError);
      log("warn", "sign_retry", { method, path, error: lastError });
      try {
        await createSession(metaContent);
        return await signOnce(method, path, metaContent);
      } catch (secondError) {
        ready = false;
        lastError = String(secondError?.message ?? secondError);
        await closeSession();
        scheduleInitialization();
        throw secondError;
      }
    }
  });
}

function validateSignRequest(value) {
  const method = String(value?.method ?? "").trim().toUpperCase();
  const path = String(value?.path ?? "").trim();
  const metaContent = String(value?.environment?.metaContent ?? "").trim();
  if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)) {
    throw new Error("invalid method");
  }
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("?") || path.includes("#") || path.length > 2048) {
    throw new Error("invalid path");
  }
  if (!metaContent || metaContent.length > 4096 || /[\u0000-\u001f\u007f]/.test(metaContent)) {
    throw new Error("invalid metaContent");
  }
  return { method, path, metaContent };
}

async function readJSON(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new Error("request body too large");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJSON(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  const requestURL = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && requestURL.pathname === "/healthz") {
    const verificationFresh = lastVerifiedAtMs > 0 && Date.now() - lastVerifiedAtMs <= authCheckIntervalMs * 2;
    const healthy = ready && verificationFresh;
    const healthError = ready && !verificationFresh ? "authentication verification is stale" : lastError;
    sendJSON(response, healthy ? 200 : 503, {
      ready: healthy,
      authenticated: healthy,
      tier: healthy ? accountTier : undefined,
      lastVerifiedAt: lastVerifiedAt || undefined,
      signerPatch: healthy ? activePatch : undefined,
      error: healthy ? undefined : healthError,
    });
    return;
  }
  if (request.method !== "POST" || requestURL.pathname !== "/sign") {
    sendJSON(response, 404, { error: "not found" });
    return;
  }

  let input;
  try {
    input = validateSignRequest(await readJSON(request));
  } catch (error) {
    log("warn", "invalid_sign_request", { error: String(error?.message ?? error) });
    sendJSON(response, 400, { error: "invalid sign request" });
    return;
  }

  try {
    const value = await sign(input.method, input.path, input.metaContent);
    sendJSON(response, 200, { "x-statsig-id": value });
    log("info", "signature_created", { method: input.method, path: input.path, length: value.length });
  } catch (error) {
    const message = String(error?.message ?? error);
    lastError = message;
    log("error", "signature_failed", { error: message });
    sendJSON(response, 502, { error: "signature generation failed" });
  }
});

server.listen(port, "0.0.0.0", () => {
  log("info", "server_listening", { port });
  scheduleInitialization();
  startAuthMonitor();
});

function startAuthMonitor() {
  authMonitor = setInterval(() => {
    if (stopping || !ready || !page) {
      return;
    }
    void serialize(async () => {
      if (!ready || !page) {
        return;
      }
      try {
        recordVerification(await verifyAuthenticatedSession(page));
      } catch (error) {
        lastError = String(error?.message ?? error);
        log("warn", "authenticated_session_lost", { error: lastError });
        await closeSession();
        scheduleInitialization();
      }
    });
  }, authCheckIntervalMs);
  authMonitor.unref();
}

function scheduleInitialization() {
  if (stopping || initializationTask) {
    return;
  }
  initializationTask = initializeUntilReady().finally(() => {
    initializationTask = undefined;
    if (!stopping && !ready) {
      scheduleInitialization();
    }
  });
}

async function initializeUntilReady() {
  while (!stopping && !ready) {
    try {
      await serialize(() => createSession(""));
    } catch (error) {
      lastError = String(error?.message ?? error);
      log("error", "signer_start_failed", { error: lastError });
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }
  }
}

async function shutdown(signal) {
  if (stopping) {
    return;
  }
  stopping = true;
  log("info", "shutdown", { signal });
  clearInterval(authMonitor);
  server.close();
  await serialize(closeSession);
  await browser?.close().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
