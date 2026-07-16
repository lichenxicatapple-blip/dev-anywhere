#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const ENTER = "\uE007";
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const FIXTURE_ENDPOINT = "/__dev_anywhere_debug/voice-fixture";
const LEADING_SILENCE_ASSERT_MS = 6_000;
const POLL_INTERVAL_MS = 250;
const PAGE_READY_TIMEOUT_MS = 45_000;
const STARTUP_TIMEOUT_MS = 45_000;
const ASR_START_TIMEOUT_MS = 25_000;
const ASR_FINAL_TIMEOUT_MS = 60_000;
const AGENT_RESPONSE_TIMEOUT_MS = 180_000;
const TTS_TIMEOUT_MS = 90_000;
const SAFARIDRIVER_START_TIMEOUT_MS = 10_000;
const FAILURE_EVENTS = new Set([
  "attempt-error",
  "mode-failed",
  "provider-error",
  "speech-attempt-failed",
  "start-failed",
  "startup-failed",
  "wake-lock-failed",
]);

const baseUrl = requiredEnv("IPAD_VOICE_UAT_URL");
const voiceSessionId = requiredEnv("DEV_ANYWHERE_VOICE_FIXTURE_SESSION_ID");
const driverPort = Number(process.env.SAFARIDRIVER_PORT ?? 4444);
const driverOrigin = `http://127.0.0.1:${driverPort}`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDir = path.resolve(
  process.env.IPAD_VOICE_ARTIFACT_DIR ?? "artifacts/voice-pilot-uat/runs",
);
const screenshotPath = path.join(artifactDir, `ipad-voice-${stamp}.png`);
const evidencePath = path.join(artifactDir, `ipad-voice-${stamp}.json`);

let webdriverSessionId = null;
let safaridriverProcess = null;
let capabilities = null;
let fixtureMetadata = null;
let resolvedIpadUdid = null;
let runError = null;

try {
  const targetUrl = buildTargetUrl(baseUrl, voiceSessionId);
  fixtureMetadata = await verifyFixtureEndpoint(baseUrl);
  const ipadUdid = discoverIpadUdid();
  resolvedIpadUdid = ipadUdid;
  safaridriverProcess = await ensureSafariDriver();

  const session = await webdriverRequest("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "Safari",
        platformName: "iOS",
        "safari:deviceUDID": ipadUdid,
      },
    },
  });
  webdriverSessionId = session.sessionId;
  capabilities = session.capabilities;

  log(`Connected to ${capabilities["safari:deviceName"]} (${ipadUdid})`);
  await sessionRequest("POST", "/url", { url: targetUrl });
  await ensureChatReady(targetUrl);

  const diagnosticsInstalled = await executeScript(
    "window.__devAnywhereVoicePilotDiagnostics?.clear(); " +
      "return Boolean(window.__devAnywhereVoicePilotDiagnostics);",
  );
  if (!diagnosticsInstalled) {
    throw new Error("Voice Pilot diagnostics are unavailable in the UAT build");
  }

  await activateElement("css selector", '[data-slot="chat-overflow-trigger"]');
  await activateElement("css selector", '[data-slot="chat-menu-voice-pilot-item"]');
  await activateElement("css selector", '[data-slot="voice-pilot-confirm-start"]');

  await waitForVoiceEvent(
    (event) => event.scope === "runtime" && event.event === "wake-lock-acquired",
    STARTUP_TIMEOUT_MS,
    "Wake Lock acquisition",
  );
  await waitForVoiceEvent(
    (event) =>
      event.scope === "capture" &&
      event.event === "source-ready" &&
      event.details?.source === "fixture",
    STARTUP_TIMEOUT_MS,
    "fixed recording source",
  );
  await waitForVoiceEvent(
    (event) => event.scope === "capture" && event.event === "listening",
    STARTUP_TIMEOUT_MS,
    "Voice Pilot listening state",
  );

  await sleep(LEADING_SILENCE_ASSERT_MS);
  const eventsAfterSilence = await voiceEvents();
  assertNoFailures(eventsAfterSilence);
  if (eventsAfterSilence.some(isAsrAttemptStart)) {
    throw new Error(
      `ASR opened during the fixture's first ${LEADING_SILENCE_ASSERT_MS}ms of silence`,
    );
  }

  await waitForVoiceEvent(isAsrAttemptStart, ASR_START_TIMEOUT_MS, "speech-triggered ASR start");
  await waitForVoiceEvent(
    (event) => event.scope === "asr" && event.event === "provider-ready",
    ASR_START_TIMEOUT_MS,
    "ASR provider readiness",
  );
  await waitForVoiceEvent(
    (event) => event.scope === "asr" && event.event === "final-received",
    ASR_FINAL_TIMEOUT_MS,
    "ASR final transcript",
  );
  await waitForVoiceEvent(
    (event) => event.scope === "runtime" && event.event === "user-text-submitted",
    ASR_FINAL_TIMEOUT_MS,
    "transcript submission to Agent",
  );
  await waitForVoiceEvent(
    (event) =>
      event.scope === "runtime" &&
      event.event === "assistant-text-queued" &&
      typeof event.details?.messageId === "string" &&
      event.details.messageId.length > 0,
    AGENT_RESPONSE_TIMEOUT_MS,
    "Agent response",
  );
  await waitForVoiceEvent(
    (event) => event.scope === "tts" && event.event === "first-pcm-received",
    TTS_TIMEOUT_MS,
    "first TTS PCM chunk",
  );
  await waitForVoiceEvent(
    (event) => event.scope === "tts" && event.event === "provider-finished",
    TTS_TIMEOUT_MS,
    "completed TTS response",
  );

  const events = await voiceEvents();
  assertNoFailures(events);
  await saveEvidence({ targetUrl, ipadUdid, events, passed: true });
  log(`PASS: fixed recording completed Wake Lock -> VAD -> ASR -> Agent -> TTS`);
  log(`Evidence: ${evidencePath}`);
  log(`Screenshot: ${screenshotPath}`);
} catch (error) {
  runError = error instanceof Error ? error : new Error(String(error));
  await saveFailureEvidence(runError).catch(() => undefined);
  console.error(`FAIL: ${runError.message}`);
  if (webdriverSessionId) {
    console.error(`Evidence: ${evidencePath}`);
    console.error(`Screenshot: ${screenshotPath}`);
  }
} finally {
  if (webdriverSessionId) {
    await stopVoicePilot().catch(() => undefined);
    await webdriverRequest("DELETE", `/session/${webdriverSessionId}`).catch(() => undefined);
  }
  safaridriverProcess?.kill("SIGTERM");
}

