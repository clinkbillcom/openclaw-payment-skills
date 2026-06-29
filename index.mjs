import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFileSync, spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  buildMessagePreviewTitle,
  createMessageRequest,
  renderMessageMarkdown,
} from "./notification-utils.js";
import {
  isVisaRegistrationSucceeded,
  resolveVicRegistrationState,
  VIC_REGISTRATION_STATE_TTL_MS,
} from "./vic-registration-state-utils.mjs";
import {
  PaymentWorkflowAction,
  PaymentWorkflowState,
  classifyPaymentError,
  classifyPaymentResponse,
} from './lib/payment-workflow-fsm.mjs';

// ------------------------------------------------------------------
// CONFIG HELPERS
// ------------------------------------------------------------------
function resolveOpenClawHome() {
  const explicitHome = typeof process.env.OPENCLAW_HOME === 'string' ? process.env.OPENCLAW_HOME.trim() : '';
  if (explicitHome && explicitHome !== 'undefined') {
    return explicitHome;
  }
  return os.homedir();
}

const OPENCLAW_HOME = resolveOpenClawHome();
const OPENCLAW_DIR = path.join(OPENCLAW_HOME, '.openclaw');
const MCPORTER_CONFIG_PATH = path.join(OPENCLAW_DIR, 'config', 'mcporter.json');

async function getConfigPath() {
  return process.env.OPENCLAW_CONFIG_PATH || path.join(OPENCLAW_DIR, 'openclaw.json');
}

async function loadConfig() {
  const configPath = await getConfigPath();
  try {
    const fileContent = await fs.readFile(configPath, 'utf8');
    return JSON.parse(fileContent);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {};
  }
}

async function saveConfig(config) {
  const configPath = await getConfigPath();
  try {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
  } catch (err) { await logError('saveConfig/mkdir', err); }
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
}

async function getPaymentEnv() {
  const config = await loadConfig();
  const env = config?.skills?.entries?.["agent-payment-skills"]?.env || {};
  try {
    const cache = await readPaymentMethodsCache();
    if (cache?.email) env.CLINK_USER_EMAIL = cache.email;
    if (cache?.customerId) env.CLINK_CUSTOMER_ID = cache.customerId;
    if (cache?.customerAPIKey) env.CLINK_CUSTOMER_API_KEY = cache.customerAPIKey;
  } catch (err) { await logError('getPaymentEnv/readCache', err); }
  return env;
}

async function updatePaymentEnv(updates) {
  const config = await loadConfig();
  config.skills = config.skills || {};
  config.skills.entries = config.skills.entries || {};
  config.skills.entries["agent-payment-skills"] = config.skills.entries["agent-payment-skills"] || {};
  config.skills.entries["agent-payment-skills"].env = config.skills.entries["agent-payment-skills"].env || {};
  for (const [key, value] of Object.entries(updates)) {
    config.skills.entries["agent-payment-skills"].env[key] = value;
  }
  await saveConfig(config);
}

// clink-cli persists the customer API key to ~/.clink-cli/config.json (per profile) and, as a
// security hardening, no longer echoes it on `wallet init` stdout. Recover it from that config so
// the skill can still mirror it into the child-process env that authenticates every clink-cli call.
async function readClinkCliCustomerApiKey(profile) {
  try {
    const clinkConfigPath = path.join(os.homedir(), '.clink-cli', 'config.json');
    const raw = await fs.readFile(clinkConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    const profiles = parsed?.profiles || {};
    const entry = profiles[profile || 'default'] || profiles.default || {};
    return entry.customerApiKey ?? entry.customerAPIKey ?? null;
  } catch (err) {
    await logError('readClinkCliCustomerApiKey', err);
    return null;
  }
}

// ------------------------------------------------------------------
// PAYMENT METHODS CACHE HELPERS
// ------------------------------------------------------------------
const SKILL_DIR = path.dirname(new URL(import.meta.url).pathname);
const CACHE_PATH = path.join(SKILL_DIR, 'clink.config.json');
const LOG_PATH = path.join(SKILL_DIR, 'error.log');
const LOCK_DIR = path.join(SKILL_DIR, 'locks');
const LOCK_STALE_MS = 120000;
const MESSAGE_SENDER = path.join(SKILL_DIR, 'scripts', 'send-message.mjs');
const MERCHANT_CONFIRMATION_RUNNER = path.join(SKILL_DIR, 'scripts', 'run-merchant-confirmation.mjs');
const EVENT_PUMP_SCRIPT = path.join(SKILL_DIR, 'scripts', 'event-pump.mjs');
// Vendored single-file bundle of @clink-ai/clink-cli. Every Clink API call is
// performed by invoking this CLI; the skill never calls Clink HTTP directly.
const CLINK_CLI_BUNDLE = path.join(SKILL_DIR, 'vendor', 'clink-cli', 'clink-cli.bundle.mjs');

function resolveOpenClawExecutable() {
  const explicit = typeof process.env.OPENCLAW_BIN === 'string' ? process.env.OPENCLAW_BIN.trim() : '';
  if (explicit && explicit !== 'undefined') {
    return explicit;
  }
  try {
    const resolved = execFileSync('which', ['openclaw'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return resolved || 'openclaw';
  } catch {
    return 'openclaw';
  }
}

function probeGatewayRuntimePid(openclawBin) {
  try {
    const out = execFileSync(openclawBin, ['gateway', 'status', '--require-rpc', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const parsed = JSON.parse(out);
    const pid = parsed?.service?.runtime?.pid;
    return typeof pid === 'number' || (typeof pid === 'string' && pid.trim())
      ? { pid: String(pid), error: '' }
      : { pid: null, error: 'gateway status did not include runtime pid' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr =
      typeof err?.stderr === 'string'
        ? err.stderr.trim()
        : Buffer.isBuffer(err?.stderr)
          ? err.stderr.toString('utf8').trim()
          : '';
    const stdout =
      typeof err?.stdout === 'string'
        ? err.stdout.trim()
        : Buffer.isBuffer(err?.stdout)
          ? err.stdout.toString('utf8').trim()
          : '';
    return {
      pid: null,
      error: [message, stderr && 'stderr: ' + stderr, stdout && 'stdout: ' + stdout]
        .filter(Boolean)
        .join(' | '),
    };
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function normalizeCache(cache) {
  const normalized = cache && typeof cache === 'object' ? cache : {};
  if (!Array.isArray(normalized.paymentMethods)) normalized.paymentMethods = [];
  if (normalized.defaultPaymentMethodId === undefined) normalized.defaultPaymentMethodId = null;
  if (!normalized.paymentFlowStates || typeof normalized.paymentFlowStates !== 'object') {
    normalized.paymentFlowStates = {};
  }
  if (!normalized.orderCardStates || typeof normalized.orderCardStates !== 'object') {
    normalized.orderCardStates = {};
  }
  if (
    normalized.notifyDestination &&
    typeof normalized.notifyDestination === 'object' &&
    !Array.isArray(normalized.notifyDestination) &&
    typeof normalized.notifyDestination.channel === 'string' &&
    normalized.notifyDestination.channel.trim() &&
    normalized.notifyDestination.target &&
    typeof normalized.notifyDestination.target === 'object' &&
    !Array.isArray(normalized.notifyDestination.target) &&
    typeof normalized.notifyDestination.target.id === 'string' &&
    normalized.notifyDestination.target.id.trim() &&
    typeof normalized.notifyDestination.target.type === 'string' &&
    normalized.notifyDestination.target.type.trim()
  ) {
    normalized.notifyDestination = {
      channel: normalized.notifyDestination.channel.trim().toLowerCase(),
      target: {
        type: normalized.notifyDestination.target.type.trim(),
        id: normalized.notifyDestination.target.id.trim(),
      },
      ...(typeof normalized.notifyDestination.locale === 'string' && normalized.notifyDestination.locale.trim()
        ? { locale: normalized.notifyDestination.locale.trim() }
        : {}),
    };
  } else {
    normalized.notifyDestination = null;
  }
  if (
    normalized.pendingMerchantConfirmation &&
    typeof normalized.pendingMerchantConfirmation === 'object' &&
    !Array.isArray(normalized.pendingMerchantConfirmation)
  ) {
    const pending = normalized.pendingMerchantConfirmation;
    if (
      pending.notifyDestination &&
      typeof pending.notifyDestination === 'object' &&
      !Array.isArray(pending.notifyDestination) &&
      typeof pending.notifyDestination.channel === 'string' &&
      pending.notifyDestination.channel.trim() &&
      pending.notifyDestination.target &&
      typeof pending.notifyDestination.target === 'object' &&
      !Array.isArray(pending.notifyDestination.target) &&
      typeof pending.notifyDestination.target.id === 'string' &&
      pending.notifyDestination.target.id.trim() &&
      typeof pending.notifyDestination.target.type === 'string' &&
      pending.notifyDestination.target.type.trim()
    ) {
      pending.notifyDestination = {
        channel: pending.notifyDestination.channel.trim().toLowerCase(),
        target: {
          type: pending.notifyDestination.target.type.trim(),
          id: pending.notifyDestination.target.id.trim(),
        },
        ...(typeof pending.notifyDestination.locale === 'string' && pending.notifyDestination.locale.trim()
          ? { locale: pending.notifyDestination.locale.trim() }
          : {}),
      };
    } else {
      pending.notifyDestination = null;
    }
  }
  return normalized;
}

function normalizePaymentMethods(methods) {
  return Array.isArray(methods)
    ? methods
        .map((method) => ({
          paymentInstrumentId: method.paymentInstrumentId || null,
          paymentMethodType: method.paymentMethodType || method.paymentInstrumentType || null,
          cardBrand: method.cardBrand || method.cardScheme || null,
          cardScheme: method.cardScheme || method.cardBrand || null,
          network: method.network || method.cardNetwork || method.paymentNetwork || null,
          cardLast4: method.cardLast4 || method.cardLastFour || null,
          issuerBank: method.issuerBank || null,
          walletAccountTag: method.walletAccountTag || method.wallet?.accountTag || null,
          visaRegistrationSucceeded: isVisaRegistrationSucceeded(method),
          isDefault: method.isDefault ?? false,
          isDisabled: method.isDisabled ?? false,
          status: method.status || ((method.isDisabled ?? false) ? "disabled" : "active"),
        }))
        .filter((method) => typeof method.paymentInstrumentId === "string" && method.paymentInstrumentId.trim())
    : [];
}

function normalizeRuleSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return null;
  }
  const normalizeNumberString = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric.toFixed(2) : String(value);
  };
  const normalizeInteger = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? String(Math.trunc(numeric)) : String(value);
  };
  const normalizeBoolean = (value) => {
    if (value === undefined || value === null) return null;
    return Boolean(value);
  };
  const normalizeString = (value) => {
    if (value === undefined || value === null || value === '') return null;
    return String(value).trim();
  };
  return {
    singleRechargeLimit: normalizeNumberString(settings.singleRechargeLimit),
    dailyTotalLimit: normalizeNumberString(settings.dailyTotalLimit),
    dailyMaxCount: normalizeInteger(settings.dailyMaxCount),
    rechargeInterval: normalizeString(settings.rechargeInterval),
    manualApprovalThreshold: normalizeNumberString(settings.manualApprovalThreshold),
    manualApprovalEnabled: normalizeBoolean(settings.manualApprovalEnabled),
    autoSuspendEnabled: normalizeBoolean(settings.autoSuspendEnabled),
  };
}

function normalizeNotifyDestinationValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return normalizeCache({ notifyDestination: cloneJsonValue(value) }).notifyDestination;
}

function getPendingNotifyDestination(cache) {
  const pendingNotifyDestination = normalizeCache(cache).pendingMerchantConfirmation?.notifyDestination || null;
  return pendingNotifyDestination ? cloneJsonValue(pendingNotifyDestination) : null;
}

async function logRequest(context, payload, response) {
  const entry = {
    time: new Date().toISOString(),
    context,
    request: payload,
    response,
  };
  const line = JSON.stringify(entry) + '\n';
  try { await fs.appendFile(LOG_PATH, line, 'utf8'); } catch {}
}

async function logError(context, error) {
  const line = `[${new Date().toISOString()}] [${context}] ${error instanceof Error ? error.stack || error.message : String(error)}\n`;
  try { await fs.appendFile(LOG_PATH, line, 'utf8'); } catch {}
}

function extractMessageRequest(value) {
  if (value?.message_key || value?.messageKey) {
    return value;
  }
  if (value?.message && (value.message.message_key || value.message.messageKey)) {
    return value.message;
  }
  return null;
}

async function logNotificationFallback(context, { cache, message, reason }) {
  const notifyDestination = getNotifyDestination(cache);
  const messageRequest = extractMessageRequest(message);
  await logRequest(`${context}/fallback`, {
    reason,
    messageKey: messageRequest?.message_key || messageRequest?.messageKey || '',
    messageTitle: messageRequest ? buildMessagePreviewTitle(messageRequest) : '',
    hasNotifyDestination: Boolean(notifyDestination),
    notifyDestination: notifyDestination ? {
      channel: typeof notifyDestination.channel === 'string' ? notifyDestination.channel : '',
      targetType: typeof notifyDestination?.target?.type === 'string' ? notifyDestination.target.type : '',
      hasTargetId: Boolean(notifyDestination?.target?.id),
    } : null,
  }, {
    fallback: 'instruction_markdown',
  });
}

async function readPaymentMethodsCache() {
  try {
    const content = await fs.readFile(CACHE_PATH, 'utf8');
    return normalizeCache(JSON.parse(content));
  } catch (err) {
    if (err.code !== 'ENOENT') await logError('readPaymentMethodsCache', err);
    return null;
  }
}

async function writePaymentMethodsCache(cache) {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(normalizeCache(cache), null, 2), 'utf8');
}

// ------------------------------------------------------------------
// EVENT PUMP (single mailbox consumer; replaces webhook + poll fallback)
// ------------------------------------------------------------------
function ensureEventPumpRunning() {
  try {
    const child = spawn(process.execPath, [EVENT_PUMP_SCRIPT], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    // The pump is a singleton guarded by its own lock; a spawn failure here is
    // non-fatal — the next tool call (or install) retries.
    logError('ensureEventPumpRunning', err);
  }
}

// Async completion (card bound, order/refund result, instruction activation,
// risk-rule update) is delivered by the event pump, not by per-operation
// pollers.
//
// Build the agent-facing DIRECT_SEND directive after a notification has already
// been delivered. webhookWaitMessage (if provided) explains how the completion
// notification will arrive.
function buildDirectSendDirective({ summary, suffix, webhookWaitMessage } = {}) {
  const sections = [
    `[SYSTEM DIRECTIVE] DIRECT_SEND: ${summary || ''}`.trimEnd(),
    'The notification has been sent. Do NOT send another card.',
  ];
  const waitContent = String(webhookWaitMessage || '').trim();
  if (waitContent) sections.push(waitContent);
  let result = sections.join('\n');
  if (suffix) result += '\n\n' + suffix;
  return result;
}

function formatPaymentFsmDirective(workflow) {
  if (!workflow || typeof workflow !== 'object') return '';
  const state = workflow.state || 'UNKNOWN';
  const action = workflow.action || 'UNKNOWN';
  const reason = workflow.reason || 'unspecified';
  return `[PAYMENT_FSM] state=${state} action=${action} reason=${reason}`;
}



function normalizeRefundStatusCode(status) {
  return typeof status === 'string' && status.trim()
    ? status.trim().toLowerCase()
    : 'unknown';
}

function buildCardStateLockName(orderId, status, sessionId) {
  const parts = getOrderCardStateKeys(orderId, status, sessionId);
  if (parts.length === 0) return 'global';
  return parts[0].replace(/[^a-zA-Z0-9._-]+/g, '_');
}

async function withCardStateLock(orderId, status, sessionId, fn) {
  const lockName = buildCardStateLockName(orderId, status, sessionId);
  const lockPath = path.join(LOCK_DIR, `${lockName}.lock`);
  await fs.mkdir(LOCK_DIR, { recursive: true });

  const timeoutMs = 15000;
  const retryMs = 100;
  const startedAt = Date.now();

  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(String(process.pid), 'utf8');
        return await fn();
      } finally {
        await handle.close().catch(() => {});
        await fs.unlink(lockPath).catch(() => {});
      }
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        throw err;
      }
      try {
        const stats = await fs.stat(lockPath);
        if (Date.now() - stats.mtimeMs >= LOCK_STALE_MS) {
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch (statErr) {
        if (statErr?.code === 'ENOENT') {
          continue;
        }
        await logError('withCardStateLock/stat', statErr);
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for card-state lock: ${lockName}`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

function normalizeOrderStatus(status) {
  if (status === undefined || status === null || status === '') return null;
  return String(status).trim();
}

function getOrderCardStateKeys(orderId, status, sessionId) {
  const keys = [];
  const normalizedStatus = normalizeOrderStatus(status);
  if (typeof orderId === 'string' && orderId.trim() && normalizedStatus) {
    keys.push(`order_status:${orderId.trim()}:${normalizedStatus}`);
  }
  if (typeof orderId === 'string' && orderId.trim()) keys.push(`order:${orderId.trim()}`);
  if (typeof sessionId === 'string' && sessionId.trim()) keys.push(`session:${sessionId.trim()}`);
  return keys;
}

function getOrderCardState(cache, orderId, status, sessionId) {
  const normalizedCache = normalizeCache(cache);
  for (const key of getOrderCardStateKeys(orderId, status, sessionId)) {
    if (normalizedCache.orderCardStates[key]) {
      return normalizedCache.orderCardStates[key];
    }
  }
  return null;
}

async function updateOrderCardState(orderId, status, sessionId, patch) {
  if (!Object.keys(patch || {}).length) return null;
  const cache = normalizeCache(await readPaymentMethodsCache() || {});
  const existing = getOrderCardState(cache, orderId, status, sessionId) || {};
  const nextState = {
    ...existing,
    ...patch,
    orderId: typeof orderId === 'string' && orderId.trim() ? orderId.trim() : existing.orderId || null,
    status: normalizeOrderStatus(status) || existing.status || null,
    sessionId: typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : existing.sessionId || null,
    updatedAt: new Date().toISOString(),
  };

  for (const key of getOrderCardStateKeys(nextState.orderId, nextState.status, nextState.sessionId)) {
    cache.orderCardStates[key] = nextState;
  }

  await writePaymentMethodsCache(cache);
  return nextState;
}

function getNotifyDestination(cache) {
  const normalizedCache = normalizeCache(cache);
  if (normalizedCache.notifyDestination) {
    return cloneJsonValue(normalizedCache.notifyDestination);
  }
  return getPendingNotifyDestination(normalizedCache);
}

function buildNotificationPayload(notifyDestination, message) {
  const channel = typeof notifyDestination?.channel === 'string' && notifyDestination.channel.trim()
    ? notifyDestination.channel.trim().toLowerCase()
    : '';
  const targetType = typeof notifyDestination?.target?.type === 'string' && notifyDestination.target.type.trim()
    ? notifyDestination.target.type.trim()
    : '';
  const targetId = typeof notifyDestination?.target?.id === 'string' && notifyDestination.target.id.trim()
    ? notifyDestination.target.id.trim()
    : '';
  if (!channel || !targetType || !targetId) {
    throw new Error('notify destination must include channel, target.type, and target.id');
  }
  const payload = {
    channel,
    target: {
      type: targetType,
      id: targetId,
      ...(typeof notifyDestination?.locale === 'string' && notifyDestination.locale.trim()
        ? { locale: notifyDestination.locale.trim() }
        : {}),
    },
    deliver: true,
  };
  const messageRequest = extractMessageRequest(message);
  if (!messageRequest) {
    throw new Error('message payload must include message_key');
  }
  payload.message_key = String(messageRequest.message_key || messageRequest.messageKey || '').trim();
  payload.vars = cloneJsonValue(messageRequest.vars || {});
  payload.locale = typeof messageRequest.locale === 'string' ? messageRequest.locale : 'auto';
  if (messageRequest.delivery_policy || messageRequest.deliveryPolicy) {
    payload.delivery_policy = cloneJsonValue(messageRequest.delivery_policy || messageRequest.deliveryPolicy);
  }
  return payload;
}

function sendNotificationDirect(notifyDestination, message) {
  const payload = buildNotificationPayload(notifyDestination, message);
  if (!payload.target?.id) {
    throw new Error('notify target missing');
  }
  execFileSync(
    process.execPath,
    [MESSAGE_SENDER, '--payload', JSON.stringify(payload)],
    {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 15000,
    },
  );
}

function buildPostRestartNotifyScript({
  openclawBin,
  sendMessageScript,
  payload,
  logPath,
  initialPid = null,
  initialDelayMs = 1000,
  maxWaitForDownMs = 60000,
  maxWaitForUpMs = 120000,
  pollMs = 500,
  sendRetries = 3,
  sendRetryDelayMs = 2000,
}) {
  return `
import { execFileSync } from 'child_process';
import { appendFile, mkdir } from 'fs/promises';
import path from 'path';

const openclawBin = ${JSON.stringify(openclawBin)};
const sendMessageScript = ${JSON.stringify(sendMessageScript)};
const payload = ${JSON.stringify(JSON.stringify(payload))};
const logPath = ${JSON.stringify(logPath)};
const providedInitialPid = ${JSON.stringify(initialPid)};
const initialDelayMs = ${JSON.stringify(initialDelayMs)};
const maxWaitForDownMs = ${JSON.stringify(maxWaitForDownMs)};
const maxWaitForUpMs = ${JSON.stringify(maxWaitForUpMs)};
const pollMs = ${JSON.stringify(pollMs)};
const sendRetries = ${JSON.stringify(sendRetries)};
const sendRetryDelayMs = ${JSON.stringify(sendRetryDelayMs)};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function logLine(message) {
  try {
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, '[' + new Date().toISOString() + '] [restart-notify] ' + message + '\\n');
  } catch {}
}

function probeGatewayPid() {
  try {
    const out = execFileSync(openclawBin, ['gateway', 'status', '--require-rpc', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const parsed = JSON.parse(out);
    if (parsed && parsed.service && parsed.service.runtime && parsed.service.runtime.pid) {
      return { pid: parsed.service.runtime.pid, error: '' };
    }
    return { pid: null, error: 'gateway status did not include runtime pid' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr =
      typeof err?.stderr === 'string'
        ? err.stderr.trim()
        : Buffer.isBuffer(err?.stderr)
          ? err.stderr.toString('utf8').trim()
          : '';
    const stdout =
      typeof err?.stdout === 'string'
        ? err.stdout.trim()
        : Buffer.isBuffer(err?.stdout)
          ? err.stdout.toString('utf8').trim()
          : '';
    return {
      pid: null,
      error: [message, stderr && 'stderr: ' + stderr, stdout && 'stdout: ' + stdout]
        .filter(Boolean)
        .join(' | '),
    };
  }
}

function formatExecError(err) {
  const message = err instanceof Error ? err.message : String(err);
  const stderr =
    typeof err?.stderr === 'string'
      ? err.stderr.trim()
      : Buffer.isBuffer(err?.stderr)
        ? err.stderr.toString('utf8').trim()
        : '';
  const stdout =
    typeof err?.stdout === 'string'
      ? err.stdout.trim()
      : Buffer.isBuffer(err?.stdout)
        ? err.stdout.toString('utf8').trim()
        : '';
  const status = typeof err?.status === 'number' ? 'status: ' + err.status : '';
  return [message, status, stderr && 'stderr: ' + stderr, stdout && 'stdout: ' + stdout]
    .filter(Boolean)
    .join(' | ');
}

async function waitForInitialPid(maxAttempts) {
  let lastError = '';
  for (let i = 0; i < maxAttempts; i++) {
    const { pid, error } = probeGatewayPid();
    if (pid) {
      return { pid, error: lastError };
    }
    if (error) {
      lastError = error;
    }
    await sleep(pollMs);
  }
  return { pid: null, error: lastError };
}

await sleep(initialDelayMs);

const initialProbe = providedInitialPid
  ? { pid: providedInitialPid, error: '' }
  : await waitForInitialPid(5);
const initialPid = initialProbe.pid;

if (!initialPid) {
  await logLine('rpc readiness probe did not return an initial PID; continuing without baseline.' + (initialProbe.error ? ' last_error=' + initialProbe.error : ''));
} else if (providedInitialPid) {
  await logLine('using provided baseline pid ' + initialPid);
}

let waitedDown = 0;
if (initialPid) {
  let observedDown = false;
  let lastDownError = '';
  while (waitedDown <= maxWaitForDownMs) {
    const { pid, error } = probeGatewayPid();
    if (error) {
      lastDownError = error;
    }
    if (!pid || pid !== initialPid) {
      observedDown = true;
      break;
    }
    await sleep(pollMs);
    waitedDown += pollMs;
  }

  if (!observedDown) {
    await logLine('gateway down timeout after ' + maxWaitForDownMs + 'ms' + (lastDownError ? ' | last_error=' + lastDownError : ''));
    process.exit(1);
  }
}

let waitedUp = 0;
let restartedPid = null;
let lastUpError = '';
while (waitedUp <= maxWaitForUpMs) {
  const { pid, error } = probeGatewayPid();
  if (error) {
    lastUpError = error;
  }
  if (pid && (!initialPid || pid !== initialPid)) {
    restartedPid = pid;
    break;
  }
  await sleep(pollMs);
  waitedUp += pollMs;
}

if (!restartedPid) {
  await logLine('gateway up timeout after ' + maxWaitForUpMs + 'ms' + (lastUpError ? ' | rpc readiness failed: ' + lastUpError : ''));
  process.exit(1);
}

for (let attempt = 1; attempt <= sendRetries; attempt++) {
  try {
    execFileSync(process.execPath, [sendMessageScript, '--payload', payload], {
      stdio: 'pipe',
      timeout: 15000,
    });
    await logLine('post-restart notification sent on attempt ' + attempt + ' (down_wait=' + waitedDown + 'ms up_wait=' + waitedUp + 'ms)');
    process.exit(0);
  } catch (err) {
    await logLine('send-message failed on attempt ' + attempt + ': ' + formatExecError(err));
    if (attempt < sendRetries) {
      await sleep(sendRetryDelayMs);
    }
  }
}

process.exit(1);
`;
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function formatNotificationInstruction({ summary, notifications, followUp = [] }) {
  const items = Array.isArray(notifications) ? notifications.filter(Boolean) : [notifications].filter(Boolean);
  const sections = [`[SYSTEM DIRECTIVE] ${summary}`];

  if (items.length > 0) {
    sections.push(
      items.length === 1
        ? "Send the following user-facing message in Markdown:"
        : "Send the following user-facing messages in Markdown, in order:",
    );
    sections.push(
      items
        .map((notification, index) => {
          const body = renderMessageMarkdown(notification);
          if (items.length === 1) return body;
          return `Notification ${index + 1}:\n${body}`;
        })
        .join('\n\n'),
    );
  }

  const normalizedFollowUp = Array.isArray(followUp)
    ? followUp.map((line) => String(line || '').trim()).filter(Boolean)
    : [];
  if (normalizedFollowUp.length > 0) {
    sections.push(normalizedFollowUp.join('\n'));
  }

  return sections.join('\n\n');
}

function parseNotifyDestinationArgs(args) {
  const channel = typeof args?.channel === 'string' && args.channel.trim()
    ? args.channel.trim().toLowerCase()
    : '';
  const chatId = typeof args?.chat_id === 'string' && args.chat_id.trim()
    ? args.chat_id.trim()
    : '';
  const openId = typeof args?.open_id === 'string' && args.open_id.trim()
    ? args.open_id.trim()
    : '';
  const targetId = typeof args?.target_id === 'string' && args.target_id.trim()
    ? args.target_id.trim()
    : '';
  const targetType = typeof args?.target_type === 'string' && args.target_type.trim()
    ? args.target_type.trim()
    : '';
  const locale = typeof args?.locale === 'string' && args.locale.trim()
    ? args.locale.trim()
    : typeof args?.user_locale === 'string' && args.user_locale.trim()
      ? args.user_locale.trim()
      : typeof args?.language === 'string' && args.language.trim()
        ? args.language.trim()
        : '';
  const hasAny = Boolean(channel || targetId || targetType || chatId || openId);
  if (hasAny) {
    if (chatId) {
      throw new Error('chat_id is no longer supported. Use channel + target_id + target_type.');
    }
    if (openId) {
      throw new Error('open_id is no longer supported. Use channel + target_id + target_type.');
    }
    if (!channel || !targetId || !targetType) {
      throw new Error('channel, target_id, and target_type must be provided together.');
    }
    if (channel === 'feishu' && targetType !== 'chat_id' && targetType !== 'open_id') {
      throw new Error('target_type must be "chat_id" or "open_id" for feishu.');
    }
    return {
      channel,
      target: {
        type: targetType,
        id: targetId,
      },
      ...(locale ? { locale } : {}),
    };
  }

  const directCandidate = normalizeNotifyDestinationValue(
    args?.notifyDestination || args?.notify_destination || null,
  );
  if (directCandidate) {
    return directCandidate;
  }

  const nestedChannel = typeof args?.notify_channel === 'string' && args.notify_channel.trim()
    ? args.notify_channel.trim().toLowerCase()
    : '';
  const nestedTarget = args?.notifyTarget || args?.notify_target || null;
  const nestedCandidate = normalizeNotifyDestinationValue({
    channel: nestedChannel || channel,
    target: nestedTarget,
  });
  if (nestedCandidate) {
    return nestedCandidate;
  }

  const handoffCandidate = normalizeNotifyDestinationValue({
    channel: args?.payment_handoff?.channel,
    target: args?.payment_handoff?.notify_target,
  });
  if (handoffCandidate) {
    return handoffCandidate;
  }

  return null;
}

function parseRequiredMerchantIntegration(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('merchant_integration is required');
  }

  const server = typeof raw.server === 'string' ? raw.server.trim() : '';
  const confirmTool = typeof raw.confirm_tool === 'string' ? raw.confirm_tool.trim() : '';

  if (!server) {
    throw new Error('merchant_integration.server is required');
  }
  if (!confirmTool) {
    throw new Error('merchant_integration.confirm_tool is required');
  }
  if (raw.confirm_args !== undefined && (!raw.confirm_args || typeof raw.confirm_args !== 'object' || Array.isArray(raw.confirm_args))) {
    throw new Error('merchant_integration.confirm_args must be an object');
  }

  return {
    server,
    confirmTool,
    confirmArgs: raw.confirm_args ? cloneJsonValue(raw.confirm_args) : {},
  };
}
async function savePendingMerchantConfirmation(merchantIntegration, sessionId, notifyDestination) {
  const cache = await readPaymentMethodsCache() || {};
  const resolvedNotifyDestination = notifyDestination || getNotifyDestination(cache);
  cache.pendingMerchantConfirmation = {
    server: merchantIntegration.server,
    tool: merchantIntegration.confirmTool,
    args: merchantIntegration.confirmArgs,
    sessionId: typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null,
    notifyDestination: resolvedNotifyDestination ? cloneJsonValue(resolvedNotifyDestination) : null,
    createdAt: new Date().toISOString(),
  };
  await writePaymentMethodsCache(cache);
}

function buildMerchantPaymentHandoff(orderId, sessionId, notifyDestination, triggerSource) {
  if (!notifyDestination?.channel || !notifyDestination?.target?.type || !notifyDestination?.target?.id) {
    throw new Error('merchant handoff requires notifyDestination.channel, notifyDestination.target.type, and notifyDestination.target.id');
  }
  const handoff = {
    order_id: typeof orderId === 'string' && orderId.trim() ? orderId.trim() : null,
    trigger_source: triggerSource,
    channel: notifyDestination.channel,
  };
  if (typeof sessionId === 'string' && sessionId.trim()) {
    handoff.session_id = sessionId.trim();
  }
  handoff.notify_target = {
    type: notifyDestination.target.type,
    id: notifyDestination.target.id,
    ...(notifyDestination.locale ? { locale: notifyDestination.locale } : {}),

  };
  return handoff;
}

function buildMerchantConfirmArgs(merchantContext, paymentHandoff) {
  const args = merchantContext?.args && typeof merchantContext.args === 'object'
    ? cloneJsonValue(merchantContext.args)
    : {};
  args.payment_handoff = paymentHandoff;
  return args;
}

async function overwriteCachedBindingMethods(methods) {
  const cache = await readPaymentMethodsCache() || {};
  const normalizedMethods = normalizePaymentMethods(methods);
  const defaultMethod =
    normalizedMethods.find((method) => method.isDefault) ||
    normalizedMethods[0] ||
    null;

  cache.paymentMethods = normalizedMethods;
  cache.defaultPaymentMethodId = defaultMethod?.paymentInstrumentId || null;
  cache.cachedAt = new Date().toISOString();

  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

async function writePaymentFlowState(key, state) {
  const cache = normalizeCache(await readPaymentMethodsCache() || {});
  cache.paymentFlowStates[key] = state;
  await writePaymentMethodsCache(cache);
}

function formatPaymentMethodDisplay(method) {
  if (!method) return 'Unknow';
  const brand = method.cardBrand || method.cardScheme || method.paymentMethodType || method.paymentInstrumentType || "Unknow";
  const last4 = method.cardLast4 || method.cardLastFour || null;
  const walletAccountTag = method.walletAccountTag || method.wallet?.accountTag || null;
  if (walletAccountTag) {
    return `${String(brand).toUpperCase()} ${walletAccountTag}`;
  }
  return `${String(brand).toUpperCase()} ••••${last4 || "****"}`;
}

function formatAmountNumber(amount) {
  const parsed = Number(amount);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : "N/A";
}

function formatAmountWithCurrency(amount, currency = "USD") {
  const formatted = formatAmountNumber(amount);
  return formatted === "N/A" ? "N/A" : `${formatted} ${currency}`;
}

function formatAmountWithSymbol(amount, currency = "USD", symbol = "") {
  const formatted = formatAmountNumber(amount);
  if (formatted === "N/A") return "N/A";
  const resolvedSymbol = symbol || (currency === "USD" ? "$" : "");
  return resolvedSymbol ? `${resolvedSymbol}${formatted}` : `${formatted} ${currency}`;
}

function buildPaymentSuccessNotification({ amountDisplay, cardDisplay, orderId }) {
  return createMessageRequest({
    messageKey: 'payment.success',
    vars: {
      amountDisplay,
      cardDisplay,
      orderId,
    },
  });
}

function buildRiskRejectNotification({ amountDisplay, message, orderId }) {
  return createMessageRequest({
    messageKey: 'payment.risk_reject',
    vars: {
      amountDisplay,
      message,
      orderId,
    },
  });
}

function buildPaymentFailureNotification({ amountDisplay, orderId, failureReason }) {
  return createMessageRequest({
    messageKey: 'payment.failure',
    vars: {
      amountDisplay,
      orderId,
      failureReason,
    },
  });
}

function formatCachedCardDisplay(method) {
  const brand = method.cardBrand || method.paymentMethodType || "Unknow";
  if (method.walletAccountTag) {
    return `${String(brand).toUpperCase()} ${method.walletAccountTag}`;
  }
  const last4 = method.cardLast4 || method.cardLastFour || "****";
  return `${String(brand).toUpperCase()} ••••${last4}`;
}

function formatPaymentCardDisplay(paymentInstrumentId, data, cache) {
  if (Array.isArray(cache?.paymentMethods)) {
    const matchedMethod = cache.paymentMethods.find(
      (method) => method.paymentInstrumentId === paymentInstrumentId,
    );
    if (matchedMethod) {
      return formatCachedCardDisplay(matchedMethod);
    }
  }

  const walletAccountTag = data.walletAccountTag || data.wallet?.accountTag || null;
  if (data.cardBrand || data.cardLast4 || walletAccountTag) {
    const brand = data.cardBrand || data.cardScheme || data.paymentMethodType || data.paymentInstrumentType || "Unknow";
    if (walletAccountTag) {
      return `${String(brand).toUpperCase()} ${walletAccountTag}`;
    }
    return `${String(brand).toUpperCase()} ••••${data.cardLast4 || data.cardLastFour || "****"}`;
  }

  if (data.paymentMethod) {
    const pm = data.paymentMethod;
    if (pm.cardBrand || pm.cardLast4 || pm.walletAccountTag || pm.wallet?.accountTag) {
      return formatCachedCardDisplay({
        paymentMethodType: pm.paymentMethodType || pm.paymentInstrumentType,
        cardBrand: pm.cardBrand || pm.cardScheme,
        cardLast4: pm.cardLast4 || pm.cardLastFour,
        walletAccountTag: pm.walletAccountTag || pm.wallet?.accountTag,
      });
    }
    return `${pm.paymentMethodType || pm.paymentInstrumentType || "Unknow"} ${paymentInstrumentId}`.trim();
  }
  return "N/A";
}

function resolveChargeCardDisplay({ paymentInstrumentId, channelPaymentResponse, paySuccessInfo, fallbackCard, paymentMethodType, cache }) {
  const card = channelPaymentResponse?.paymentMethodDetail?.card || {};
  return formatPaymentCardDisplay(paymentInstrumentId, {
    paymentMethodType,
    cardBrand: card.cardBrand || paySuccessInfo?.cardBrand || fallbackCard?.cardBrand || null,
    cardScheme: card.cardScheme || paySuccessInfo?.cardScheme || fallbackCard?.cardScheme || null,
    cardLast4: card.last4No || paySuccessInfo?.cardLast4 || fallbackCard?.cardLast4 || null,
    cardLastFour: fallbackCard?.cardLastFour || null,
    walletAccountTag:
      card.walletAccountTag ||
      channelPaymentResponse?.paymentMethodDetail?.walletAccountTag ||
      paySuccessInfo?.walletAccountTag ||
      fallbackCard?.walletAccountTag ||
      null,
    paymentMethod: {
      paymentMethodType:
        card.paymentMethodType ||
        paySuccessInfo?.paymentMethodType ||
        fallbackCard?.paymentMethodType ||
        paymentMethodType ||
        null,
      paymentInstrumentType:
        card.paymentInstrumentType ||
        paySuccessInfo?.paymentInstrumentType ||
        fallbackCard?.paymentInstrumentType ||
        null,
      cardBrand: card.cardBrand || paySuccessInfo?.cardBrand || fallbackCard?.cardBrand || null,
      cardScheme: card.cardScheme || paySuccessInfo?.cardScheme || fallbackCard?.cardScheme || null,
      cardLast4: card.last4No || paySuccessInfo?.cardLast4 || fallbackCard?.cardLast4 || null,
      cardLastFour: fallbackCard?.cardLastFour || null,
      walletAccountTag:
        card.walletAccountTag ||
        channelPaymentResponse?.paymentMethodDetail?.walletAccountTag ||
        paySuccessInfo?.walletAccountTag ||
        fallbackCard?.walletAccountTag ||
        null,
    },
  }, cache);
}

// ------------------------------------------------------------------
// CLINK CLI HELPER
// ------------------------------------------------------------------
// Every Clink operation goes through the vendored clink-cli bundle. Credentials
// are passed via the child process env (names match clink-cli exactly). The API
// base URL is owned by clink-cli itself: it resolves CLINK_BASE_URL (env) >
// ~/.clink-cli/config.json baseUrl > production default. The skill never pins it,
// so a CLINK_BASE_URL env var (e.g. the UAT runtime) transparently overrides it.

class ClinkCliError extends Error {
  constructor({ message, type, code, exitCode, raw }) {
    super(message || `clink-cli error (exit ${exitCode})`);
    this.name = 'ClinkCliError';
    this.type = type || 'cli_error';
    this.code = code ?? null;
    this.exitCode = exitCode ?? null;
    this.raw = raw;
  }
}

// Scan text for the last line that parses as a JSON object (the CLI may emit
// progress lines before the machine-readable envelope).
function parseClinkEnvelope(text) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {
      // keep scanning earlier lines
    }
  }
  return null;
}

async function runClinkCli(args, { timeoutMs = 30000 } = {}) {
  const env = await getPaymentEnv();
  const childEnv = { ...process.env };
  if (env.CLINK_CUSTOMER_ID) childEnv.CLINK_CUSTOMER_ID = env.CLINK_CUSTOMER_ID;
  if (env.CLINK_CUSTOMER_API_KEY) childEnv.CLINK_CUSTOMER_API_KEY = env.CLINK_CUSTOMER_API_KEY;
  // Base URL is owned by clink-cli. A real CLINK_BASE_URL env var (already in
  // process.env) takes precedence; otherwise an openclaw.json skill-env override
  // is applied; otherwise clink-cli falls back to its own config / default.
  if (!childEnv.CLINK_BASE_URL && env.CLINK_BASE_URL) childEnv.CLINK_BASE_URL = env.CLINK_BASE_URL;

  const fullArgs = [CLINK_CLI_BUNDLE, ...args];
  if (!fullArgs.includes('--format')) fullArgs.push('--format', 'json');

  const { stdout, stderr, exitCode } = await new Promise((resolve) => {
    const child = spawn(process.execPath, fullArgs, { env: childEnv });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve({ stdout: out, stderr: err, exitCode: code });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(6); // NETWORK/timeout
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (spawnErr) => { err += `\n${spawnErr.message}`; clearTimeout(timer); finish(1); });
    child.on('close', (code) => { clearTimeout(timer); finish(code ?? 0); });
  });

  // Success envelope is authoritative even when the CLI exits non-zero
  // (e.g. exit 7 / 3-D Secure still returns the charge data on stdout).
  const okEnvelope = parseClinkEnvelope(stdout);
  if (okEnvelope && okEnvelope.ok === true) {
    return okEnvelope.data;
  }

  const errEnvelope = parseClinkEnvelope(stderr) || okEnvelope;
  const errorInfo = errEnvelope && errEnvelope.ok === false ? (errEnvelope.error || {}) : {};
  await logRequest('clink-cli', { args, exitCode }, { stderr: stderr.slice(0, 2000) });
  throw new ClinkCliError({
    message: errorInfo.message || stderr.trim() || `clink-cli ${args[0] || ''} failed (exit ${exitCode})`,
    type: errorInfo.type,
    code: errorInfo.code,
    exitCode,
    raw: errEnvelope,
  });
}

// ------------------------------------------------------------------
// BINDING LINK HELPER
// ------------------------------------------------------------------
async function fetchBindingData() {
  const env = await getPaymentEnv();
  if (!env.CLINK_CUSTOMER_API_KEY || !env.CLINK_CUSTOMER_ID) {
    throw new Error("Wallet not initialized. Please run initialize_wallet first.");
  }

  const requestPayload = {
    customerId: env.CLINK_CUSTOMER_ID,
    hasCustomerApiKey: !!env.CLINK_CUSTOMER_API_KEY,
  };
  // card binding-link refreshes the cached payment methods. The event pump owns
  // async card-bound delivery, so never let the CLI watch here (--no-watch).
  const data = await runClinkCli(['card', 'binding-link', '--no-watch']);
  await logRequest('fetchBindingData/bindingLink', requestPayload, data);

  const bindingUrl = data.bindingUrl || "";
  let bindingToken = "";
  if (bindingUrl.includes("#")) {
    bindingToken = bindingUrl.split("#")[1];
  }

  try {
    const cache = normalizeCache(await readPaymentMethodsCache() || {});
    if (bindingUrl) cache.bindingUrl = bindingUrl;
    if (bindingToken) cache.bindingToken = bindingToken;
    cache.cachedAt = new Date().toISOString();
    await writePaymentMethodsCache(cache);
  } catch (err) {
    await logError('fetchBindingData/cacheBindingUrl', err);
  }

  try {
    await overwriteCachedBindingMethods(data.paymentMethodsVoList || []);
  } catch (err) {
    await logError('fetchBindingData/overwriteCachedBindingMethods', err);
  }

  return { bindingUrl, bindingToken, methods: data.paymentMethodsVoList || [], env };
}

function buildRedirectUrl(bindingUrl, redirectPath) {
  const targetPath = redirectPath.startsWith("/") ? redirectPath : `/${redirectPath}`;
  try {
    const url = new URL(bindingUrl);
    url.searchParams.set("redirectUrl", targetPath);
    return url.toString();
  } catch {
    const sep = bindingUrl.includes("?") ? "&" : "?";
    return `${bindingUrl}${sep}redirectUrl=${encodeURIComponent(targetPath)}`;
  }
}

function buildBareDomainUrl(bindingUrl) {
  try {
    return new URL(bindingUrl).origin;
  } catch {
    return bindingUrl;
  }
}

// Risk-rules page URL comes from clink-cli `risk link` (the canonical /risk-rules-setup
// deep link). The CLI derives the agent domain from the resolved API base (CLINK_BASE_URL,
// forwarded by runClinkCli), so production / sandbox / UAT all resolve correctly without a
// flag. No network request; --no-watch because the mailbox event pump owns async
// risk_rule.updated delivery.
async function buildRiskRulesNotification() {
  const data = await runClinkCli(['risk', 'link', '--no-watch']);
  return createMessageRequest({
    messageKey: 'risk.rules_link',
    vars: { riskUrl: data.url || '' },
  });
}

function normalizeCardNetwork(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isVisaPaymentMethod(method) {
  if (!method || typeof method !== 'object') return false;
  const candidates = [
    method.cardBrand,
    method.cardScheme,
    method.network,
    method.cardNetwork,
    method.paymentNetwork,
    method.paymentMethodType,
    method.paymentInstrumentType,
    method.paymentMethod?.cardBrand,
    method.paymentMethod?.cardScheme,
    method.paymentMethod?.network,
  ];
  return candidates.some((candidate) => normalizeCardNetwork(candidate) === 'visa');
}

function hasPaymentMethodNetworkSignal(method) {
  if (!method || typeof method !== 'object') return false;
  return [
    method.cardBrand,
    method.cardScheme,
    method.network,
    method.cardNetwork,
    method.paymentNetwork,
    method.paymentMethod?.cardBrand,
    method.paymentMethod?.cardScheme,
    method.paymentMethod?.network,
  ].some((candidate) => Boolean(normalizeCardNetwork(candidate)));
}

function normalizePaymentMethodType(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
}

function isCardLikePaymentMethod(method) {
  if (!method || typeof method !== 'object') return false;
  const typeCandidates = [
    method.paymentMethodType,
    method.paymentInstrumentType,
    method.paymentMethod?.paymentMethodType,
    method.paymentMethod?.paymentInstrumentType,
  ];
  if (typeCandidates.some((candidate) => ['card', 'credit_card', 'debit_card'].includes(normalizePaymentMethodType(candidate)))) {
    return true;
  }
  return [
    method.cardBrand,
    method.cardScheme,
    method.cardLast4,
    method.cardLastFour,
    method.cardNetwork,
    method.paymentNetwork,
    method.paymentMethod?.cardBrand,
    method.paymentMethod?.cardScheme,
    method.paymentMethod?.cardLast4,
    method.paymentMethod?.cardLastFour,
  ].some((candidate) => typeof candidate === 'string' && candidate.trim());
}

function shouldFailClosedForUnknownCardNetwork(method) {
  return isCardLikePaymentMethod(method) && !hasPaymentMethodNetworkSignal(method);
}

function isVisaRegistrationCompletePaymentMethod(method) {
  return isVisaRegistrationSucceeded(method);
}

function findPaymentMethodById(methods, paymentInstrumentId) {
  if (!paymentInstrumentId) return null;
  return normalizePaymentMethods(methods).find((method) => method.paymentInstrumentId === paymentInstrumentId) || null;
}

function buildVicRegistrationUrl(bindingUrl, paymentInstrumentId) {
  return buildRedirectUrl(bindingUrl, `passkey-auth/${encodeURIComponent(paymentInstrumentId)}?type=visa`);
}

function buildPurchaseInstructionPasskeyUrl(bindingUrl, paymentInstrumentId, instructionId) {
  return buildRedirectUrl(bindingUrl, `passkey-auth/${encodeURIComponent(paymentInstrumentId)}?type=visa&instructionId=${encodeURIComponent(instructionId)}`);
}

async function resolvePurchaseInstructionBindingUrl() {
  const cache = normalizeCache(await readPaymentMethodsCache() || {});
  if (typeof cache.bindingUrl === 'string' && cache.bindingUrl.trim()) {
    return { bindingUrl: cache.bindingUrl.trim(), cache };
  }

  try {
    const bindingData = await fetchBindingData();
    const freshCache = normalizeCache(await readPaymentMethodsCache() || cache);
    const bindingUrl = bindingData.bindingUrl || freshCache.bindingUrl || '';
    if (!bindingUrl) {
      throw new Error('bindingUrl missing from bindingLink response');
    }
    return { bindingUrl, cache: freshCache };
  } catch (error) {
    await logError('resolvePurchaseInstructionBindingUrl', error);
    if (typeof cache.bindingUrl === 'string' && cache.bindingUrl.trim()) {
      return { bindingUrl: cache.bindingUrl.trim(), cache };
    }
    throw error;
  }
}

function buildVicRegistrationNotification({ paymentInstrumentId, cardDisplay, passkeyUrl }) {
  return createMessageRequest({
    messageKey: 'payment.vic_registration_required',
    vars: {
      paymentInstrumentId,
      cardDisplay,
      passkeyUrl,
    },
  });
}

function buildPurchaseInstructionAuthNotification({
  paymentInstrumentId,
  instructionId,
  cardDisplay,
  title,
  description,
  effectiveUntilTime,
  mandates,
  shippingAddress,
  passkeyUrl,
}) {
  return createMessageRequest({
    messageKey: 'payment.purchase_instruction_auth_required',
    vars: {
      paymentInstrumentId,
      instructionId,
      cardDisplay,
      title,
      description,
      effectiveUntilTime,
      mandates,
      shippingAddress,
      passkeyUrl,
    },
  });
}

function buildVicInstructionRequiredDirective(paymentMethod) {
  return `[SYSTEM DIRECTIVE] Account pre-check PASSED: selected Visa card is VIC-enabled.
Do NOT call clink_pay for this Visa card yet.
Continue the VIC purchase instruction flow through prepare_visa_purchase_instruction once the user's spend scope is available. That state machine must list ACTIVE instructions with status=ACTIVE and paymentInstrumentId=${paymentMethod.paymentInstrumentId} before any draft creation. Do NOT manually call create_purchase_instruction before the state machine list step.
The state machine only reuses ACTIVE instructions whose paymentInstrumentId exactly matches ${paymentMethod.paymentInstrumentId}, then matches by amountLimit, currencyCode, merchant/category/MCC, merchant name/title/description, and expiry. If no matching instruction is returned for this paymentInstrumentId, it creates a draft with the user's supplied spend scope, then waits for the user's Passkey result before sign_purchase_instruction.
Payment Instrument ID: ${paymentMethod.paymentInstrumentId}`;
}

function buildUnknownPaymentMethodNetworkDirective({ paymentInstrumentId, errorMessage = '' }) {
  return `[SYSTEM DIRECTIVE] Account pre-check BLOCKED: selected card network could not be confirmed.
The payment method looks like a card, but cardBrand/cardScheme/network are missing. Because the skill cannot prove this card is non-Visa, it must not use the normal charge path.
Do NOT call clink_pay for this payment method until payment methods refresh successfully and the card network is known.
Payment Instrument ID: ${paymentInstrumentId || 'N/A'}${errorMessage ? `\nRefresh error: ${errorMessage}` : ''}`;
}

async function ensureVisaVicReadyForUse({ paymentInstrumentId, selectedMethod = null, notifyDestination = null, context = 'payment' }) {
  let method = selectedMethod ? normalizePaymentMethods([selectedMethod])[0] : null;
  let bindingUrl = '';
  let latestMethods = [];

  if (!method || !hasPaymentMethodNetworkSignal(method) || (isVisaPaymentMethod(method) && !isVisaRegistrationCompletePaymentMethod(method))) {
    try {
      const bindingData = await fetchBindingData();
      bindingUrl = bindingData.bindingUrl || '';
      latestMethods = normalizePaymentMethods(bindingData.methods || []);
      method = findPaymentMethodById(latestMethods, paymentInstrumentId) || method;
    } catch (error) {
      await logError(`${context}/vic_registration_refresh`, error);
      if (!method) {
        return {
          blocked: true,
          response: `Failed to resolve payment method for VIC registration: ${error.message}`,
        };
      }
      if (shouldFailClosedForUnknownCardNetwork(method)) {
        return {
          blocked: true,
          route: 'card_network_unknown',
          paymentMethod: method,
          response: buildUnknownPaymentMethodNetworkDirective({
            paymentInstrumentId: method.paymentInstrumentId || paymentInstrumentId,
            errorMessage: error.message,
          }),
        };
      }
    }
  }

  if (shouldFailClosedForUnknownCardNetwork(method)) {
    return {
      blocked: true,
      route: 'card_network_unknown',
      paymentMethod: method,
      response: buildUnknownPaymentMethodNetworkDirective({
        paymentInstrumentId: method.paymentInstrumentId || paymentInstrumentId,
      }),
    };
  }

  if (!method || !isVisaPaymentMethod(method)) {
    return { blocked: false, route: 'legacy', paymentMethod: method };
  }

  if (isVisaRegistrationCompletePaymentMethod(method)) {
    return {
      blocked: true,
      route: 'vic_instruction_required',
      paymentMethod: method,
      response: buildVicInstructionRequiredDirective(method),
    };
  }

  if (!bindingUrl) {
    try {
      const bindingData = await fetchBindingData();
      bindingUrl = bindingData.bindingUrl || '';
      latestMethods = normalizePaymentMethods(bindingData.methods || []);
      method = findPaymentMethodById(latestMethods, paymentInstrumentId) || method;
    } catch (error) {
      await logError(`${context}/vic_registration_link`, error);
      return {
        blocked: true,
        response: `Failed to generate VIC registration link: ${error.message}`,
      };
    }
  }

  if (isVisaRegistrationCompletePaymentMethod(method)) {
    return {
      blocked: true,
      route: 'vic_instruction_required',
      paymentMethod: method,
      response: buildVicInstructionRequiredDirective(method),
    };
  }

  const cache = normalizeCache(await readPaymentMethodsCache() || {});
  const effectiveNotifyDestination = notifyDestination || getNotifyDestination(cache);
  const passkeyUrl = buildVicRegistrationUrl(bindingUrl, paymentInstrumentId);
  const cardDisplay = formatPaymentMethodDisplay(method);
  const vicState = resolveVicRegistrationState({
    cache,
    paymentInstrumentId,
    cardDisplay,
    notifyDestination: effectiveNotifyDestination,
    now: Date.now(),
    ttlMs: VIC_REGISTRATION_STATE_TTL_MS,
  });
  await writePaymentFlowState(vicState.key, vicState.state);
  const notification = buildVicRegistrationNotification({
    paymentInstrumentId,
    cardDisplay,
    passkeyUrl,
  });
  const followUp = [
    'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
    'Do NOT create a purchase instruction and do NOT charge until this same Visa payment method appears with visaRegistrationSucceeded=true.',
    'The background event monitor will deliver the VIC-ready notification automatically; or refresh payment methods until visaRegistrationSucceeded=true, then continue the VIC purchase instruction flow.',
  ];

  if (!vicState.shouldNotify) {
    return {
      blocked: true,
      route: 'vic_registration_pending',
      paymentMethod: method,
      response: buildDirectSendDirective({
        summary: 'VIC registration is already pending for this Visa card.',
        webhookWaitMessage: 'The background event monitor will deliver the VIC-ready notification automatically; or refresh payment methods until visaRegistrationSucceeded=true, then continue the VIC purchase instruction flow.',
        suffix: 'The VIC registration notification was already sent for this paymentInstrumentId. Do NOT send another card and do NOT retry clink_pay until the same Visa payment method appears with visaRegistrationSucceeded=true.',
      }),
    };
  }

  if (effectiveNotifyDestination) {
    try {
      sendNotificationDirect(effectiveNotifyDestination, notification);
      return {
        blocked: true,
        route: 'vic_registration_required',
        paymentMethod: method,
        response: buildDirectSendDirective({
          summary: 'VIC registration link delivered.',
          webhookWaitMessage: 'The background event monitor will deliver the VIC-ready notification automatically; or refresh payment methods until visaRegistrationSucceeded=true, then continue the VIC purchase instruction flow.',
        }),
      };
    } catch (error) {
      await logError(`${context}/vic_registration_direct_send`, error);
    }
  }

  return {
    blocked: true,
    route: 'vic_registration_required',
    paymentMethod: method,
    response: formatNotificationInstruction({
      summary: 'VIC registration is required before this Visa card can be used.',
      notifications: notification,
      followUp,
    }),
  };
}

// ------------------------------------------------------------------
// TOOL IMPLEMENTATIONS
// ------------------------------------------------------------------

async function handle_initialize_wallet(args) {
  if (!args || !args.email) {
    return "ERROR: initialize_wallet requires 'email'.";
  }

  try {
    const cache = await readPaymentMethodsCache() || {};
    const notifyDestination = parseNotifyDestinationArgs(args);
    if (notifyDestination) {
      cache.notifyDestination = notifyDestination;
    }
    cache.email = args.email;
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    cache.cachedAt = new Date().toISOString();
    await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    await logError('initialize_wallet/saveInitialCache', err);
    return `Failed to save to cache: ${err.message}`;
  }

  try {
    const data = await runClinkCli(['wallet', 'init', '--email', args.email, '--name', args.name || 'Agent User']);
    const customerId = data?.customerId;
    let customerAPIKey = data?.customerAPIKey ?? data?.customerApiKey;
    // Newer clink-cli omits the API key from `wallet init` stdout (it persists it to
    // ~/.clink-cli/config.json). Recover it from there so the skill env can authenticate later calls.
    if (!customerAPIKey) {
      customerAPIKey = await readClinkCliCustomerApiKey(data?.profile);
    }
    await logRequest('initialize_wallet/walletInit', { email: args.email }, { customerId, hasKey: !!customerAPIKey });

    try {
      const cache = await readPaymentMethodsCache() || {};
      if (customerId) cache.customerId = customerId;
      if (customerAPIKey) cache.customerAPIKey = customerAPIKey;
      cache.cachedAt = new Date().toISOString();
      await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
      await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
    } catch (err) {
      await logError('initialize_wallet/saveCustomerData', err);
      return `Failed to save customer data to cache: ${err.message}`;
    }

    // Mirror credentials into the skill env block so getPaymentEnv (and thus
    // every runClinkCli child) resolves them on later turns.
    try {
      const envUpdates = {};
      if (customerId) envUpdates.CLINK_CUSTOMER_ID = customerId;
      if (customerAPIKey) envUpdates.CLINK_CUSTOMER_API_KEY = customerAPIKey;
      if (args.email) envUpdates.CLINK_USER_EMAIL = args.email;
      if (Object.keys(envUpdates).length) await updatePaymentEnv(envUpdates);
    } catch (err) {
      await logError('initialize_wallet/updateEnv', err);
    }

    // Start the mailbox event pump (idempotent). It replaces the old webhook
    // receiver + poll fallback as the single async-completion delivery path.
    ensureEventPumpRunning();

    return `Clink 账户 Bootstrap 成功。
[SYSTEM DIRECTIVE]
Wallet bootstrap completed for ${args.email}. Customer ID: ${customerId}.

You MUST NOT output ANY text to the user yet.
You MUST IMMEDIATELY call the "get_binding_link" tool to check for existing payment methods.

After calling "get_binding_link", use the returned Markdown notification content for the current channel.
If "get_binding_link" returns a DIRECT_SEND system directive, do NOT send any additional markdown or notification in this turn.
Otherwise, follow its returned notification instruction exactly once.`;
  } catch (err) {
    await logError('initialize_wallet', err);
    return `Failed to initialize wallet: ${err.message}`;
  }
}

async function handle_get_wallet_status() {
  const env = await getPaymentEnv();
  if (!env.CLINK_CUSTOMER_ID) {
    return "Wallet not initialized.";
  }
  return `Wallet Status:\nCustomer ID: ${env.CLINK_CUSTOMER_ID}\nEmail: ${env.CLINK_USER_EMAIL}\nHas API Key: ${!!env.CLINK_CUSTOMER_API_KEY}`;
}

async function handle_get_binding_link(args = {}) {
  try {
    const { bindingUrl, bindingToken, methods, env } = await fetchBindingData();
    const cache = await readPaymentMethodsCache() || {};
    let requestNotifyDestination = null;
    try {
      requestNotifyDestination = parseNotifyDestinationArgs(args);
    } catch (error) {
      return `ERROR: ${error.message}`;
    }
    if (requestNotifyDestination) {
      cache.notifyDestination = requestNotifyDestination;
      await writePaymentMethodsCache(cache);
    }
    const notifyDestination = requestNotifyDestination || getNotifyDestination(cache);

    if (methods.length === 0) {
      const setupUrl = buildBareDomainUrl(bindingUrl);
      const notification = createMessageRequest({
        messageKey: 'payment.method.binding_required',
        vars: {
          email: env.CLINK_USER_EMAIL || 'N/A',
          setupUrl,
        },
      });
      let fallbackReason = 'missing_notify_destination';
      if (notifyDestination) {
        try {
          sendNotificationDirect(notifyDestination, notification);
          return buildDirectSendDirective({
            summary: 'Binding notification delivered.',
            webhookWaitMessage: 'The background event monitor will deliver the payment_method.added notification automatically when binding completes.',
            suffix: `Extracted Binding Token for future use: ${bindingToken}`,
          });
        } catch (err) {
          fallbackReason = 'direct_send_failed';
          await logError('get_binding_link/direct_send_unbound', err);
        }
      }
      await logNotificationFallback('get_binding_link/unbound', { cache, message: notification, reason: fallbackReason });
      return `Clink 账户检测：尚未绑定支付方式。
${formatNotificationInstruction({
  summary: 'No payment methods bound.',
  notifications: notification,
  followUp: [
    'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
    'The background event monitor will deliver the payment_method.added notification automatically when binding completes.',
    '',
    `Extracted Binding Token for future use: ${bindingToken}`,
  ],
})}`;
    } else {
      const defaultCard = methods.find(m => m.isDefault) || methods[0];
      const cardDisplay = formatPaymentMethodDisplay(defaultCard);
      const notification = createMessageRequest({
        messageKey: 'payment.method.bound_detected',
        vars: {
          cardDisplay,
          email: env.CLINK_USER_EMAIL || 'N/A',
        },
      });
      const riskNotification = await buildRiskRulesNotification();
      let fallbackReason = 'missing_notify_destination';
      let statusNotificationSent = false;
      if (notifyDestination) {
        try {
          sendNotificationDirect(notifyDestination, notification);
          statusNotificationSent = true;
          sendNotificationDirect(notifyDestination, riskNotification);
          return `[SYSTEM DIRECTIVE] DIRECT_SEND: The payment-method status notification and risk-rules notification have been sent. Do NOT send another card.

Current Payment Methods: ${JSON.stringify(methods)}
Extracted Binding Token for future use: ${bindingToken}`;
        } catch (err) {
          fallbackReason = 'direct_send_failed';
          await logError(
            statusNotificationSent
              ? 'get_binding_link/direct_send_bound_risk_followup'
              : 'get_binding_link/direct_send_bound',
            err,
          );
        }
      }
      if (statusNotificationSent) {
        await logNotificationFallback('get_binding_link/bound_risk_followup', {
          cache,
          message: riskNotification,
          reason: 'direct_send_failed_after_status_notification',
        });
        return formatNotificationInstruction({
          summary: 'Payment methods found. The bound-card notification was already sent; send only the risk-rules notification.',
          notifications: riskNotification,
          followUp: [
            'Do NOT resend the payment-method status notification; it has already been delivered.',
            'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
            '',
            `Current Payment Methods: ${JSON.stringify(methods)}`,
            `Extracted Binding Token for future use: ${bindingToken}`,
          ],
        });
      }

      await logNotificationFallback('get_binding_link/bound', { cache, message: notification, reason: fallbackReason });
      return `💳 检测到已绑定的支付方式，并附带风控规则入口。
${formatNotificationInstruction({
  summary: 'Payment methods found.',
  notifications: [notification, riskNotification],
  followUp: [
    'Send both user-facing notifications in order. Do NOT call get_risk_rules_link again in this turn.',
    '',
    `Current Payment Methods: ${JSON.stringify(methods)}`,
    `Extracted Binding Token for future use: ${bindingToken}`,
  ],
})}`;
    }
  } catch (err) {
    await logError('get_binding_link', err);
    return `Failed to get binding link: ${err.message}`;
  }
}

async function handle_get_risk_rules_link(args = {}) {
  try {
    const env = await getPaymentEnv();
    if (!env.CLINK_CUSTOMER_API_KEY || !env.CLINK_CUSTOMER_ID) {
      throw new Error("Wallet not initialized. Please run initialize_wallet first.");
    }
    const notification = await buildRiskRulesNotification();
    const cache = await readPaymentMethodsCache() || {};
    let requestNotifyDestination = null;
    try {
      requestNotifyDestination = parseNotifyDestinationArgs(args);
    } catch (error) {
      return `ERROR: ${error.message}`;
    }
    if (requestNotifyDestination) {
      cache.notifyDestination = requestNotifyDestination;
      await writePaymentMethodsCache(cache);
    }
    const notifyDestination = requestNotifyDestination || getNotifyDestination(cache);
    let fallbackReason = 'missing_notify_destination';

    if (notifyDestination) {
      try {
        sendNotificationDirect(notifyDestination, notification);
        return buildDirectSendDirective({
          summary: 'Risk rules link generated.',
          webhookWaitMessage: 'The background event monitor will deliver the risk_rule.updated notification automatically when the change completes.',
        });
      } catch (err) {
        fallbackReason = 'direct_send_failed';
        await logError('get_risk_rules_link/direct_send', err);
      }
    }

    await logNotificationFallback('get_risk_rules_link', { cache, message: notification, reason: fallbackReason });
    return formatNotificationInstruction({
      summary: 'Risk rules link generated.',
      notifications: notification,
      followUp: [
        'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
        'The background event monitor will deliver the risk_rule.updated notification automatically when the change completes.',
      ],
    });
  } catch (err) {
    await logError('get_risk_rules_link', err);
    return `Failed to get risk rules link: ${err.message}`;
  }
}

async function handle_get_payment_method_setup_link(args = {}) {
  try {
    const { bindingUrl, env, methods } = await fetchBindingData();
    const setupUrl = buildBareDomainUrl(bindingUrl);
    const notification = createMessageRequest({
      messageKey: 'payment.method.setup_link',
      vars: {
        email: env.CLINK_USER_EMAIL || 'N/A',
        setupUrl,
      },
    });
    const cache = await readPaymentMethodsCache() || {};
    let requestNotifyDestination = null;
    try {
      requestNotifyDestination = parseNotifyDestinationArgs(args);
    } catch (error) {
      return `ERROR: ${error.message}`;
    }
    if (requestNotifyDestination) {
      cache.notifyDestination = requestNotifyDestination;
      await writePaymentMethodsCache(cache);
    }
    const notifyDestination = requestNotifyDestination || getNotifyDestination(cache);
    let fallbackReason = 'missing_notify_destination';

    if (notifyDestination) {
      try {
        sendNotificationDirect(notifyDestination, notification);
        return buildDirectSendDirective({
          summary: 'Payment method setup link generated.',
          webhookWaitMessage: 'The background event monitor will deliver the payment_method.added notification automatically when setup completes.',
        });
      } catch (err) {
        fallbackReason = 'direct_send_failed';
        await logError('get_payment_method_setup_link/direct_send', err);
      }
    }

    await logNotificationFallback('get_payment_method_setup_link', { cache, message: notification, reason: fallbackReason });
    return formatNotificationInstruction({
      summary: 'Payment method setup link generated.',
      notifications: notification,
      followUp: [
        'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
        'The background event monitor will deliver the payment_method.added notification automatically when setup completes.',
      ],
    });
  } catch (err) {
    await logError('get_payment_method_setup_link', err);
    return `Failed to get payment method setup link: ${err.message}`;
  }
}

async function handle_get_payment_method_modify_link(args = {}) {
  try {
    const { bindingUrl, methods } = await fetchBindingData();
    const modifyUrl = buildBareDomainUrl(bindingUrl);
    const defaultCard = methods.find(m => m.isDefault);
    const notification = createMessageRequest({
      messageKey: 'payment.method.manage_link',
      vars: {
        defaultCardDisplay: defaultCard ? formatPaymentMethodDisplay(defaultCard) : '未设置',
        methodCount: methods.length,
        manageUrl: modifyUrl,
      },
    });
    const cache = await readPaymentMethodsCache() || {};
    let requestNotifyDestination = null;
    try {
      requestNotifyDestination = parseNotifyDestinationArgs(args);
    } catch (error) {
      return `ERROR: ${error.message}`;
    }
    if (requestNotifyDestination) {
      cache.notifyDestination = requestNotifyDestination;
      await writePaymentMethodsCache(cache);
    }
    const notifyDestination = requestNotifyDestination || getNotifyDestination(cache);
    let fallbackReason = 'missing_notify_destination';

    if (notifyDestination) {
      try {
        sendNotificationDirect(notifyDestination, notification);
        return buildDirectSendDirective({
          summary: 'Payment method management link generated.',
          webhookWaitMessage: 'The background event monitor will deliver the payment_method.added notification automatically when the change completes.',
        });
      } catch (err) {
        fallbackReason = 'direct_send_failed';
        await logError('get_payment_method_modify_link/direct_send', err);
      }
    }

    await logNotificationFallback('get_payment_method_modify_link', { cache, message: notification, reason: fallbackReason });
    return formatNotificationInstruction({
      summary: 'Payment method management link generated.',
      notifications: notification,
      followUp: [
        'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
        'The background event monitor will deliver the payment_method.added notification automatically when the change completes.',
        '',
        `Current Payment Methods: ${JSON.stringify(methods)}`,
      ],
    });
  } catch (err) {
    await logError('get_payment_method_modify_link', err);
    return `Failed to get payment method modify link: ${err.message}`;
  }
}

async function handle_pre_check_account() {
  const env = await getPaymentEnv();

  if (!env.CLINK_CUSTOMER_API_KEY || !env.CLINK_CUSTOMER_ID) {
    return `[SYSTEM DIRECTIVE] Account pre-check FAILED: Wallet not initialized.
Call initialize_wallet first before attempting to charge.`;
  }

  let defaultCard = null;
  try {
    const cache = await readPaymentMethodsCache();
    if (cache && cache.paymentMethods && cache.paymentMethods.length > 0) {
      const defaultRaw = cache.paymentMethods.find(m => m.paymentInstrumentId === cache.defaultPaymentMethodId)
        || cache.paymentMethods.find(m => m.isDefault)
        || cache.paymentMethods[0];
      defaultCard = defaultRaw;
    } else {
      // Cache empty — fall back to live Clink API (e.g. after reinstall)
      const { methods } = await fetchBindingData();
      if (methods.length > 0) {
        const live = methods.find(m => m.isDefault) || methods[0];
        defaultCard = live; // already camelCase: cardBrand, cardLast4
      }
    }
  } catch (err) {
    await logError('pre_check_account', err);
    return `[SYSTEM DIRECTIVE] Account pre-check FAILED: Could not resolve payment method. Error: ${err.message}`;
  }

  if (!defaultCard) {
    return `[SYSTEM DIRECTIVE] Account pre-check FAILED: No payment method bound.
Call get_payment_method_setup_link to prompt the user to bind a card before charging.`;
  }

  const normalizedDefaultCard = normalizePaymentMethods([defaultCard])[0] || defaultCard;
  const vicGate = await ensureVisaVicReadyForUse({
    paymentInstrumentId: normalizedDefaultCard.paymentInstrumentId,
    selectedMethod: normalizedDefaultCard,
    context: 'pre_check_account',
  });
  if (vicGate.blocked) {
    return vicGate.response;
  }

  return `[SYSTEM DIRECTIVE] Account pre-check PASSED. Ready to charge.
Do NOT send any extra "Clink 账户检测通过" notification to the user for this state.
IMMEDIATELY call clink_pay. Use the user-provided amount if one was specified in this turn; otherwise, use the default amount provided by the merchant.`;
}

async function handle_clink_pay(args) {
  // Validate required fields early — missing amount/currency causes a silent Clink API error
  if (!args || typeof args !== 'object') {
    return "ERROR: clink_pay requires an args object. Missing: merchant_id (or sessionId), amount, currency.";
  }
  if (!args.sessionId && !args.merchant_id) {
    return "ERROR: clink_pay requires 'merchant_id' (direct mode) or 'sessionId' (session mode). Received: " + JSON.stringify(args);
  }
  if (!args.sessionId && (args.amount === undefined || args.amount === null || args.amount === '')) {
    return "ERROR: clink_pay requires 'amount'. Received args: " + JSON.stringify(args);
  }
  let merchantIntegration;
  try {
    merchantIntegration = parseRequiredMerchantIntegration(args.merchant_integration);
  } catch (error) {
    return `ERROR: ${error.message}`;
  }

  let requestNotifyDestination = null;
  try {
    requestNotifyDestination = parseNotifyDestinationArgs(args);
  } catch (error) {
    return `ERROR: ${error.message}`;
  }
  if (requestNotifyDestination) {
    try {
      const cache = normalizeCache(await readPaymentMethodsCache() || {});
      cache.notifyDestination = requestNotifyDestination;
      await writePaymentMethodsCache(cache);
    } catch (error) {
      await logError('clink_pay/saveNotifyDestination', error);
    }
  }

  const env = await getPaymentEnv();
  if (!env.CLINK_CUSTOMER_API_KEY || !env.CLINK_CUSTOMER_ID) {
    return "Wallet not initialized. Please run initialize_wallet first.";
  }

  let piId = args.paymentInstrumentId;
  let pmType = args.paymentMethodType || "CARD";
  let defaultCard = null;

  if (!piId) {
    try {
      const cache = await readPaymentMethodsCache();
      if (cache && cache.paymentMethods && cache.paymentMethods.length > 0) {
        const defaultRaw = cache.paymentMethods.find(m => m.paymentInstrumentId === cache.defaultPaymentMethodId)
          || cache.paymentMethods.find(m => m.isDefault)
          || cache.paymentMethods[0];
        piId = defaultRaw.paymentInstrumentId;
        pmType = defaultRaw.paymentMethodType || pmType;
        defaultCard = defaultRaw;
      } else {
        // Cache empty — fall back to live Clink API (e.g. after reinstall)
        const { methods } = await fetchBindingData();
        if (methods.length > 0) {
          const live = methods.find(m => m.isDefault) || methods[0];
          piId = live.paymentInstrumentId;
          pmType = live.paymentMethodType || live.paymentInstrumentType || pmType;
          defaultCard = live;
        } else {
          return `[SYSTEM DIRECTIVE] No valid payment method found.
Call get_payment_method_setup_link immediately to prompt the user to bind a card.`;
        }
      }
    } catch (err) {
      await logError('clink_pay/fetchPaymentMethod', err);
      return `Failed to fetch default payment method: ${err.message}`;
    }
  }

  const vicGate = await ensureVisaVicReadyForUse({
    paymentInstrumentId: piId,
    selectedMethod: defaultCard,
    notifyDestination: requestNotifyDestination,
    context: 'clink_pay',
  });
  if (vicGate.blocked) {
    return vicGate.response;
  }
  if (vicGate.paymentMethod) {
    defaultCard = vicGate.paymentMethod;
    pmType = vicGate.paymentMethod.paymentMethodType || vicGate.paymentMethod.paymentInstrumentType || pmType;
  }

  const timestamp = Date.now().toString();
  // --no-watch: the event pump is the single mailbox consumer. Without it, a 3DS
  // redirect would make the CLI long-poll the mailbox (up to 15 min) and block.
  const payArgs = ['pay', '--no-watch', '--payment-instrument-id', piId, '--payment-method-type', pmType];
  if (args.sessionId) {
    payArgs.push('--session-id', String(args.sessionId));
  } else {
    payArgs.push('--merchant-id', String(args.merchant_id));
    payArgs.push('--amount', String(args.amount));
    payArgs.push('--currency', args.currency || 'USD');
  }
  if (args.purchaseInstructionId) {
    payArgs.push('--purchase-instruction-id', String(args.purchaseInstructionId));
  }

  try {
    // clink-cli pay exits 7 on a 3-D Secure redirect but still returns the
    // charge data on stdout; runClinkCli returns that data regardless of exit code.
    const data = await runClinkCli(payArgs);
    const workflow = classifyPaymentResponse(data);

    const cache = normalizeCache(await readPaymentMethodsCache() || {});
    const notifyDestination = getNotifyDestination(cache);
    const cpr = data.channelPaymentResponse || {};
    const psi = data.paySuccessInfo || {};
    const status = Number(cpr.status);
    const orderId = psi.orderId || data.orderId || cpr.orderId || null;
    const sessionId = args.sessionId || data.sessionId || data.session_id || null;
    const amountDisplay = formatAmountWithSymbol(
      psi.amount ?? args.amount,
      psi.currency || args.currency || "USD",
      psi.currencySymbol || "",
    );
    const cardDisplay = resolveChargeCardDisplay({
      paymentInstrumentId: piId,
      channelPaymentResponse: cpr,
      paySuccessInfo: psi,
      fallbackCard: defaultCard,
      paymentMethodType: args.paymentMethodType || pmType,
      cache,
    });

    if (workflow.state === PaymentWorkflowState.THREE_DS_REQUIRED) {
      await savePendingMerchantConfirmation(merchantIntegration, sessionId, notifyDestination);
      const redirectUrl = cpr.action?.redirectUrl || "";
      const merchantName = psi.merchantName || args.merchant_id || "商户";
      return formatNotificationInstruction({
        summary: 'Payment requires 3DS verification. Pause the current task until the user completes verification.',
        notifications: createMessageRequest({
          messageKey: 'payment.3ds_required',
          vars: {
            amountDisplay,
            merchantName,
            cardDisplay,
            orderId,
            redirectUrl,
          },
        }),
        followUp: [
          formatPaymentFsmDirective(workflow),
          'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
          'Do NOT continue until the background event monitor reports agent_order.succeeded or agent_order.failed.',
        ],
      });
    }

    if (workflow.action === PaymentWorkflowAction.NOTIFY_SUCCESS_AND_CONFIRM_MERCHANT) {
      await savePendingMerchantConfirmation(merchantIntegration, sessionId, notifyDestination);
      const successNotification = buildPaymentSuccessNotification({
        amountDisplay,
        cardDisplay,
        orderId,
      });

      try {
        const sendResult = await withCardStateLock(orderId, 1, sessionId, async () => {
          const latestCache = normalizeCache(await readPaymentMethodsCache() || {});
          const latestState = getOrderCardState(latestCache, orderId, 1, sessionId);
          const latestNotifyDestination = getNotifyDestination(latestCache) || notifyDestination || requestNotifyDestination || null;
          if (!latestState?.paymentSuccessCardSent) {
            sendNotificationDirect(latestNotifyDestination, successNotification);
            await updateOrderCardState(orderId, 1, sessionId, {
              paymentSuccessCardSent: true,
              paymentSuccessCardSentAt: new Date().toISOString(),
              paymentSuccessCardSource: 'sync_charge_response',
            });
          }
          if (latestState?.merchantConfirmationTriggered) {
            return 'already_completed';
          }
          if (latestState?.merchantConfirmationDispatched) {
            await logRequest('clink_pay.sync_success.skip_duplicate_merchant_confirmation', {
              orderId,
              sessionId,
              reason: 'merchant_confirmation_already_in_flight',
            });
            return 'already_in_flight';
          }

          const effectiveMerchantContext = latestCache.pendingMerchantConfirmation;
          if (!effectiveMerchantContext?.server || !effectiveMerchantContext?.tool) {
            return 'completed';
          }

          const effectiveNotifyDestination = effectiveMerchantContext.notifyDestination || latestNotifyDestination || null;
          const merchantArgs = buildMerchantConfirmArgs(
            effectiveMerchantContext,
            buildMerchantPaymentHandoff(orderId, sessionId, effectiveNotifyDestination, 'sync_charge_response'),
          );

          await logRequest('clink_pay.sync_success.trigger_merchant_confirmation', {
            context: effectiveMerchantContext,
            args: merchantArgs,
          });

          try {
            const child = spawn(process.execPath, [
              MERCHANT_CONFIRMATION_RUNNER,
              '--config-path', MCPORTER_CONFIG_PATH,
              '--server', effectiveMerchantContext.server,
              '--tool', effectiveMerchantContext.tool,
              '--args-json', JSON.stringify(merchantArgs),
              '--order-id', orderId || '',
              '--session-id', sessionId || '',
              '--pending-session-id', effectiveMerchantContext.sessionId || '',
              '--trigger-source', 'sync_charge_response',
            ], {
              detached: true,
              stdio: 'ignore',
            });
            child.on('error', (err) => {
              logError('clink_pay.sync_success.trigger_merchant_confirmation.spawn', err);
            });
            child.unref();
          } catch (err) {
            await logError('clink_pay.sync_success.trigger_merchant_confirmation', err);
            return 'trigger_failed';
          }

          await updateOrderCardState(orderId, 1, sessionId, {
            merchantConfirmationDispatched: true,
            merchantConfirmationDispatchedAt: new Date().toISOString(),
            merchantConfirmationDispatchSource: 'sync_charge_response',
          });
          return 'completed';
        });

        if (sendResult === 'trigger_failed') {
          return `[SYSTEM DIRECTIVE] Payment already succeeded synchronously.
${formatPaymentFsmDirective(workflow)}
The payment success notification has already been sent to the user.
Immediate merchant recharge confirmation handoff failed in the background.
Do NOT send any additional notification in this turn.
Do NOT invoke the merchant-side recharge-status checker again in this turn.
The background event monitor will retry the merchant confirmation and original-task resume flow when agent_order.succeeded arrives.`;
        }

        if (sendResult === 'already_completed') {
          return `[SYSTEM DIRECTIVE] Payment already succeeded synchronously.
${formatPaymentFsmDirective(workflow)}
The payment success notification was already sent earlier.
The merchant recharge confirmation handoff was already triggered earlier.
Do NOT send any additional notification in this turn.
Do NOT invoke the merchant-side recharge-status checker again in this turn.`;
        }

        return `[SYSTEM DIRECTIVE] Payment already succeeded synchronously.
${formatPaymentFsmDirective(workflow)}
The payment success notification has already been sent to the user.
Do NOT send any additional notification in this turn.
Do NOT invoke the merchant-side recharge-status checker again in this turn.`;
      } catch (sendErr) {
        await logError('clink_pay/sync_success_card', sendErr);
        return `[SYSTEM DIRECTIVE] Payment already succeeded synchronously.
${formatPaymentFsmDirective(workflow)}
Direct notification delivery failed, so do NOT send any fallback notification in this turn.
Do NOT invoke the merchant-side recharge-status checker in this turn.
The background event monitor will continue the merchant confirmation and original-task resume flow when agent_order.succeeded arrives.`;
      }
    }

    if (workflow.action === PaymentWorkflowAction.NOTIFY_FAILURE_STOP) {
      const isRiskReject = cpr.code === 'risk_reject' || String(cpr.declinedCode || '').includes('risk.');
      const failureReason = cpr.message || cpr.declinedCode || '支付处理异常';
      const failNotification = isRiskReject
        ? buildRiskRejectNotification({
            amountDisplay,
            message: cpr.message,
            orderId,
          })
        : buildPaymentFailureNotification({
            amountDisplay,
            orderId,
            failureReason,
          });

      try {
        const sendResult = await withCardStateLock(orderId, status, sessionId, async () => {
          const latestCache = normalizeCache(await readPaymentMethodsCache() || {});
          const latestState = getOrderCardState(latestCache, orderId, status, sessionId);
          const latestNotifyDestination = getNotifyDestination(latestCache) || notifyDestination || requestNotifyDestination || null;
          if (latestState?.paymentFailureCardSent) {
            return 'already_sent';
          }
          sendNotificationDirect(latestNotifyDestination, failNotification);
          await updateOrderCardState(orderId, status, sessionId, {
            paymentFailureCardSent: true,
            paymentFailureCardSentAt: new Date().toISOString(),
            paymentFailureCardSource: 'sync_charge_response',
            paymentFailureKind: isRiskReject ? 'risk_reject' : 'terminal_failure',
          });
          return 'sent';
        });
        if (sendResult === 'already_sent') {
          return `[SYSTEM DIRECTIVE] Payment already ended with a terminal failure in the synchronous charge response.
${formatPaymentFsmDirective(workflow)}
The failure notification was already sent earlier.
Do NOT send any additional notification in this turn.
Do NOT retry automatically.`;
        }
        return `[SYSTEM DIRECTIVE] Payment already ended with a terminal failure in the synchronous charge response.
${formatPaymentFsmDirective(workflow)}
The failure notification has already been sent to the user.
Do NOT send any additional notification in this turn.
Do NOT retry automatically.`;
      } catch (sendErr) {
        await logError('clink_pay/sync_failure_card', sendErr);
        return `[SYSTEM DIRECTIVE] Payment already ended with a terminal failure in the synchronous charge response.
${formatPaymentFsmDirective(workflow)}
Direct notification delivery failed, so do NOT send any fallback notification in this turn.
Do NOT retry automatically.`;
      }
    }

    await savePendingMerchantConfirmation(merchantIntegration, sessionId, notifyDestination);

    return `[SYSTEM DIRECTIVE] Payment submitted successfully. Order is now processing.
${formatPaymentFsmDirective(workflow)}
Do NOT send any intermediate "处理中" notification to the user for this state.
Do not send any extra notification in this turn. A brief natural-language reply is fine if helpful.
Do NOT ask the user any question.
Do NOT invoke the merchant-side recharge-status checker in this turn.
The merchant-side recharge confirmation and original-task resume must be driven by the payment-layer success handoff that owns this order. For pending / 3DS flows, the background event monitor delivers agent_order.succeeded when it arrives.`;
  } catch (err) {
    await logError('clink_pay', err);
    const errorWorkflow = classifyPaymentError(err);
    const code = err instanceof ClinkCliError ? err.code : null;
    const currency = args.currency || "USD";
    const amt = formatAmountWithCurrency(args.amount, currency);

    if (errorWorkflow.action === PaymentWorkflowAction.VERIFY_BEFORE_RETRY) {
      return `[SYSTEM DIRECTIVE] Payment state is unknown because clink-cli returned a network/timeout error.
${formatPaymentFsmDirective(errorWorkflow)}
Do NOT retry automatically.
Verify the order/session state through a safe merchant-side or Clink-side status check before any retry.`;
    }

    if (code === 90101203 || err.message.includes("CUSTOMER_EMAIL_NOT_FOUND")) {
      return formatNotificationInstruction({
        summary: 'Payment blocked: customer email not found.',
        notifications: createMessageRequest({
          messageKey: 'payment.blocked.customer_email_missing',
          vars: {
            email: env.CLINK_USER_EMAIL || 'N/A',
          },
        }),
        followUp: [
          'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
        ],
      });
    }

    if (err.message.includes("CUSTOMER_VERIFY_FAILED") || (err.message.includes("邮箱") && err.message.includes("验证"))) {
      return formatNotificationInstruction({
        summary: 'Payment blocked: email verification failed (email mismatch).',
        notifications: createMessageRequest({
          messageKey: 'payment.blocked.email_mismatch',
          vars: {
            email: env.CLINK_USER_EMAIL || 'N/A',
          },
        }),
        followUp: [
          'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
        ],
      });
    }

    if (code === 90101216 || err.message.includes("MERCHANT_NOT_FOUND")) {
      return formatNotificationInstruction({
        summary: 'Payment failed: merchant not found.',
        notifications: createMessageRequest({
          messageKey: 'payment.failed.merchant_not_found',
          vars: {
            merchantId: args.merchant_id,
          },
        }),
        followUp: [
          'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
        ],
      });
    }

    if (code === 90101212 || err.message.includes("ORDER_HAS_ONE_IN_PROCESSING") || err.message.includes("处理中")) {
      return formatNotificationInstruction({
        summary: 'Payment blocked: another order is still processing.',
        notifications: createMessageRequest({
          messageKey: 'payment.blocked.order_processing',
          vars: {
            amountDisplay: amt,
          },
        }),
        followUp: [
          'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
          'Wait for the previous order to complete via the background event monitor.',
        ],
      });
    }

    if (code === 90101206 || err.message.includes("ORDER_AMOUNT") || err.message.includes("CURRENCY_INCORRECT") || err.message.includes("金额")) {
      return formatNotificationInstruction({
        summary: 'Payment failed: invalid amount or currency.',
        notifications: createMessageRequest({
          messageKey: 'payment.failed.invalid_amount_or_currency',
          vars: {
            amountDisplay: amt,
          },
        }),
        followUp: [
          'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
        ],
      });
    }

    if (code === 90101219 || code === 90101220 || err.message.includes("SESSION_NOT_FOUND") || err.message.includes("SESSION_EXPIRED")) {
      return formatNotificationInstruction({
        summary: 'Payment failed: charge session expired or not found.',
        notifications: createMessageRequest({
          messageKey: 'payment.failed.session_expired',
          vars: {
            amountDisplay: amt,
          },
        }),
        followUp: ['You should automatically retry by creating a new charge request.'],
      });
    }

    if (code === 90101221 || err.message.includes("SESSION_MERCHANT_MISMATCH")) {
      return formatNotificationInstruction({
        summary: 'Payment failed: session merchant mismatch.',
        notifications: createMessageRequest({
          messageKey: 'payment.failed.session_merchant_mismatch',
          vars: {
            merchantId: args.merchant_id,
          },
        }),
        followUp: [
          'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
        ],
      });
    }

    if (code === 401 || code === 80102221 || code === 80102222 || code === 80102223) {
      return formatNotificationInstruction({
        summary: 'Payment failed: authentication error.',
        notifications: createMessageRequest({
          messageKey: 'payment.failed.auth',
          vars: { code },
        }),
        followUp: [
          'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
        ],
      });
    }

    if (code === 80102212 || code === 80102213 || code === 80102203) {
      return formatNotificationInstruction({
        summary: 'Payment failed: timestamp validation error.',
        notifications: createMessageRequest({
          messageKey: 'payment.failed.timestamp',
          vars: { code },
        }),
        followUp: ['This is likely a clock sync issue. Retry immediately with a fresh timestamp.'],
      });
    }

    if (err.message.includes("RISK") || err.message.includes("风控") || err.message.includes("LIMIT") || err.message.includes("FREQUENCY") || err.message.includes("COOLDOWN")) {
      const ruleName = err.raw?.data?.ruleName || err.raw?.data?.rule_name || "风控规则";
      const ruleDetail = err.raw?.data?.ruleDetail || err.raw?.data?.rule_detail || err.message;
      return formatNotificationInstruction({
        summary: 'Payment blocked: risk rule triggered.',
        notifications: createMessageRequest({
          messageKey: 'payment.blocked.risk_rule',
          vars: {
            amountDisplay: amt,
            ruleName,
            ruleDetail,
          },
        }),
        followUp: [
          'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
          'Wait for the user to choose an action. If the user chooses "继续充值", retry clink_pay with the same parameters. If the user chooses "修改风控规则", call get_risk_rules_link first.',
        ],
      });
    }

    if (code === 90101200 || err.message.includes("DECLINE") || err.message.includes("拒绝")) {
      return formatNotificationInstruction({
        summary: 'Payment failed: card declined.',
        notifications: [
          createMessageRequest({
            messageKey: 'payment.failed.card_declined',
            vars: { amountDisplay: amt },
          }),
          createMessageRequest({
            messageKey: 'payment.failed.change_payment_method',
            vars: {},
          }),
        ],
        followUp: [
          'After sending both notifications, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
          'Wait for the user to switch their payment method and explicitly ask to retry before calling clink_pay again.',
        ],
      });
    }

    if (code === 90101201) {
      return formatNotificationInstruction({
        summary: 'Payment failed: remote service error.',
        notifications: createMessageRequest({
          messageKey: 'payment.failed.remote_service',
          vars: { amountDisplay: amt },
        }),
        followUp: [
          'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
        ],
      });
    }

    if (errorWorkflow.action === PaymentWorkflowAction.ASK_WALLET_SETUP) {
      return `[SYSTEM DIRECTIVE] Payment cannot continue because clink-cli reported wallet setup or authentication is required.
${formatPaymentFsmDirective(errorWorkflow)}
Do NOT retry automatically. Ask the user to initialize or restore the Clink wallet credentials, then rerun the payment only after the exact same charge is still authorized.`;
    }

    return formatNotificationInstruction({
      summary: 'Payment failed: unexpected error.',
      notifications: createMessageRequest({
        messageKey: 'payment.failed.unexpected',
        vars: {
          amountDisplay: amt,
          reason: err.message,
          code: code || 'N/A',
        },
      }),
      followUp: [
        formatPaymentFsmDirective(errorWorkflow),
        'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
      ],
    });
  }
}

async function handle_clink_refund(args) {
  if (!args || typeof args !== 'object') {
    return "ERROR: clink_refund requires an args object. Missing: orderId.";
  }

  try {
    const requestNotifyDestination = parseNotifyDestinationArgs(args);
    if (requestNotifyDestination) {
      const cache = normalizeCache(await readPaymentMethodsCache() || {});
      cache.notifyDestination = requestNotifyDestination;
      await writePaymentMethodsCache(cache);
    }
  } catch (error) {
    return `ERROR: ${error.message}`;
  }

  const orderId = typeof args.orderId === 'string' ? args.orderId.trim() : '';
  if (!orderId) {
    return "ERROR: clink_refund requires 'orderId'.";
  }

  const env = await getPaymentEnv();
  if (!env.CLINK_CUSTOMER_API_KEY || !env.CLINK_CUSTOMER_ID) {
    return "Wallet not initialized. Please run initialize_wallet first.";
  }

  const refundBody = { orderId };

  try {
    const data = await runClinkCli(['refund', 'create', '--order-id', String(orderId)]);
    await logRequest('clink_refund', refundBody, data);
    const refundId = data.refundOrderId || "N/A";
    const responseOrderId = data.orderId || orderId;
    const refundAmountRaw = data.refundAmount ?? null;
    const refundCurrency = data.refundCurrency || "USD";
    const refundStatus = data.status || "pending_review";
    const refundAmountNumber = refundAmountRaw === null || refundAmountRaw === undefined
      ? null
      : Number(refundAmountRaw);
    const refundAmountDisplay = refundAmountNumber === null || Number.isNaN(refundAmountNumber)
      ? "待后端确认"
      : `${refundAmountNumber.toFixed(2)} ${refundCurrency}`;
    const statusDisplay = refundStatus === "pending_review"
      ? "等待审核中"
      : refundStatus;

    const notification = createMessageRequest({
      messageKey: 'refund.application_submitted',
      vars: {
        orderId: responseOrderId,
        refundId,
        refundAmountDisplay,
        statusDisplay,
      },
    });
    const cache = await readPaymentMethodsCache() || {};
    const notifyDestination = getNotifyDestination(cache);
    let fallbackReason = 'missing_notify_destination';

    if (notifyDestination) {
      try {
        sendNotificationDirect(notifyDestination, notification);
        return `[SYSTEM DIRECTIVE] DIRECT_SEND: Refund application submitted successfully.
The notification has been sent. Do NOT send another card.
The background event monitor will deliver the final refund success/failure notification. The refund remains pending manual review/processing until the user explicitly asks to query its status.`;
      } catch (sendErr) {
        fallbackReason = 'direct_send_failed';
        await logError('clink_refund/direct_send', sendErr);
      }
    }

    await logNotificationFallback('clink_refund', { cache, message: notification, reason: fallbackReason });
    return formatNotificationInstruction({
      summary: 'Refund application submitted successfully.',
      notifications: notification,
      followUp: [
        'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
        'Do NOT restate the refund details verbatim in natural language.',
        'Do NOT send this submission notification more than once for the same tool result.',
        'The background event monitor will deliver the final refund success/failure notification.',
        'Do NOT auto-start refund status polling. Query get_refund_status only when the user explicitly asks about refund progress/status.',
      ],
    });
  } catch (err) {
    await logError('clink_refund', err);
    const code = err instanceof ClinkCliError ? err.code : null;
    const failureReason = err instanceof ClinkCliError
      ? (err.raw?.msg || err.message || "退款申请失败")
      : err.message;
    const failureDescription = code === 90101401
      ? "该订单当前可退余额不足，无法继续发起退款申请。请核对订单已退款金额或等待可退额度更新后再试。"
      : "退款申请未能提交，请稍后重试。如问题持续，请联系 Clink 支持排查。";

    return formatNotificationInstruction({
      summary: 'Refund application failed.',
      notifications: createMessageRequest({
        messageKey: 'refund.application_failed',
        vars: {
          orderId,
          reason: failureReason,
          code: code || 'N/A',
          description: failureDescription,
        },
      }),
      followUp: [
        'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
        'Do NOT restate the failure verbatim in natural language.',
      ],
    });
  }
}

function buildRefundStatusNotification(data) {
  const refundStatus = normalizeRefundStatusCode(data.status);
  const refundAmountDisplay = formatAmountWithCurrency(
    data.refundAmount,
    data.refundCurrency || 'USD',
  );

  return createMessageRequest({
    messageKey: 'refund.status_checked',
    vars: {
      orderId: data.orderId || 'N/A',
      refundId: data.refundOrderId || 'N/A',
      refundAmountDisplay,
      statusCode: refundStatus,
      paymentInstrumentId: data.paymentInstrumentId || 'N/A',
      refundReason: data.refundReason || '',
      remark: data.remark || '',
    },
  });
}

async function handle_get_refund_status(args) {
  if (!args || typeof args !== 'object') {
    return "ERROR: get_refund_status requires an args object. Missing: refundOrderId.";
  }

  try {
    const requestNotifyDestination = parseNotifyDestinationArgs(args);
    if (requestNotifyDestination) {
      const cache = normalizeCache(await readPaymentMethodsCache() || {});
      cache.notifyDestination = requestNotifyDestination;
      await writePaymentMethodsCache(cache);
    }
  } catch (error) {
    return `ERROR: ${error.message}`;
  }

  const refundOrderId = typeof args.refundOrderId === 'string' ? args.refundOrderId.trim() : '';
  if (!refundOrderId) {
    return "ERROR: get_refund_status requires 'refundOrderId'.";
  }

  const env = await getPaymentEnv();
  if (!env.CLINK_CUSTOMER_API_KEY || !env.CLINK_CUSTOMER_ID) {
    return "Wallet not initialized. Please run initialize_wallet first.";
  }

  try {
    const data = await runClinkCli(['refund', 'get', '--refund-id', String(refundOrderId)]);
    await logRequest('get_refund_status', { refundOrderId }, data);

    const notification = buildRefundStatusNotification(data);
    const cache = await readPaymentMethodsCache() || {};
    const notifyDestination = getNotifyDestination(cache);
    let fallbackReason = 'missing_notify_destination';

    if (notifyDestination) {
      try {
        sendNotificationDirect(notifyDestination, notification);
        return `[SYSTEM DIRECTIVE] DIRECT_SEND: Refund status fetched successfully.
The notification has been sent. Do NOT send another card.`;
      } catch (sendErr) {
        fallbackReason = 'direct_send_failed';
        await logError('get_refund_status/direct_send', sendErr);
      }
    }

    await logNotificationFallback('get_refund_status', { cache, message: notification, reason: fallbackReason });
    return formatNotificationInstruction({
      summary: 'Refund status fetched successfully.',
      notifications: notification,
      followUp: [
        'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
        'Do NOT restate the refund details verbatim in natural language.',
      ],
    });
  } catch (err) {
    await logError('get_refund_status', err);
    const code = err instanceof ClinkCliError ? err.code : null;
    const reason = err instanceof ClinkCliError
      ? (err.raw?.msg || err.message || '退款状态查询失败')
      : err.message;
    const description = code === 71160007
      ? '未找到对应的退款单号，请确认 refundOrderId 是否正确。'
      : '退款状态暂时无法查询，请稍后重试。如问题持续，请联系 Clink 支持排查。';

    return formatNotificationInstruction({
      summary: 'Refund status query failed.',
      notifications: createMessageRequest({
        messageKey: 'refund.status_query_failed',
        vars: {
          refundId: refundOrderId,
          reason,
          code: code || 'N/A',
          description,
        },
      }),
      followUp: [
        'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
        'Do NOT restate the failure verbatim in natural language.',
      ],
    });
  }
}

// ------------------------------------------------------------------
// VIC PURCHASE INSTRUCTION (agentic authorization)
// ------------------------------------------------------------------
async function resolveSelectedPaymentMethod(paymentInstrumentId = null) {
  const cache = normalizeCache(await readPaymentMethodsCache() || {});
  let methods = normalizePaymentMethods(cache.paymentMethods || []);
  let selected = paymentInstrumentId ? findPaymentMethodById(methods, paymentInstrumentId) : null;

  if (!paymentInstrumentId) {
    selected = methods.find((method) => method.paymentInstrumentId === cache.defaultPaymentMethodId)
      || methods.find((method) => method.isDefault)
      || methods[0]
      || null;

    if (selected) return selected;
  } else if (selected) {
    return selected;
  }

  const bindingData = await fetchBindingData();
  methods = normalizePaymentMethods(bindingData.methods || []);
  selected = paymentInstrumentId ? findPaymentMethodById(methods, paymentInstrumentId) : null;
  if (paymentInstrumentId) return selected || null;
  return selected
    || methods.find((method) => method.isDefault)
    || methods[0]
    || null;
}

function normalizeInstructionComparableText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

function parseInstructionTimeMs(value) {
  if (value === undefined || value === null || value === '') return null;
  // Instruction/mandate effectiveUntilTime is now Unix epoch seconds (string or number). Treat a
  // bare integer as epoch seconds; values already in millisecond range are passed through as-is.
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value < 1e12 ? value * 1000 : value;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds)) return null;
    return seconds < 1e12 ? seconds * 1000 : seconds;
  }
  // Legacy "yyyy-MM-dd HH:mm:ss" (UTC) strings from older ACTIVE instructions still parse.
  const isoLike = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const withZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(isoLike) ? isoLike : `${isoLike}Z`;
  const parsed = Date.parse(withZone);
  return Number.isFinite(parsed) ? parsed : null;
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizePurchaseInstructionFulfillmentType(value) {
  return String(value || '').trim().toUpperCase();
}

function validatePurchaseInstructionFulfillmentType(args = {}) {
  const fulfillmentType = normalizePurchaseInstructionFulfillmentType(args.fulfillmentType);
  const allowed = ['PHYSICAL_GOODS_REQUIRES_SHIPPING', 'NO_SHIPPING_REQUIRED', 'UNKNOWN'];
  if (!fulfillmentType) return ['fulfillmentType'];
  if (!allowed.includes(fulfillmentType)) {
    return ['fulfillmentType must be PHYSICAL_GOODS_REQUIRES_SHIPPING, NO_SHIPPING_REQUIRED, or UNKNOWN'];
  }
  if (fulfillmentType === 'UNKNOWN') {
    return ['fulfillmentType must be resolved before listing or creating instructions'];
  }
  return [];
}

function purchaseInstructionNeedsShippingAddress(args = {}) {
  return normalizePurchaseInstructionFulfillmentType(args.fulfillmentType) === 'PHYSICAL_GOODS_REQUIRES_SHIPPING';
}

function validatePurchaseInstructionShippingAddress(args = {}) {
  const missing = [];
  const needsShippingAddress = purchaseInstructionNeedsShippingAddress(args);
  const hasShippingAddress = args.shippingAddress !== undefined && args.shippingAddress !== null;
  if (!needsShippingAddress && !hasShippingAddress) return missing;
  if (!isPlainObject(args.shippingAddress)) return ['shippingAddress'];

  const address = args.shippingAddress;
  for (const field of ['name', 'line1', 'city', 'state', 'zip', 'countryCode']) {
    if (!String(address[field] || '').trim()) missing.push(`shippingAddress.${field}`);
  }
  const countryCode = String(address.countryCode || '').trim().toUpperCase();
  if (countryCode && countryCode !== 'US') missing.push('shippingAddress.countryCode must be US');
  return missing;
}

function validatePurchaseInstructionScope(args = {}) {
  const missing = [];
  if (!Array.isArray(args.mandates) || args.mandates.length === 0) {
    missing.push('mandates');
    return missing;
  }

  args.mandates.forEach((mandate, index) => {
    const prefix = `mandates[${index}]`;
    const amountLimit = Number(mandate?.amountLimit);
    if (!Number.isFinite(amountLimit) || amountLimit <= 0) missing.push(`${prefix}.amountLimit`);
    if (!String(mandate?.currencyCode || '').trim()) missing.push(`${prefix}.currencyCode`);
    if (
      !String(mandate?.merchantCategoryCode || '').trim() &&
      !String(mandate?.preferredMerchantName || '').trim() &&
      !String(mandate?.merchantCategory || '').trim()
    ) {
      missing.push(`${prefix}.merchantCategoryCode or preferredMerchantName`);
    }
  });

  missing.push(...validatePurchaseInstructionShippingAddress(args));
  return missing;
}

function mandateMatchesPurchaseScope(candidateMandate = {}, requestedMandate = {}) {
  const requestedCurrency = String(requestedMandate.currencyCode || '').trim().toUpperCase();
  const candidateCurrency = String(candidateMandate.currencyCode || '').trim().toUpperCase();
  if (requestedCurrency && candidateCurrency !== requestedCurrency) return false;

  const requestedAmount = Number(requestedMandate.amountLimit);
  const candidateAmount = Number(candidateMandate.amountLimit);
  if (Number.isFinite(requestedAmount) && (!Number.isFinite(candidateAmount) || candidateAmount < requestedAmount)) {
    return false;
  }

  const requestedMcc = String(requestedMandate.merchantCategoryCode || '').trim();
  const candidateMcc = String(candidateMandate.merchantCategoryCode || '').trim();
  if (requestedMcc && candidateMcc && candidateMcc !== requestedMcc) return false;
  const categoryMatches = Boolean(requestedMcc && candidateMcc && candidateMcc === requestedMcc);

  const requestedMerchant = normalizeInstructionComparableText(requestedMandate.preferredMerchantName);
  const candidateMerchantText = normalizeInstructionComparableText([
    candidateMandate.preferredMerchantName,
    candidateMandate.title,
    candidateMandate.description,
    candidateMandate.merchantCategory,
  ].filter(Boolean).join(' '));
  if (requestedMerchant && !categoryMatches) {
    if (!candidateMerchantText) return false;
    if (!candidateMerchantText.includes(requestedMerchant) && !requestedMerchant.includes(candidateMerchantText)) {
      return false;
    }
  } else if (requestedMcc && !candidateMcc) {
    return false;
  }

  const requestedUntil = parseInstructionTimeMs(requestedMandate.effectiveUntilTime);
  const candidateUntil = parseInstructionTimeMs(candidateMandate.effectiveUntilTime);
  if (requestedUntil !== null && candidateUntil !== null && candidateUntil < requestedUntil) return false;

  return true;
}

function findReusablePurchaseInstruction(instructions, { paymentInstrumentId, mandates }) {
  if (!Array.isArray(instructions) || !paymentInstrumentId || !Array.isArray(mandates) || mandates.length === 0) {
    return null;
  }

  return instructions.find((instruction) => {
    if (!instruction || instruction.paymentInstrumentId !== paymentInstrumentId) return false;
    if (String(instruction.status || '').toUpperCase() !== 'ACTIVE') return false;
    const instructionMandates = Array.isArray(instruction.mandates) ? instruction.mandates : [];
    if (instructionMandates.length === 0) return false;
    return mandates.every((requestedMandate) =>
      instructionMandates.some((candidateMandate) =>
        mandateMatchesPurchaseScope(candidateMandate, requestedMandate),
      ),
    );
  }) || null;
}

async function handle_prepare_visa_purchase_instruction(args = {}) {
  if (!args.title) return "ERROR: prepare_visa_purchase_instruction requires 'title'.";
  if (!Array.isArray(args.mandates) || args.mandates.length === 0) {
    return "ERROR: prepare_visa_purchase_instruction requires a non-empty 'mandates' array with amountLimit and currencyCode.";
  }

  const missingFulfillmentType = validatePurchaseInstructionFulfillmentType(args);
  if (missingFulfillmentType.length > 0) {
    return `[VIC_STATE_MACHINE] state=MISSING_FULFILLMENT_TYPE
The fulfillment type is not resolved yet. Before listing or creating a purchase instruction, determine whether this purchase is a physical goods order that requires shipping.
Use fulfillmentType=PHYSICAL_GOODS_REQUIRES_SHIPPING only for shipped physical goods, fulfillmentType=NO_SHIPPING_REQUIRED for hotels, tickets, services, subscriptions, digital goods, bookings, and reservations, or ask the user to clarify when uncertain.
Missing fields: ${missingFulfillmentType.join(', ')}`;
  }

  const missingScope = validatePurchaseInstructionScope(args);
  if (missingScope.length > 0) {
    return `[VIC_STATE_MACHINE] state=MISSING_SCOPE
The spend scope is incomplete. Ask the user only for the missing mandate fields before listing or creating a purchase instruction.
Missing fields: ${missingScope.join(', ')}`;
  }

  let requestNotifyDestination = null;
  if (args.channel !== undefined || args.target_id !== undefined || args.target_type !== undefined || args.locale !== undefined) {
    try {
      requestNotifyDestination = parseNotifyDestinationArgs(args);
    } catch (error) {
      return `ERROR: ${error.message}`;
    }
  }

  try {
    const selectedMethod = await resolveSelectedPaymentMethod(args.paymentInstrumentId || null);
    if (!selectedMethod?.paymentInstrumentId) {
      return `[VIC_STATE_MACHINE] state=NO_PAYMENT_METHOD
No payment method is bound. Call get_payment_method_setup_link before preparing a Visa purchase instruction.`;
    }

    const vicGate = await ensureVisaVicReadyForUse({
      paymentInstrumentId: selectedMethod.paymentInstrumentId,
      selectedMethod,
      notifyDestination: requestNotifyDestination,
      context: 'prepare_visa_purchase_instruction',
    });

    if (!vicGate.blocked || vicGate.route === 'legacy') {
      return `[VIC_STATE_MACHINE] state=NON_VISA
The selected/default payment method is not Visa. Do not create a VIC purchase instruction; continue with the normal non-Visa payment route when payment inputs are ready.
Payment Instrument ID: ${selectedMethod.paymentInstrumentId}`;
    }

    if (vicGate.route !== 'vic_instruction_required') {
      return `[VIC_STATE_MACHINE] state=${vicGate.route || 'BLOCKED'}
${vicGate.response}`;
    }

    const paymentInstrumentId = vicGate.paymentMethod?.paymentInstrumentId || selectedMethod.paymentInstrumentId;
    const activeInstructions = await runClinkCli([
      'instruction', 'list',
      '--status', 'ACTIVE',
      '--payment-instrument-id', paymentInstrumentId,
    ]);
    await logRequest('prepare_visa_purchase_instruction/list_active', { status: 'ACTIVE', paymentInstrumentId }, activeInstructions);

    const reusableInstruction = findReusablePurchaseInstruction(activeInstructions, {
      paymentInstrumentId,
      mandates: args.mandates,
    });
    if (reusableInstruction) {
      return `[VIC_STATE_MACHINE] state=REUSED_ACTIVE_INSTRUCTION
Found a reusable ACTIVE purchase instruction for the selected Visa card. Do NOT call create_purchase_instruction.
Instruction ID: ${reusableInstruction.instructionId}
Raw Data: ${JSON.stringify(reusableInstruction)}`;
    }

    const createResult = await createPurchaseInstructionDraft({
      ...args,
      paymentInstrumentId,
    });
    if (!isPurchaseInstructionDraftCreateSuccess(createResult)) {
      return `[VIC_STATE_MACHINE] state=CREATE_FAILED
No reusable ACTIVE purchase instruction matched the selected Visa card and spend scope, but draft creation did not complete.
${createResult}`;
    }
    return `[VIC_STATE_MACHINE] state=CREATED_DRAFT
No reusable ACTIVE purchase instruction matched the selected Visa card and spend scope.
${createResult}`;
  } catch (err) {
    await logError('prepare_visa_purchase_instruction', err);
    return `Failed to prepare Visa purchase instruction: ${err.message}`;
  }
}

function isPurchaseInstructionDraftCreateSuccess(result) {
  const text = String(result || '');
  if (/^(ERROR:|Failed to create purchase instruction:)/i.test(text)) return false;
  if (/did not include instructionId/i.test(text)) return false;
  if (/failed to generate the Passkey authorization link/i.test(text)) return false;
  return /Instruction ID:/i.test(text);
}

async function createPurchaseInstructionDraft(args = {}) {
  if (!args.paymentInstrumentId) return "ERROR: create_purchase_instruction requires 'paymentInstrumentId' (a VIC-ready Visa card).";
  if (!args.title) return "ERROR: create_purchase_instruction requires 'title'.";
  if (!Array.isArray(args.mandates) || args.mandates.length === 0) return "ERROR: create_purchase_instruction requires a non-empty 'mandates' array (each with description, amountLimit, currencyCode).";
  const missingFulfillmentType = validatePurchaseInstructionFulfillmentType(args);
  if (missingFulfillmentType.length > 0) return `ERROR: create_purchase_instruction fulfillment classification is incomplete: ${missingFulfillmentType.join(', ')}`;
  const missingScope = validatePurchaseInstructionScope(args);
  if (missingScope.length > 0) return `ERROR: create_purchase_instruction spend scope is incomplete: ${missingScope.join(', ')}`;
  let requestNotifyDestination = null;
  try {
    requestNotifyDestination = parseNotifyDestinationArgs(args);
  } catch (error) {
    return `ERROR: ${error.message}`;
  }

  // Instruction level no longer carries currencyCode / totalLimitAmount / countryCode — those live on each mandate.
  const body = {
    paymentInstrumentId: args.paymentInstrumentId,
    title: args.title,
    mandates: args.mandates,
  };
  if (args.description !== undefined) body.description = args.description;
  if (args.effectiveUntilTime !== undefined) body.effectiveUntilTime = args.effectiveUntilTime;
  if (args.isRecurring !== undefined) body.isRecurring = args.isRecurring;
  if (args.shippingAddress !== undefined) body.shippingAddress = args.shippingAddress;
  if (args.extra !== undefined) body.extra = args.extra;

  try {
    const createArgs = [
      'instruction', 'create',
      '--payment-instrument-id', body.paymentInstrumentId,
      '--title', body.title,
      '--mandates', JSON.stringify(body.mandates),
    ];
    if (body.description !== undefined) createArgs.push('--description', String(body.description));
    if (body.effectiveUntilTime !== undefined) createArgs.push('--effective-until-time', String(body.effectiveUntilTime));
    if (body.extra !== undefined) createArgs.push('--extra', JSON.stringify(body.extra));
    if (body.isRecurring) createArgs.push('--is-recurring');
    if (body.shippingAddress !== undefined) createArgs.push('--shipping-address', JSON.stringify(body.shippingAddress));
    const data = await runClinkCli(createArgs);
    await logRequest('create_purchase_instruction', body, data);
    if (!data?.instructionId) {
      return `Purchase instruction created, but the response did not include instructionId. It is NOT usable until the user completes the Passkey authorization on the page.\nRaw Data: ${JSON.stringify(data)}`;
    }

    try {
      const { bindingUrl, cache } = await resolvePurchaseInstructionBindingUrl();
      if (requestNotifyDestination) {
        cache.notifyDestination = requestNotifyDestination;
        await writePaymentMethodsCache(cache);
      }
      const notifyDestination = requestNotifyDestination || getNotifyDestination(cache);
      const paymentInstrumentId = data.paymentInstrumentId || args.paymentInstrumentId;
      const passkeyUrl = buildPurchaseInstructionPasskeyUrl(bindingUrl, paymentInstrumentId, data.instructionId);
      const cardDisplay = formatPaymentMethodDisplay({
        paymentMethodType: data.cardType || 'CARD',
        cardBrand: data.cardScheme || 'Visa',
        cardLast4: data.cardLastFour,
      });
      const notification = buildPurchaseInstructionAuthNotification({
        paymentInstrumentId,
        instructionId: data.instructionId,
        cardDisplay,
        title: data.title || args.title,
        description: data.description ?? args.description ?? '',
        effectiveUntilTime: data.effectiveUntilTime ?? args.effectiveUntilTime ?? '',
        mandates: Array.isArray(data.mandates) && data.mandates.length > 0 ? data.mandates : args.mandates,
        shippingAddress: data.shippingAddress ?? args.shippingAddress ?? null,
        passkeyUrl,
      });
      if (notifyDestination) {
        try {
          sendNotificationDirect(notifyDestination, notification);
          return buildDirectSendDirective({
            summary: 'Purchase instruction draft created and Passkey authorization card delivered.',
            suffix: [
              'Do NOT call sign_purchase_instruction until the front-end Passkey flow returns appInstance and authResult for this instructionId.',
              `Instruction ID: ${data.instructionId}`,
              `Raw Data: ${JSON.stringify(data)}`,
            ].join('\n'),
          });
        } catch (directSendError) {
          await logError('create_purchase_instruction/direct_send', directSendError);
        }
      }
      await logNotificationFallback('create_purchase_instruction/passkey_auth', {
        cache,
        message: notification,
        reason: notifyDestination ? 'direct_send_failed' : 'missing_notify_destination',
      });
      return formatNotificationInstruction({
        summary: 'Purchase instruction draft created. Passkey authorization is required before it can become ACTIVE.',
        notifications: notification,
        followUp: [
          'Do NOT call sign_purchase_instruction until the front-end Passkey flow returns appInstance and authResult for this instructionId.',
          `Instruction ID: ${data.instructionId}`,
          `Raw Data: ${JSON.stringify(data)}`,
        ],
      });
    } catch (notificationError) {
      await logError('create_purchase_instruction/passkey_notification', notificationError);
      return `Purchase instruction created (status CREATED), but failed to generate the Passkey authorization link: ${notificationError.message}\nInstruction ID: ${data.instructionId}\nRaw Data: ${JSON.stringify(data)}`;
    }
  } catch (err) {
    await logError('create_purchase_instruction', err);
    return `Failed to create purchase instruction: ${err.message}`;
  }
}

async function handle_list_purchase_instructions(args = {}) {
  const listArgs = ['instruction', 'list'];
  if (args.status) listArgs.push('--status', String(args.status));
  if (args.paymentInstrumentId) listArgs.push('--payment-instrument-id', String(args.paymentInstrumentId));
  try {
    const data = await runClinkCli(listArgs);
    const lines = [`Purchase instructions:\n${JSON.stringify(data, null, 2)}`];
    if (args.status === 'ACTIVE' && args.paymentInstrumentId && Array.isArray(data) && data.length === 0) {
      lines.push(`[SYSTEM DIRECTIVE] No matching ACTIVE purchase instruction was returned for paymentInstrumentId=${args.paymentInstrumentId}.
If the current/default card is Visa and the user's purchase/book/order request already includes a complete spend scope, call prepare_visa_purchase_instruction with that scope so the state machine can create the draft.
Do NOT ask for a payment link, payment URL,代付链接, Session ID, or tell the user to use the merchant app before creating the draft.`);
    }
    return lines.join('\n');
  } catch (err) {
    await logError('list_purchase_instructions', err);
    return `Failed to list purchase instructions: ${err.message}`;
  }
}

// ------------------------------------------------------------------
// UCP CHECKOUT (external/shadow merchant order)
// ------------------------------------------------------------------
function getPurchaseInstructionId(instruction = {}) {
  const id = instruction.instructionId
    || instruction.purchaseInstructionId
    || instruction.instruction_id
    || instruction.id;
  return typeof id === 'string' && id.trim() ? id.trim() : '';
}

function getPurchaseInstructionMandateId(mandate = {}) {
  const id = mandate.mandateId
    || mandate.mandate_id
    || mandate.purchaseInstructionMandateId
    || mandate.purchase_instruction_mandate_id
    || mandate.id;
  return typeof id === 'string' && id.trim() ? id.trim() : '';
}

function isActivePurchaseInstructionStatus(status) {
  return String(status || '').trim().toUpperCase() === 'ACTIVE';
}

function isActivePurchaseInstructionMandate(mandate = {}) {
  if (!getPurchaseInstructionMandateId(mandate)) return false;
  const statusCandidates = [
    mandate.status,
    mandate.mandateStatus,
    mandate.state,
    mandate.lifecycleStatus,
  ].filter((value) => value !== undefined && value !== null && String(value).trim());
  if (statusCandidates.length > 0 && !statusCandidates.every(isActivePurchaseInstructionStatus)) {
    return false;
  }

  if (mandate.isReserved === true || mandate.reserved === true || mandate.isLocked === true || mandate.locked === true) {
    return false;
  }
  const unavailableText = [
    mandate.reservationStatus,
    mandate.lockStatus,
    mandate.usageStatus,
    mandate.availability,
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean).join(' ');
  if (/\b(reserved|reserve|locked|lock|in[_ -]?use|unavailable)\b/.test(unavailableText)) {
    return false;
  }
  return true;
}

function getUcpCheckoutRequestedMandates(args = {}) {
  let mandates = args.mandates;
  if (typeof mandates === 'string') {
    try {
      mandates = JSON.parse(mandates);
    } catch (error) {
      throw new Error(`ucp_checkout 'mandates' must be valid JSON when passed as a string: ${error.message}`);
    }
  }
  if (!Array.isArray(mandates) || mandates.length === 0) {
    throw new Error("ucp_checkout requires a non-empty 'mandates' array so it can match an ACTIVE instruction+mandate or start the instruction creation workflow.");
  }
  return mandates;
}

function findReusableUcpCheckoutAuthorization(instructions, {
  paymentInstrumentId,
  mandates,
  instructionIdHint = '',
  mandateIdHint = '',
} = {}) {
  if (!Array.isArray(instructions) || !paymentInstrumentId || !Array.isArray(mandates) || mandates.length === 0) {
    return null;
  }
  const normalizedInstructionIdHint = String(instructionIdHint || '').trim();
  const normalizedMandateIdHint = String(mandateIdHint || '').trim();

  for (const instruction of instructions) {
    if (!instruction || instruction.paymentInstrumentId !== paymentInstrumentId) continue;
    if (!isActivePurchaseInstructionStatus(instruction.status)) continue;
    const instructionId = getPurchaseInstructionId(instruction);
    if (!instructionId) continue;
    if (normalizedInstructionIdHint && instructionId !== normalizedInstructionIdHint) continue;

    const instructionMandates = Array.isArray(instruction.mandates) ? instruction.mandates : [];
    for (const mandate of instructionMandates) {
      const mandateId = getPurchaseInstructionMandateId(mandate);
      if (!mandateId) continue;
      if (normalizedMandateIdHint && mandateId !== normalizedMandateIdHint) continue;
      if (!isActivePurchaseInstructionMandate(mandate)) continue;
      if (mandates.every((requestedMandate) => mandateMatchesPurchaseScope(mandate, requestedMandate))) {
        return { instruction, mandate, instructionId, mandateId };
      }
    }
  }

  return null;
}

async function resolveCurrentUcpCheckoutPaymentInstrument(paymentInstrumentId = null) {
  const requestedPaymentInstrumentId = typeof paymentInstrumentId === 'string'
    ? paymentInstrumentId.trim()
    : '';
  const { methods } = await fetchBindingData();
  const normalizedMethods = normalizePaymentMethods(methods || []);
  if (requestedPaymentInstrumentId) {
    const selected = findPaymentMethodById(normalizedMethods, requestedPaymentInstrumentId);
    if (!selected?.paymentInstrumentId) {
      throw new Error(`paymentInstrumentId ${requestedPaymentInstrumentId} was not found in the refreshed payment method list`);
    }
    return selected;
  }

  const selected = normalizedMethods.find((method) => method.isDefault)
    || normalizedMethods[0]
    || null;
  if (!selected?.paymentInstrumentId) {
    throw new Error('No payment method is bound. Call get_payment_method_setup_link before creating a UCP checkout.');
  }
  return selected;
}

function normalizeJsonCliFlag(value, fieldName, { required = false, expectArray = false } = {}) {
  const missing = value === undefined || value === null || value === '';
  if (missing) {
    if (required) throw new Error(`ucp_checkout requires '${fieldName}'.`);
    return null;
  }

  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(`ucp_checkout '${fieldName}' must be valid JSON when passed as a string: ${error.message}`);
    }
  }
  if (expectArray && !Array.isArray(parsed)) {
    throw new Error(`ucp_checkout '${fieldName}' must be a JSON array.`);
  }
  if (!expectArray && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
    throw new Error(`ucp_checkout '${fieldName}' must be a JSON object.`);
  }
  return JSON.stringify(parsed);
}

function extractUcpCheckoutId(data) {
  const candidates = [
    data?.id,
    data?.checkout_id,
    data?.checkoutId,
    data?.data?.id,
    data?.data?.checkout_id,
    data?.data?.checkoutId,
  ];
  const checkoutId = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim());
  return checkoutId ? checkoutId.trim() : '';
}

function buildUcpCheckoutCreateArgs(args = {}, resolvedAuthorization = {}) {
  const merchantUrl = String(args.merchant_url || args.merchantUrl || '').trim();
  const merchantCategoryCode = String(args.merchant_category_code || args.merchantCategoryCode || '').trim();
  const currency = String(args.currency || '').trim().toUpperCase();
  const instructionId = String(resolvedAuthorization.instructionId || args.instruction_id || args.instructionId || '').trim();
  const mandateId = String(resolvedAuthorization.mandateId || args.mandate_id || args.mandateId || '').trim();

  const missing = [];
  if (!merchantUrl) missing.push('merchant_url');
  if (!merchantCategoryCode) missing.push('merchant_category_code');
  if (!currency) missing.push('currency');
  if (!instructionId) missing.push('instruction_id');
  if (!mandateId) missing.push('mandate_id');
  const lineItemsInput = args.line_items ?? args.lineItems;
  if (lineItemsInput === undefined || lineItemsInput === null || lineItemsInput === '') missing.push('line_items');
  if (missing.length > 0) {
    throw new Error(`ucp_checkout missing required fields: ${missing.join(', ')}`);
  }

  const createArgs = [
    'ucp-checkout', 'create',
    '--merchant-url', merchantUrl,
    '--merchant-category-code', merchantCategoryCode,
    '--currency', currency,
    '--instruction-id', instructionId,
    '--mandate-id', mandateId,
    '--line-items', normalizeJsonCliFlag(lineItemsInput, 'line_items', { required: true, expectArray: true }),
  ];

  const merchantName = String(args.merchant_name || args.merchantName || '').trim();
  if (merchantName) createArgs.push('--merchant-name', merchantName);
  const orderChannelId = String(args.order_channel_id || args.orderChannelId || '').trim();
  if (orderChannelId) createArgs.push('--order-channel-id', orderChannelId);
  const buyerJson = normalizeJsonCliFlag(args.buyer, 'buyer');
  if (buyerJson) createArgs.push('--buyer', buyerJson);
  const shippingAddressInput = args.shipping_address ?? args.shippingAddress;
  const shippingAddressJson = normalizeJsonCliFlag(shippingAddressInput, 'shipping_address');
  if (shippingAddressJson) createArgs.push('--shipping-address', shippingAddressJson);
  const metadataJson = normalizeJsonCliFlag(args.metadata, 'metadata');
  if (metadataJson) createArgs.push('--metadata', metadataJson);
  const createIdempotencyKey = String(args.create_idempotency_key || args.createIdempotencyKey || args.idempotency_key || args.idempotencyKey || '').trim();
  if (createIdempotencyKey) createArgs.push('--idempotency-key', createIdempotencyKey);

  return createArgs;
}

function isTerminalUcpCheckoutStatus(data) {
  const status = String(data?.status || data?.checkoutStatus || data?.state || '').trim().toLowerCase();
  return ['completed', 'succeeded', 'success', 'failed', 'canceled', 'cancelled', 'requires_escalation'].includes(status);
}

async function handle_ucp_checkout(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return "ERROR: ucp_checkout requires an args object with merchant_url, merchant_category_code, currency, mandates, fulfillmentType, title, and line_items.";
  }

  try {
    const selectedPaymentMethod = await resolveCurrentUcpCheckoutPaymentInstrument(
      args.paymentInstrumentId || args.payment_instrument_id || null,
    );
    const paymentInstrumentId = selectedPaymentMethod.paymentInstrumentId;
    const requestedMandates = getUcpCheckoutRequestedMandates(args);
    const instructionList = await runClinkCli([
      'instruction', 'list',
      '--status', 'ACTIVE',
      '--payment-instrument-id', paymentInstrumentId,
    ]);
    await logRequest('ucp_checkout/list_active_instructions', { paymentInstrumentId }, instructionList);

    const authorization = findReusableUcpCheckoutAuthorization(instructionList, {
      paymentInstrumentId,
      mandates: requestedMandates,
      instructionIdHint: args.instruction_id || args.instructionId || '',
      mandateIdHint: args.mandate_id || args.mandateId || '',
    });

    if (!authorization) {
      const title = String(args.title || args.instruction_title || args.instructionTitle || args.merchant_name || args.merchantName || '').trim();
      const fulfillmentType = args.fulfillmentType || args.fulfillment_type;
      const prepareResult = await handle_prepare_visa_purchase_instruction({
        ...args,
        paymentInstrumentId,
        title,
        fulfillmentType,
        mandates: requestedMandates,
      });
      return `[UCP_CHECKOUT_FSM] state=INSTRUCTION_WORKFLOW_REQUIRED action=WAIT_INSTRUCTION_ACTIVATION reason=no_matching_active_instruction_mandate
No matching ACTIVE instruction+mandate was found for this product order after listing instructions with status=ACTIVE and paymentInstrumentId=${paymentInstrumentId}.
The instruction creation workflow has been invoked. Do NOT run ucp-checkout create or complete until a matching instruction+mandate is ACTIVE.
${prepareResult}`;
    }

    const createArgs = buildUcpCheckoutCreateArgs(args, authorization);
    const createData = await runClinkCli(createArgs);
    await logRequest('ucp_checkout/create', {
      args: createArgs,
      instructionId: authorization.instructionId,
      mandateId: authorization.mandateId,
    }, createData);

    const checkoutId = extractUcpCheckoutId(createData);
    if (!checkoutId) {
      return `[UCP_CHECKOUT_FSM] state=CREATE_FAILED action=SURFACE_ERROR reason=missing_checkout_id
The UCP checkout create response did not include data.id, data.checkout_id, or data.checkoutId. Do NOT ask the user to provide a checkoutId manually.
Payment Instrument ID: ${paymentInstrumentId}
Create Result: ${JSON.stringify(createData)}`;
    }

    const completeArgs = [
      'ucp-checkout', 'complete',
      '--checkout-id', checkoutId,
      '--payment-instrument-id', paymentInstrumentId,
    ];
    const completeIdempotencyKey = String(args.complete_idempotency_key || args.completeIdempotencyKey || '').trim();
    if (completeIdempotencyKey) completeArgs.push('--idempotency-key', completeIdempotencyKey);
    const completeData = await runClinkCli(completeArgs);
    await logRequest('ucp_checkout/complete', { args: completeArgs }, completeData);

    let verifyData = null;
    if (!isTerminalUcpCheckoutStatus(completeData)) {
      try {
        verifyData = await runClinkCli(['ucp-checkout', 'get', '--checkout-id', checkoutId]);
        await logRequest('ucp_checkout/get_after_complete', { checkoutId }, verifyData);
      } catch (verifyError) {
        await logError('ucp_checkout/get_after_complete', verifyError);
      }
    }

    const finalStatus = String(
      verifyData?.status || completeData?.status || completeData?.checkoutStatus || completeData?.state || 'submitted',
    ).trim().toLowerCase();
    const fsmState = finalStatus === 'completed' || finalStatus === 'success' || finalStatus === 'succeeded'
      ? 'COMPLETED'
      : finalStatus === 'complete_in_progress'
        ? 'COMPLETE_IN_PROGRESS'
        : finalStatus === 'requires_escalation'
          ? 'REQUIRES_ESCALATION'
          : 'COMPLETE_SUBMITTED';

    return `[UCP_CHECKOUT_FSM] state=${fsmState} action=RETURN_CHECKOUT_RESULT reason=create_then_complete
Created the external UCP checkout, captured checkoutId from the create response, and completed it with the current/default paymentInstrumentId.
Checkout ID: ${checkoutId}
Payment Instrument ID: ${paymentInstrumentId}
Instruction ID: ${authorization.instructionId}
Mandate ID: ${authorization.mandateId}
Create Result: ${JSON.stringify(createData)}
Complete Result: ${JSON.stringify(completeData)}${verifyData ? `\nVerify Result: ${JSON.stringify(verifyData)}` : ''}
UCP checkout completion is not merchant fulfillment. The merchant/product runtime still owns delivery, entitlement, receipt, and task resume.`;
  } catch (err) {
    await logError('ucp_checkout', err);
    return `[UCP_CHECKOUT_FSM] state=FAILED action=SURFACE_ERROR reason=${err instanceof ClinkCliError ? 'clink_cli_error' : 'local_validation_error'}
Failed to create and complete the UCP checkout: ${err.message}`;
  }
}

async function handle_get_purchase_instruction_manage_link(args = {}) {
  // Derive the agent-page origin from the backend-issued bindingUrl so it always
  // matches whatever environment the CLI actually talked to (env / CLI config /
  // default), with no skill-side base-URL configuration.
  let manageUrl;
  try {
    const { bindingUrl } = await resolvePurchaseInstructionBindingUrl();
    manageUrl = buildBareDomainUrl(bindingUrl);
  } catch (err) {
    await logError('get_purchase_instruction_manage_link/resolveUrl', err);
    return `Failed to resolve the authorization management link: ${err.message}`;
  }
  const notification = createMessageRequest({
    messageKey: 'payment.purchase_instruction_manage_link',
    vars: {
      manageUrl,
    },
  });

  try {
    const cache = await readPaymentMethodsCache() || {};
    let requestNotifyDestination = null;
    try {
      requestNotifyDestination = parseNotifyDestinationArgs(args);
    } catch (error) {
      return `ERROR: ${error.message}`;
    }
    if (requestNotifyDestination) {
      cache.notifyDestination = requestNotifyDestination;
      await writePaymentMethodsCache(cache);
    }
    const notifyDestination = requestNotifyDestination || getNotifyDestination(cache);

    if (notifyDestination) {
      try {
        sendNotificationDirect(notifyDestination, notification);
        return buildDirectSendDirective({
          summary: 'Purchase instruction management link delivered.',
          suffix: 'Use this page for 修改授权, 查看授权, and 取消 instruction 授权 requests.',
        });
      } catch (directSendError) {
        await logError('get_purchase_instruction_manage_link/direct_send', directSendError);
      }
    }

    await logNotificationFallback('get_purchase_instruction_manage_link', {
      cache,
      message: notification,
      reason: notifyDestination ? 'direct_send_failed' : 'missing_notify_destination',
    });
    return formatNotificationInstruction({
      summary: 'Purchase instruction management link generated.',
      notifications: notification,
      followUp: ['Use this page for 修改授权, 查看授权, and 取消 instruction 授权 requests.'],
    });
  } catch (err) {
    await logError('get_purchase_instruction_manage_link', err);
    return `Failed to get purchase instruction management link: ${err.message}`;
  }
}

async function handle_install_system_hooks(args) {
  let userEmail = "";
  try {
    const cache = await readPaymentMethodsCache();
    userEmail = cache?.email || "";
  } catch (err) { await logError('install_system_hooks', err); }

  let notifyDestination;
  try {
    notifyDestination = parseNotifyDestinationArgs(args);
  } catch (err) {
    return `[SYSTEM DIRECTIVE] Installation FAILED at step 0 (parse notify destination): ${err.message}`;
  }
  if (!notifyDestination) {
    return `[SYSTEM DIRECTIVE] Installation FAILED at step 0 (parse notify destination): channel, target_id, and target_type are required.`;
  }

  try {
    const cache = await readPaymentMethodsCache() || {};
    cache.notifyDestination = notifyDestination;
    await writePaymentMethodsCache(cache);
  } catch (err) {
    await logError('install_system_hooks/saveNotifyDestination', err);
    return `[SYSTEM DIRECTIVE] Installation FAILED (save notify destination): ${err.message}`;
  }

  // Async completion notifications are delivered by the mailbox event pump.
  // No webhook hook transform or /clink/payment route is installed anymore.
  ensureEventPumpRunning();

  const statusNotification = createMessageRequest({
    messageKey: 'install.success',
    vars: {
      userEmail,
    },
  });

  let statusNotificationSent = false;
  let statusNotificationError = null;
  try {
    sendNotificationDirect(notifyDestination, statusNotification);
    statusNotificationSent = true;
  } catch (err) {
    statusNotificationError = err;
    await logError('install_system_hooks/sendInitialNotification', err);
  }

  const openclawBin = resolveOpenClawExecutable();
  const restartChild = spawn('sh', ['-c', `sleep 3 && ${shellQuote(openclawBin)} gateway restart`], { detached: true, stdio: 'ignore' });
  restartChild.unref();

  if (statusNotificationSent) {
    return `DIRECT_SEND: Installation bootstrap completed. Gateway restart scheduled.

[SYSTEM DIRECTIVE] The installation success notification was already sent directly. Do NOT send it again. The user may reply with their email immediately; if the gateway is still restarting, they can retry a few seconds later.`;
  }

  return `SUCCESS: Installation completed. Gateway restart scheduled.

${formatNotificationInstruction({
  summary: 'Installation bootstrap completed.',
  notifications: statusNotification,
  followUp: [
    statusNotificationError ? `Initial direct-send failed: ${statusNotificationError.message}` : '',
    'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
  ],
})}`;
}

async function handle_uninstall_system_hooks(args) {
  const results = [];
  let notifyDestination = null;
  try {
    notifyDestination = parseNotifyDestinationArgs(args);
  } catch (err) {
    return `[SYSTEM DIRECTIVE] Uninstall FAILED at step 0 (parse notify destination): ${err.message}`;
  }
  if (!notifyDestination) {
    try {
      const cache = await readPaymentMethodsCache();
      notifyDestination = getNotifyDestination(cache);
    } catch (err) {
      await logError('uninstall_system_hooks/readNotifyDestination', err);
    }
  }
  if (!notifyDestination?.target?.id) {
    return `[SYSTEM DIRECTIVE] Uninstall FAILED at step 0.5 (resolve notify destination): channel, target_id, and target_type are required when no cached notify destination is available. No uninstall actions were started.`;
  }

  const hooksTarget = path.join(OPENCLAW_DIR, 'hooks', 'transforms', 'my_payment_webhook.mjs');
  try {
    await fs.unlink(hooksTarget);
    results.push("Webhook transform: removed ✓");
  } catch (err) {
    await logError('uninstall_system_hooks', err);
    results.push(err.code === 'ENOENT' ? "Webhook transform: already absent ✓" : `Webhook transform: FAILED to remove — ${err.message}`);
  }
  try {
    await fs.unlink(path.join(OPENCLAW_DIR, 'hooks', 'transforms', 'my_payment_webhook.js'));
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      await logError('uninstall_system_hooks', err);
    }
  }

  try {
    const config = await loadConfig();
    if (config.hooks?.mappings) {
      const before = config.hooks.mappings.length;
      config.hooks.mappings = config.hooks.mappings.filter(
        m => m.transform?.module !== "my_payment_webhook.js"
          && m.transform?.module !== "my_payment_webhook.mjs"
      );
      if (config.hooks.mappings.length < before) {
        await saveConfig(config);
        results.push("Route mapping: removed from openclaw.json ✓");
      } else {
        results.push("Route mapping: not found in config, skipped ✓");
      }
    } else {
      results.push("Route mapping: no hooks.mappings in config, skipped ✓");
    }
  } catch (err) {
    await logError('uninstall_system_hooks', err);
    results.push(`Route mapping: FAILED to clean config — ${err.message}`);
  }

  try {
    const config = await loadConfig();
    if (config.skills?.entries?.["agent-payment-skills"]) {
      delete config.skills.entries["agent-payment-skills"];
      await saveConfig(config);
      results.push("Skill config: removed from openclaw.json ✓");
    } else {
      results.push("Skill config: not found, skipped ✓");
    }
  } catch (err) {
    await logError('uninstall_system_hooks', err);
    results.push(`Skill config: FAILED to clean — ${err.message}`);
  }

  try {
    await fs.unlink(CACHE_PATH);
    results.push("Skill cache: removed ✓");
  } catch (err) {
    await logError('uninstall_system_hooks', err);
    results.push(err.code === 'ENOENT' ? "Skill cache: already absent ✓" : `Skill cache: FAILED to remove — ${err.message}`);
  }

  // Removing the cache leaves the event pump without credentials, so it self-exits
  // on its next cycle. Clear its lock so a fresh install can start cleanly.
  try {
    await fs.unlink(path.join(LOCK_DIR, 'event-pump.lock'));
    results.push("Event pump lock: cleared ✓");
  } catch (err) {
    if (err?.code !== 'ENOENT') await logError('uninstall_system_hooks/eventPumpLock', err);
  }

  for (const script of ['clink_notify.mjs', 'clink_uninstall_notify.mjs']) {
    try { await fs.unlink(path.join(OPENCLAW_DIR, 'cache', script)); } catch (err) { await logError('uninstall_system_hooks', err); }
  }

  const skillDir = SKILL_DIR;

  // Remove MCP server registration
  try {
    const { execFileSync } = await import('child_process');
    execFileSync('npx', [
      'mcporter',
      '--config',
      MCPORTER_CONFIG_PATH,
      'config',
      'remove',
      'agent-payment-skills',
    ], { encoding: 'utf8', stdio: 'pipe', timeout: 15000 });
    results.push("MCP server: unregistered ✓");
  } catch (err) {
    await logError('uninstall_system_hooks/mcp-remove', err);
    results.push(`MCP server: FAILED to unregister — ${err.message}`);
  }

  try {
    await fs.rm(skillDir, { recursive: true, force: true });
    results.push(`Skill directory: removed (${skillDir}) ✓`);
  } catch (err) {
    await logError('uninstall_system_hooks', err);
    results.push(`Skill directory: FAILED to remove — ${err.message}`);
  }

  const notifyScriptPath = path.join(OPENCLAW_DIR, 'cache', 'clink_uninstall_notify.mjs');
  const uninstallCompleteMessage = renderMessageMarkdown(
    createMessageRequest({ messageKey: 'uninstall.completed' }),
  );
  const notifyJsCode = `
import { execFileSync } from 'child_process';
const channel = ${JSON.stringify(notifyDestination.channel)};
const targetId = ${JSON.stringify(notifyDestination.target.id)};
const message = ${JSON.stringify(uninstallCompleteMessage)};

try {
  execFileSync('openclaw', ['message', 'send', '--channel', channel, '--target', targetId, '--message', message], { stdio: 'inherit' });
} catch (err) {
  console.error('Failed to send uninstall notification:', err.message);
}
`;
  await fs.mkdir(path.dirname(notifyScriptPath), { recursive: true });
  await fs.writeFile(notifyScriptPath, notifyJsCode, 'utf8');

  const { spawn } = await import('child_process');
  const nodeBin = process.execPath;

  const restartChild = spawn('sh', ['-c', 'sleep 3 && openclaw gateway restart'], { detached: true, stdio: 'ignore' });
  restartChild.unref();
  const notifyChild = spawn('sh', ['-c', `sleep 15 && ${nodeBin} ${notifyScriptPath}`], { detached: true, stdio: 'ignore' });
  notifyChild.unref();
  results.push("Gateway: scheduled restart in 3 seconds ✓");

  return `SUCCESS: Clink Payment Skill uninstalled. The gateway will restart in 3 seconds.

${formatNotificationInstruction({
  summary: 'Clink Payment Skill uninstall is in progress.',
  notifications: createMessageRequest({
    messageKey: 'uninstall.in_progress',
    vars: { results },
  }),
  followUp: [
    'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
  ],
})}`;
}

// ------------------------------------------------------------------
// MCP SERVER
// ------------------------------------------------------------------
const server = new Server(
  { name: "agent-payment-skills", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "initialize_wallet",
      description: "Run once per user. Calls the Clink wallet bootstrap via clink-cli, persists credentials, and starts the mailbox event pump.",
      inputSchema: {
        type: "object",
        properties: {
          email: { type: "string" },
          name: { type: "string" },
          channel: { type: "string", description: "Optional notify channel. Feishu supports native cards, Telegram supports rich text/media notifications, and other channels receive markdown/text notifications." },
          target_id: { type: "string", description: "Optional notify target ID used for the selected channel." },
          target_type: { type: "string", description: "Optional notify target type. For Feishu use chat_id or open_id." },
          locale: { type: "string", description: "Optional BCP 47 locale hint for message auto-localization, e.g. zh-CN or en-US." }
        },
        required: ["email"]
      }
    },
    {
      name: "get_wallet_status",
      description: "Check the local configuration status of the wallet (e.g., if it is initialized).",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "get_binding_link",
      description: "Generates a URL for the user to bind a new payment method and returns currently bound methods.",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Optional notify channel." },
          target_id: { type: "string", description: "Optional notify target ID used for direct delivery." },
          target_type: { type: "string", description: "Optional notify target type. For Feishu use chat_id or open_id." },
          locale: { type: "string", description: "Optional BCP 47 locale hint for message auto-localization, e.g. zh-CN or en-US." }
        }
      }
    },
    {
      name: "get_risk_rules_link",
      description: "Generates a URL for the user to configure recharge risk rules (per-charge limit, daily limit, frequency, etc.).",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Optional notify channel." },
          target_id: { type: "string", description: "Optional notify target ID used for direct delivery." },
          target_type: { type: "string", description: "Optional notify target type. For Feishu use chat_id or open_id." },
          locale: { type: "string", description: "Optional BCP 47 locale hint for message auto-localization, e.g. zh-CN or en-US." }
        }
      }
    },
    {
      name: "get_payment_method_setup_link",
      description: "Generates a URL for the user to add a new payment method (credit card, PayPal, etc.).",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Optional notify channel." },
          target_id: { type: "string", description: "Optional notify target ID used for direct delivery." },
          target_type: { type: "string", description: "Optional notify target type. For Feishu use chat_id or open_id." },
          locale: { type: "string", description: "Optional BCP 47 locale hint for message auto-localization, e.g. zh-CN or en-US." }
        }
      }
    },
    {
      name: "get_payment_method_modify_link",
      description: "Generates a URL for the user to manage, switch, or modify existing payment methods.",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Optional notify channel." },
          target_id: { type: "string", description: "Optional notify target ID used for direct delivery." },
          target_type: { type: "string", description: "Optional notify target type. For Feishu use chat_id or open_id." },
          locale: { type: "string", description: "Optional BCP 47 locale hint for message auto-localization, e.g. zh-CN or en-US." }
        }
      }
    },
    {
      name: "pre_check_account",
      description: "Run before clink_pay to verify account readiness and resolve the current/default card. For purchase/book/order intents, prefer prepare_visa_purchase_instruction; if this pre-check finds a Visa card, it routes the agent back to that state machine instead of normal charge.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "clink_pay",
      description: "Execute a payment via Clink. Direct mode: merchant_id + amount + currency. Session mode: sessionId from merchant. merchant_integration must include server, confirm_tool, and optional confirm_args.",
      inputSchema: {
        type: "object",
        properties: {
          merchant_id: { type: "string", description: "Merchant ID — fetch fresh via merchant tool each time, never from memory" },
          amount: { type: "number", description: "Recharge amount" },
          currency: { type: "string", description: "Currency code, e.g. USD (default)" },
          sessionId: { type: "string", description: "Charge session ID from merchant (session mode)" },
          merchant_integration: {
            type: "object",
            description: "Merchant handoff contract. Required fields: server, confirm_tool. Optional field: confirm_args."
          },
          paymentInstrumentId: { type: "string" },
          paymentMethodType: { type: "string" },
          channel: { type: "string", description: "Optional notify channel. If provided with target_id and target_type, it refreshes the cached notify destination." },
          target_id: { type: "string", description: "Optional notify target ID used for direct delivery." },
          target_type: { type: "string", description: "Optional notify target type. For Feishu use chat_id or open_id." },
          locale: { type: "string", description: "Optional BCP 47 locale hint for message auto-localization, e.g. zh-CN or en-US." }
        },
        required: ["merchant_integration"]
      }
    },
    {
      name: "clink_refund",
      description: "Apply for a full refund on an existing Clink order via the customer's Clink wallet.",
      inputSchema: {
        type: "object",
        properties: {
          orderId: { type: "string", description: "Clink order ID to refund in full" },
          channel: { type: "string", description: "Optional notify channel. If provided with target_id and target_type, it refreshes the cached notify destination." },
          target_id: { type: "string", description: "Optional notify target ID used for direct delivery." },
          target_type: { type: "string", description: "Optional notify target type. For Feishu use chat_id or open_id." },
          locale: { type: "string", description: "Optional BCP 47 locale hint for message auto-localization, e.g. zh-CN or en-US." }
        },
        required: ["orderId"]
      }
    },
    {
      name: "get_refund_status",
      description: "Query the latest status of an existing Clink refund order and return a status card.",
      inputSchema: {
        type: "object",
        properties: {
          refundOrderId: { type: "string", description: "Clink refund order ID to query" },
          channel: { type: "string", description: "Optional notify channel. If provided with target_id and target_type, it refreshes the cached notify destination." },
          target_id: { type: "string", description: "Optional notify target ID used for direct delivery." },
          target_type: { type: "string", description: "Optional notify target type. For Feishu use chat_id or open_id." },
          locale: { type: "string", description: "Optional BCP 47 locale hint for message auto-localization, e.g. zh-CN or en-US." }
        },
        required: ["refundOrderId"]
      }
    },
    {
      name: "prepare_visa_purchase_instruction",
      description: "VIC state machine: for purchase/book/order intents, resolve the current/default card; if it is Visa, handle VIC registration or list ACTIVE instructions by paymentInstrumentId and reuse/create a draft. fulfillmentType is required so the model cannot silently skip shipping-address collection for physical goods. This is the primary entrypoint for Visa purchase authorization; do not manually chain pre_check_account/list/create first.",
      inputSchema: {
        type: "object",
        properties: {
          paymentInstrumentId: { type: "string", description: "Optional selected payment instrument ID. If omitted, the current/default card is resolved." },
          title: { type: "string", description: "Instruction title" },
          description: { type: "string", description: "Optional instruction description" },
          effectiveUntilTime: { type: "string", description: "Optional instruction expiry as Unix epoch seconds, e.g. \"1782345600\"." },
          isRecurring: { type: "boolean", description: "Optional. Default false unless the user clearly authorizes recurring payments." },
          mandates: { type: "array", description: "Non-empty array of requested mandate rules: { title?, description, amountLimit, currencyCode, merchantCategoryCode?, preferredMerchantName?, effectiveUntilTime? }. Each mandate effectiveUntilTime is Unix epoch seconds." },
          fulfillmentType: {
            type: "string",
            enum: ["PHYSICAL_GOODS_REQUIRES_SHIPPING", "NO_SHIPPING_REQUIRED", "UNKNOWN"],
            description: "Required local classification. Use PHYSICAL_GOODS_REQUIRES_SHIPPING only for shipped physical goods, NO_SHIPPING_REQUIRED for hotels/tickets/services/subscriptions/digital goods/bookings/reservations, and UNKNOWN only when the user must clarify before list/create."
          },
          shippingAddress: {
            type: "object",
            description: "Required when fulfillmentType=PHYSICAL_GOODS_REQUIRES_SHIPPING. Only US shipping addresses are supported; countryCode must be US. Passed to POST /agent/cwallet/instructions as shippingAddress.",
            properties: {
              addressId: { type: "string" },
              name: { type: "string" },
              line1: { type: "string" },
              line2: { type: "string" },
              line3: { type: "string" },
              city: { type: "string" },
              state: { type: "string" },
              zip: { type: "string" },
              countryCode: { type: "string", description: "Must be US." },
              deliveryContactDetails: { type: "object" }
            }
          },
          extra: { type: "object", description: "Optional extra fields" },
          channel: { type: "string", description: "Optional notify channel. If provided with target_id and target_type, it refreshes the cached notify destination when a draft is created." },
          target_id: { type: "string", description: "Optional notify target ID used for direct delivery." },
          target_type: { type: "string", description: "Optional notify target type. For Feishu use chat_id or open_id." },
          locale: { type: "string", description: "Optional BCP 47 locale hint for message auto-localization, e.g. zh-CN or en-US." }
        },
        required: ["title", "fulfillmentType", "mandates"]
      }
    },
    {
      name: "list_purchase_instructions",
      description: "VIC: list the current customer's purchase instructions, optionally filtered by status and paymentInstrumentId. For a selected Visa card, pass status=ACTIVE and that exact paymentInstrumentId before creating a new draft.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["CREATED", "ACTIVE", "PENDING", "CANCELLED", "EXPIRED", "DECLINED"], description: "Optional status filter." },
          paymentInstrumentId: { type: "string", description: "Optional selected Visa paymentInstrumentId filter, e.g. pi_123456." }
        }
      }
    },
    {
      name: "ucp_checkout",
      description: "External UCP checkout state machine: resolve the current/default paymentInstrumentId, list ACTIVE instructions by paymentInstrumentId, match a valid instruction_id + mandate_id for the product/order scope, create an instruction draft when no match exists, otherwise run clink-cli ucp-checkout create then complete. This is not merchant fulfillment.",
      inputSchema: {
        type: "object",
        properties: {
          merchant_url: { type: "string", description: "External merchant product or checkout URL." },
          merchant_name: { type: "string", description: "Optional merchant display name." },
          merchant_category_code: { type: "string", description: "Merchant category code, e.g. 5311." },
          currency: { type: "string", description: "Checkout currency, e.g. USD." },
          title: { type: "string", description: "Instruction title used if no matching instruction+mandate exists and the tool must start the instruction creation workflow." },
          fulfillmentType: {
            type: "string",
            enum: ["PHYSICAL_GOODS_REQUIRES_SHIPPING", "NO_SHIPPING_REQUIRED", "UNKNOWN"],
            description: "Instruction workflow fulfillment classification. Required so missing checkout authorization can create the right instruction draft."
          },
          mandates: { type: "array", description: "Requested mandate scope used to match an ACTIVE instruction+mandate and to create a draft when no match exists." },
          instruction_id: { type: "string", description: "Optional instruction ID hint. The tool still lists ACTIVE instructions and verifies the hint before checkout." },
          mandate_id: { type: "string", description: "Optional mandate ID hint. The tool still lists ACTIVE instructions and verifies the hint before checkout." },
          line_items: { type: "array", description: "UCP line_items array. Prices are minor units and must match the product/order truth." },
          buyer: { type: "object", description: "Optional buyer object required by the merchant checkout." },
          shipping_address: { type: "object", description: "Optional shipping address for physical goods that ship." },
          metadata: { type: "object", description: "Optional metadata object for correlation." },
          paymentInstrumentId: { type: "string", description: "Optional selected payment instrument. If omitted, the refreshed current/default method is used." },
          create_idempotency_key: { type: "string", description: "Optional idempotency key for create, stable for the same cart/order attempt." },
          complete_idempotency_key: { type: "string", description: "Optional idempotency key for complete, scoped to checkoutId + paymentInstrumentId." }
        },
        required: ["merchant_url", "merchant_category_code", "currency", "title", "fulfillmentType", "mandates", "line_items"]
      }
    },
    {
      name: "get_purchase_instruction_manage_link",
      description: "VIC: when the user asks to 修改授权 查看授权 取消 instruction 授权, or semantically similar manage/view/edit/cancel authorization requests, return the agent UI link (the agent origin derived from the configured Clink environment, e.g. https://agent.clinkbill.com in production or https://agent.clinkbill.dev in sandbox). Feishu renders this as a button; other channels receive a link.",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Optional notify channel. Feishu supports native button cards; other channels receive markdown/text links." },
          target_id: { type: "string", description: "Optional notify target ID used for direct delivery." },
          target_type: { type: "string", description: "Optional notify target type. For Feishu use chat_id or open_id." },
          locale: { type: "string", description: "Optional BCP 47 locale hint for message auto-localization, e.g. zh-CN or en-US." }
        }
      }
    },
    {
      name: "install_system_hooks",
      description: "Save notify routing, refresh the event pump when usable wallet credentials are available, and restart the gateway in the background after a 3-second delay. MCP registration is performed by pre_install.mjs.",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Notify channel. Feishu supports native cards, Telegram supports rich text/media notifications, and other channels receive markdown/text notifications." },
          target_id: { type: "string", description: "Notify target ID used after gateway restart." },
          target_type: { type: "string", description: "Notify target type. For Feishu use chat_id or open_id." },
          locale: { type: "string", description: "Optional BCP 47 locale hint for message auto-localization, e.g. zh-CN or en-US." }
        },
        required: []
      }
    },
    {
      name: "uninstall_system_hooks",
      description: "卸载 Clink Payment Skill：清除事件轮询器（event pump）、遗留 webhook 配置、skill 配置与缓存，并在后台延迟 3 秒重启网关。必须在用户输入文字授权后才能调用。",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Optional notify channel. Feishu supports native cards, Telegram supports rich text/media notifications, and other channels receive markdown/text notifications." },
          target_id: { type: "string", description: "Optional notify target ID used after uninstall." },
          target_type: { type: "string", description: "Optional notify target type. For Feishu use chat_id or open_id." },
          locale: { type: "string", description: "Optional BCP 47 locale hint for message auto-localization, e.g. zh-CN or en-US." }
        },
        required: []
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    let result;
    switch (name) {
      case "initialize_wallet":             result = await handle_initialize_wallet(args); break;
      case "get_wallet_status":             result = await handle_get_wallet_status(); break;
      case "get_binding_link":              result = await handle_get_binding_link(args); break;
      case "get_risk_rules_link":           result = await handle_get_risk_rules_link(args); break;
      case "get_payment_method_setup_link": result = await handle_get_payment_method_setup_link(args); break;
      case "get_payment_method_modify_link":result = await handle_get_payment_method_modify_link(args); break;
      case "pre_check_account":             result = await handle_pre_check_account(); break;
      case "clink_pay":                     result = await handle_clink_pay(args); break;
      case "clink_refund":                  result = await handle_clink_refund(args); break;
      case "get_refund_status":             result = await handle_get_refund_status(args); break;
      case "prepare_visa_purchase_instruction": result = await handle_prepare_visa_purchase_instruction(args); break;
      case "list_purchase_instructions":    result = await handle_list_purchase_instructions(args); break;
      case "ucp_checkout":                  result = await handle_ucp_checkout(args); break;
      case "get_purchase_instruction_manage_link": result = await handle_get_purchase_instruction_manage_link(args); break;
      case "install_system_hooks":          result = await handle_install_system_hooks(args); break;
      case "uninstall_system_hooks":        result = await handle_uninstall_system_hooks(args); break;
      default: throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: result }] };
  } catch (error) {
    await logError(name, error);
    return { content: [{ type: "text", text: `Error executing ${name}: ${error.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Agent Payment Skills MCP Server running on stdio");