if (runError) process.exitCode = 1;

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function buildTargetUrl(rawBaseUrl, sessionId) {
  const url = new URL(rawBaseUrl);
  if (url.protocol !== "https:") {
    throw new Error("IPAD_VOICE_UAT_URL must use HTTPS so Wake Lock can be verified");
  }
  url.searchParams.set("voice-fixture", "default");
  url.hash = `/chat/${encodeURIComponent(sessionId)}?mode=json`;
  return url.toString();
}

async function verifyFixtureEndpoint(rawBaseUrl) {
  const endpoint = new URL(FIXTURE_ENDPOINT, rawBaseUrl);
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(
      `Fixed recording endpoint returned HTTP ${response.status}; ` +
        "serve an explicit Voice Pilot UAT build",
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  const bytes = (await response.arrayBuffer()).byteLength;
  if (!contentType.includes("audio/wav") || bytes < 100_000) {
    throw new Error(`Unexpected fixture response: content-type=${contentType}, bytes=${bytes}`);
  }
  return { url: endpoint.toString(), contentType, bytes };
}

function discoverIpadUdid() {
  const configured = process.env.IPAD_UDID?.trim();
  if (configured) return configured;

  const list = execFileSync("xcrun", ["devicectl", "list", "devices"], {
    encoding: "utf8",
  });
  const deviceIds = list
    .split("\n")
    .filter((line) => /available \(paired\)/i.test(line) && /iPad/i.test(line))
    .map((line) => line.match(/\b[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\b/i)?.[0])
    .filter(Boolean);

  if (deviceIds.length !== 1) {
    throw new Error(
      `Expected one available physical iPad, found ${deviceIds.length}; set IPAD_UDID explicitly`,
    );
  }

  const details = execFileSync(
    "xcrun",
    ["devicectl", "device", "info", "details", "--device", deviceIds[0]],
    { encoding: "utf8" },
  );
  const udid = details.match(/^\s*• udid:\s*(\S+)\s*$/m)?.[1];
  if (!udid) throw new Error("Could not resolve the connected iPad hardware UDID");
  return udid;
}

async function ensureSafariDriver() {
  if (await safariDriverReady()) return null;

  const child = spawn("/usr/bin/safaridriver", ["--port", String(driverPort)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < SAFARIDRIVER_START_TIMEOUT_MS) {
    if (await safariDriverReady()) return child;
    if (child.exitCode !== null) {
      throw new Error(`safaridriver exited with code ${child.exitCode}: ${output.trim()}`);
    }
    await sleep(100);
  }
  child.kill("SIGTERM");
  throw new Error(`safaridriver did not become ready: ${output.trim()}`);
}

async function safariDriverReady() {
  try {
    const response = await fetch(`${driverOrigin}/status`);
    if (!response.ok) return false;
    const payload = await response.json();
    return payload.value?.ready === true;
  } catch {
    return false;
  }
}

async function webdriverRequest(method, requestPath, body) {
  const response = await fetch(`${driverOrigin}${requestPath}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.value?.error) {
    const message =
      payload.value?.message ?? `${method} ${requestPath} returned HTTP ${response.status}`;
    const error = new Error(message);
    error.webdriverError = payload.value?.error;
    throw error;
  }
  return payload.value;
}

function sessionRequest(method, requestPath, body) {
  if (!webdriverSessionId) throw new Error("WebDriver session is not available");
  return webdriverRequest(method, `/session/${webdriverSessionId}${requestPath}`, body);
}

async function executeScript(script, args = []) {
  return sessionRequest("POST", "/execute/sync", { script, args });
}

async function findElement(using, value) {
  const element = await sessionRequest("POST", "/element", { using, value });
  const id = element?.[ELEMENT_KEY];
  if (!id) throw new Error(`WebDriver did not return an element for ${using}=${value}`);
  return id;
}

async function waitForElement(using, value, timeoutMs = PAGE_READY_TIMEOUT_MS) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await findElement(using, value);
    } catch (error) {
      lastError = error;
      await sleep(POLL_INTERVAL_MS);
    }
  }
  throw new Error(
    `Timed out waiting for ${using}=${value}: ${lastError instanceof Error ? lastError.message : ""}`,
  );
}

async function activateElement(using, value) {
  const elementId = await waitForElement(using, value);
  await sessionRequest("POST", `/element/${elementId}/value`, {
    text: ENTER,
    value: [ENTER],
  });
}

async function ensureChatReady(targetUrl) {
  try {
    await waitForElement("css selector", '[aria-label="输入聊天消息"]', 20_000);
    return;
  } catch {
    const proxy = await waitForElement(
      "css selector",
      '[data-slot="proxy-item"][data-online="true"]',
      20_000,
    );
    await sessionRequest("POST", `/element/${proxy}/value`, { text: ENTER, value: [ENTER] });
    await sessionRequest("POST", "/url", { url: targetUrl });
    await waitForElement("css selector", '[aria-label="输入聊天消息"]');
  }
}

async function voiceEvents() {
  return executeScript("return window.__devAnywhereVoicePilotDiagnostics?.snapshot() ?? [];");
}

async function waitForVoiceEvent(predicate, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const events = await voiceEvents();
    assertNoFailures(events);
    const match = events.find(predicate);
    if (match) {
      log(`${label}: ${match.event}`);
      return match;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function assertNoFailures(events) {
  const failure = events.find((event) => FAILURE_EVENTS.has(event.event));
  if (!failure) return;
  throw new Error(
    `Voice Pilot ${failure.scope}/${failure.event}: ${JSON.stringify(failure.details ?? {})}`,
  );
}

function isAsrAttemptStart(event) {
  return event.scope === "asr" && event.event === "speech-attempt-starting";
}

async function saveEvidence({ targetUrl, ipadUdid, events, passed, error = null }) {
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        passed,
        error,
        recordedAt: new Date().toISOString(),
        targetUrl,
        fixture: fixtureMetadata,
        device: { udid: ipadUdid, capabilities },
        events,
      },
      null,
      2,
    )}\n`,
  );
  const screenshot = await sessionRequest("GET", "/screenshot");
  writeFileSync(screenshotPath, Buffer.from(screenshot, "base64"));
}

async function saveFailureEvidence(error) {
  if (!webdriverSessionId) return;
  const events = await voiceEvents().catch(() => []);
  await saveEvidence({
    targetUrl: await sessionRequest("GET", "/url").catch(() => null),
    ipadUdid: resolvedIpadUdid,
    events,
    passed: false,
    error: error.message,
  });
}

async function stopVoicePilot() {
  try {
    const elementId = await findElement("css selector", '[data-slot="voice-pilot-stop"]');
    await sessionRequest("POST", `/element/${elementId}/value`, {
      text: ENTER,
      value: [ENTER],
    });
  } catch (error) {
    if (error.webdriverError !== "no such element") throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  console.log(`[ipad-voice] ${message}`);
}
