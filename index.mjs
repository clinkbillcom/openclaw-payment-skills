import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import crypto from "crypto";
import { execFileSync, spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import https from "https";
import { CONFIG } from "./config.mjs";
import {
  buildMessagePreviewTitle,
  createMessageRequest,
  renderMessageMarkdown,
} from "./notification-utils.js";
import {
  buildDirectSendDirective,
  getReusableAsyncOperation,
} from "./poll-fallback-utils.mjs";
import {
  isVisaRegistrationSucceeded,
  resolveVicRegistrationState,
  VIC_REGISTRATION_STATE_TTL_MS,
} from "./vic-registration-state-utils.mjs";

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
    if (cache?.webhookSignKey) env.CLINK_WEBHOOK_SIGNKEY = cache.webhookSignKey;
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
const POLL_FALLBACK_SCRIPT = path.join(SKILL_DIR, 'scripts', 'poll-fallback.mjs');
const PURCHASE_INSTRUCTION_MANAGE_URL = 'https://uat-agent.clinkbill.com';
const POLL_START_DELAY_MS = 30_000;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 120_000;

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

async function renderWebhookModule(skillDir) {
  const webhookTemplatePath = path.join(skillDir, 'hooks', 'my_payment_webhook.mjs');
  const webhookSource = await fs.readFile(webhookTemplatePath, 'utf8');
  return webhookSource.split('__AGENT_PAYMENT_SKILL_DIR__').join(JSON.stringify(skillDir));
}

function normalizeCache(cache) {
  const normalized = cache && typeof cache === 'object' ? cache : {};
  if (!Array.isArray(normalized.paymentMethods)) normalized.paymentMethods = [];
  if (normalized.defaultPaymentMethodId === undefined) normalized.defaultPaymentMethodId = null;
  if (normalized.webhookAvailable === undefined) normalized.webhookAvailable = null;
  if (!normalized.asyncOperations || typeof normalized.asyncOperations !== 'object') {
    normalized.asyncOperations = {};
  }
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

function isWebhookAvailable(cache) {
  return normalizeCache(cache).webhookAvailable !== false;
}

function createAsyncOperationId(type) {
  return `${String(type)}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function buildAsyncOperation(type, snapshotBefore, notifyDestination, details = {}) {
  const now = Date.now();
  return {
    id: createAsyncOperationId(type),
    type,
    status: 'pending',
    createdAt: now,
    firstPollAt: now + POLL_START_DELAY_MS,
    expireAt: now + POLL_TIMEOUT_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
    retryCount: 0,
    snapshotBefore: cloneJsonValue(snapshotBefore),
    notifyDestination: notifyDestination ? cloneJsonValue(notifyDestination) : null,
    ...(details && typeof details === 'object' && !Array.isArray(details) ? cloneJsonValue(details) : {}),
    lastError: '',
    resultPayload: null,
  };
}

function spawnPollFallbackProcessor(operationId) {
  const child = spawn(process.execPath, [POLL_FALLBACK_SCRIPT, '--operation-id', operationId], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function schedulePollFallbackOperation(type, snapshotBefore, notifyDestination = null, details = {}) {
  const cache = normalizeCache(await readPaymentMethodsCache() || {});
  if (isWebhookAvailable(cache)) {
    return null;
  }

  const activeOperation = getReusableAsyncOperation(cache, type, Date.now(), details);
  if (activeOperation) {
    if (notifyDestination) {
      activeOperation.notifyDestination = cloneJsonValue(notifyDestination);
      cache.asyncOperations[activeOperation.id] = activeOperation;
      await writePaymentMethodsCache(cache);
    }
    await logRequest('poll_fallback/reuse_operation', {
      operationId: activeOperation.id,
      type,
      notifyDestinationUpdated: Boolean(notifyDestination),
    }, { reused: true });
    return activeOperation;
  }

  const operation = buildAsyncOperation(type, snapshotBefore, notifyDestination || getNotifyDestination(cache), details);
  cache.asyncOperations[operation.id] = operation;
  await writePaymentMethodsCache(cache);
  spawnPollFallbackProcessor(operation.id);
  await logRequest('poll_fallback/create_operation', {
    operationId: operation.id,
    type,
    firstPollAt: operation.firstPollAt,
    expireAt: operation.expireAt,
  }, { scheduled: true });
  return operation;
}

async function schedulePollFallbackOperationSafely(type, snapshotBefore, notifyDestination = null, details = {}) {
  try {
    return await schedulePollFallbackOperation(type, snapshotBefore, notifyDestination, details);
  } catch (error) {
    await logError(`poll_fallback/${type}`, error);
    return null;
  }
}

function requiresPollFallback(cache) {
  return normalizeCache(cache).webhookAvailable === false;
}

async function ensureRequiredPollFallback(type, snapshotBefore, cache, notifyDestination = null, details = {}) {
  const normalizedCache = normalizeCache(cache);
  if (!requiresPollFallback(normalizedCache)) {
    return { required: false, operation: null };
  }
  const operation = await schedulePollFallbackOperationSafely(
    type,
    snapshotBefore,
    notifyDestination || getNotifyDestination(normalizedCache),
    details,
  );
  return {
    required: true,
    operation: operation ? cloneJsonValue(operation) : null,
  };
}

function getRequiredPollFallbackLines({ fallback, successEvent }) {
  if (!fallback?.required) return [];
  if (!fallback.operation) {
    return [
      'MANDATORY: webhookAvailable=false — poll fallback could not be scheduled automatically.',
      `This flow is NOT complete. Do NOT stop here. Retry and continue checking for ${successEvent} until success, failure, or timeout.`,
    ];
  }
  return [
    'MANDATORY: webhookAvailable=false — poll fallback is active.',
    `This flow is NOT complete. Continue monitoring for ${successEvent} until success, failure, or timeout.`,
    `Poll fallback operation: ${fallback.operation.id}`,
  ];
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
// API HELPERS
// ------------------------------------------------------------------
const BASE_URL = CONFIG.API_BASE_URL;

class ClinkApiError extends Error {
  constructor(code, msg, raw) {
    super(msg || `Clink API Error (code: ${code})`);
    this.code = code;
    this.raw = raw;
  }
}

function httpsRequest(urlStr, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const bodyStr = body ? JSON.stringify(body) : null;
    const reqOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
        ...(options.headers || {})
      }
    };
    const req = https.request(reqOptions, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Failed to parse response: ${data}`)); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function fetchClink(endpoint, options = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const body = options.body ? JSON.parse(options.body) : null;
  const data = await httpsRequest(url, { method: options.method || "GET", headers: options.headers }, body);
  if (data.code !== 200) {
    throw new ClinkApiError(data.code, data.msg, data);
  }
  return data.data;
}

function getPublicIp() {
  return new Promise((resolve) => {
    https.get('https://api.ipify.org', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data.trim()));
    }).on('error', () => resolve('127.0.0.1'));
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
  const data = await fetchClink('/agent/cwallet/card/bindingLink', {
    method: 'POST',
    headers: {
      "X-Customer-API-Key": env.CLINK_CUSTOMER_API_KEY,
      "X-Customer-ID": env.CLINK_CUSTOMER_ID,
      "X-Timestamp": Date.now().toString()
    }
  });
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

function buildRiskRulesNotification(bindingUrl) {
  const riskUrl = buildBareDomainUrl(bindingUrl);
  return createMessageRequest({
    messageKey: 'risk.rules_link',
    vars: { riskUrl },
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
  const snapshotBefore = latestMethods.length > 0
    ? latestMethods
    : normalizePaymentMethods(cache.paymentMethods || [method]);
  const pollFallback = await ensureRequiredPollFallback(
    'vic_registration',
    snapshotBefore,
    cache,
    effectiveNotifyDestination,
    { paymentInstrumentId },
  );
  const pollFallbackLines = getRequiredPollFallbackLines({
    fallback: pollFallback,
    successEvent: 'payment_method.added/update with visaRegistrationSucceeded=true for the same paymentInstrumentId',
  });

  const followUp = [
    'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
    'Do NOT create a purchase instruction and do NOT charge until this same Visa payment method appears with visaRegistrationSucceeded=true.',
    ...(pollFallback.required
      ? pollFallbackLines
      : ['Wait for the payment-method webhook or refresh payment methods until visaRegistrationSucceeded=true, then continue the VIC purchase instruction flow.']),
  ];

  if (!vicState.shouldNotify) {
    return {
      blocked: true,
      route: 'vic_registration_pending',
      paymentMethod: method,
      response: buildDirectSendDirective({
        summary: 'VIC registration is already pending for this Visa card.',
        pollFallback,
        pollFallbackLines,
        webhookWaitMessage: 'Wait for the payment-method webhook or refresh payment methods until visaRegistrationSucceeded=true, then continue the VIC purchase instruction flow.',
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
          pollFallback,
          pollFallbackLines,
          webhookWaitMessage: 'Wait for the payment-method webhook or refresh payment methods until visaRegistrationSucceeded=true, then continue the VIC purchase instruction flow.',
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
  const openclawConfig = await loadConfig();
  let signkey = openclawConfig.hooks?.token || '';
  if (!signkey) {
    signkey = crypto.randomBytes(32).toString('hex');
    openclawConfig.hooks = openclawConfig.hooks || {};
    openclawConfig.hooks.token = signkey;
    await saveConfig(openclawConfig);
  }

  try {
    const cache = await readPaymentMethodsCache() || {};
    const notifyDestination = parseNotifyDestinationArgs(args);
    if (notifyDestination) {
      cache.notifyDestination = notifyDestination;
    }
    cache.webhookSignKey = signkey;
    cache.email = args.email;
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    cache.cachedAt = new Date().toISOString();
    await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    await logError('initialize_wallet/saveInitialCache', err);
    return `Failed to save to cache: ${err.message}`;
  }

  try {
    const port = openclawConfig.gateway?.port || 14924;
    const publicIp = await getPublicIp();
    const realCallbackUrl = `http://${publicIp}:${port}/hooks/clink/payment`;

    const bootstrapPayload = {
        webhookSignKey: signkey,
        callbackUrl: realCallbackUrl,
        source: "agent",
        email: args.email,
        name: args.name || "Agent User"
      };
    const bootstrapJson = await httpsRequest(
      `${BASE_URL}/agent/cwallet/customer/bootstrap`,
      { method: 'POST' },
      bootstrapPayload
    );
    await logRequest('initialize_wallet/bootstrap', bootstrapPayload, bootstrapJson);
    if (bootstrapJson.code !== 200) {
      throw new ClinkApiError(bootstrapJson.code, bootstrapJson.msg, bootstrapJson);
    }
    const data = bootstrapJson.data;

    try {
      const cache = await readPaymentMethodsCache() || {};
      cache.customerId = data.customerId;
      cache.customerAPIKey = data.customerAPIKey;
      if (typeof data.webhook_available === 'boolean') {
        cache.webhookAvailable = data.webhook_available;
      } else if (typeof data.webhookAvailable === 'boolean') {
        cache.webhookAvailable = data.webhookAvailable;
      }
      cache.cachedAt = new Date().toISOString();
      await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
      await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
    } catch (err) {
      await logError('initialize_wallet/saveCustomerData', err);
      return `Failed to save customer data to cache: ${err.message}`;
    }

    return `Clink 账户 Bootstrap 成功。
[SYSTEM DIRECTIVE]
Wallet bootstrap completed for ${args.email}. Customer ID: ${data.customerId}. Generated webhook signkey and saved to config.

You MUST NOT output ANY text to the user yet.
You MUST IMMEDIATELY call the "get_binding_link" tool to check for existing payment methods.

After calling "get_binding_link", use the returned Markdown notification content for the current channel.
If "get_binding_link" returns a DIRECT_SEND system directive, do NOT send any additional markdown or notification in this turn.
If the cached wallet state says webhookAvailable=false, "get_binding_link" MUST start the poll fallback flow and you MUST continue waiting for that async completion path instead of stopping at WAIT_FOR_WEBHOOK.
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
      const pollFallback = await ensureRequiredPollFallback(
        'bind_card',
        normalizePaymentMethods(methods),
        cache,
        notifyDestination,
      );
      const pollFallbackLines = getRequiredPollFallbackLines({
        fallback: pollFallback,
        successEvent: 'payment_method.added',
      });
      let fallbackReason = 'missing_notify_destination';
      if (notifyDestination) {
        try {
          sendNotificationDirect(notifyDestination, notification);
          return buildDirectSendDirective({
            summary: 'Binding notification delivered.',
            pollFallback,
            pollFallbackLines,
            webhookWaitMessage: 'Wait for the payment_method.added webhook before continuing initialization.',
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
    ...(pollFallback.required
      ? pollFallbackLines
      : ['Wait for the payment_method.added webhook before continuing initialization.']),
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
      const riskNotification = buildRiskRulesNotification(bindingUrl);
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
    const { bindingUrl } = await fetchBindingData();
    const notification = buildRiskRulesNotification(bindingUrl);
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
    const snapshotBefore = normalizeRuleSettings(cache.riskRules);
    const pollFallback = await ensureRequiredPollFallback(
      'update_rule',
      snapshotBefore,
      cache,
      notifyDestination,
    );
    const pollFallbackLines = getRequiredPollFallbackLines({
      fallback: pollFallback,
      successEvent: 'risk_rule.updated',
    });
    let fallbackReason = 'missing_notify_destination';

    if (notifyDestination) {
      try {
        sendNotificationDirect(notifyDestination, notification);
        return buildDirectSendDirective({
          summary: 'Risk rules link generated.',
          pollFallback,
          pollFallbackLines,
          webhookWaitMessage: 'Wait for the risk_rule.updated webhook before treating the change as complete.',
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
        ...(pollFallback.required
          ? pollFallbackLines
          : ['Wait for the risk_rule.updated webhook before treating the change as complete.']),
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
    const snapshotBefore = normalizePaymentMethods(methods);
    const pollFallback = await ensureRequiredPollFallback(
      'bind_card',
      snapshotBefore,
      cache,
      notifyDestination,
    );
    const pollFallbackLines = getRequiredPollFallbackLines({
      fallback: pollFallback,
      successEvent: 'payment_method.added',
    });
    let fallbackReason = 'missing_notify_destination';

    if (notifyDestination) {
      try {
        sendNotificationDirect(notifyDestination, notification);
        return buildDirectSendDirective({
          summary: 'Payment method setup link generated.',
          pollFallback,
          pollFallbackLines,
          webhookWaitMessage: 'Wait for the payment_method.added webhook before treating the setup as complete.',
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
        ...(pollFallback.required
          ? pollFallbackLines
          : ['Wait for the payment_method.added webhook before treating the setup as complete.']),
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
    const snapshotBefore = normalizePaymentMethods(methods);
    const pollFallback = await ensureRequiredPollFallback(
      'change_card',
      snapshotBefore,
      cache,
      notifyDestination,
    );
    const pollFallbackLines = getRequiredPollFallbackLines({
      fallback: pollFallback,
      successEvent: 'payment_method.added',
    });
    let fallbackReason = 'missing_notify_destination';

    if (notifyDestination) {
      try {
        sendNotificationDirect(notifyDestination, notification);
        return buildDirectSendDirective({
          summary: 'Payment method management link generated.',
          pollFallback,
          pollFallbackLines,
          webhookWaitMessage: 'Wait for the payment_method.added webhook before treating the change as complete.',
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
        ...(pollFallback.required
          ? pollFallbackLines
          : ['Wait for the payment_method.added webhook before treating the change as complete.']),
        '',
        `Current Payment Methods: ${JSON.stringify(methods)}`,
      ],
    });
  } catch (err) {
    await logError('get_payment_method_modify_link', err);
    return `Failed to get payment method modify link: ${err.message}`;
  }
}

async function handle_list_payment_methods(args) {
  if (!args.bindingToken) {
    return "Requires bindingToken (usually obtained from binding link or session).";
  }
  try {
    const data = await fetchClink('/a/cwallet/card/info', {
      method: 'GET',
      headers: { "Authorization": `Bearer ${args.bindingToken}` }
    });
    return `Payment Methods for ${data.email}:\n${JSON.stringify(data.paymentMethods, null, 2)}`;
  } catch (err) {
    await logError('list_payment_methods', err);
    return `Failed to list payment methods: ${err.message}`;
  }
}

async function handle_get_payment_method_detail(args) {
  try {
    const data = await fetchClink(`/a/cwallet/card/detail?paymentInstrumentId=${args.paymentInstrumentId}`, {
      method: 'GET',
      headers: { "Authorization": `Bearer ${args.bindingToken}` }
    });
    return `${formatNotificationInstruction({
      summary: 'Payment method detail retrieved.',
      notifications: createMessageRequest({
        messageKey: 'payment.method.detail',
        vars: {
          cardDisplay: formatPaymentMethodDisplay({
            paymentMethodType: data.paymentMethodType || data.paymentInstrumentType,
            cardBrand: data.cardBrand || data.cardScheme,
            cardLast4: data.cardLast4 || data.cardLastFour,
            walletAccountTag: data.walletAccountTag || data.wallet?.accountTag,
          }),
          billingRegion: data.billingAddressJson?.country || 'N/A',
        },
      }),
      followUp: [`Raw Data: ${JSON.stringify(data)}`],
    })}`;
  } catch (err) {
    await logError('get_payment_method_detail', err);
    return `Failed to get payment method detail: ${err.message}`;
  }
}

async function handle_update_payment_method(args) {
  try {
    const data = await fetchClink('/a/cwallet/card/update', {
      method: 'PUT',
      headers: { "Authorization": `Bearer ${args.bindingToken}` },
      body: JSON.stringify({ paymentInstrumentId: args.paymentInstrumentId, billingAddressJson: args.billingAddressJson })
    });
    return `Payment method updated successfully: ${data}`;
  } catch (err) {
    await logError('update_payment_method', err);
    return `Failed to update payment method: ${err.message}`;
  }
}

async function handle_delete_payment_method(args) {
  try {
    const data = await fetchClink('/a/cwallet/card/delete', {
      method: 'DELETE',
      headers: { "Authorization": `Bearer ${args.bindingToken}` },
      body: JSON.stringify({ paymentInstrumentId: args.paymentInstrumentId })
    });
    return `Payment method deleted successfully: ${data}`;
  } catch (err) {
    await logError('delete_payment_method', err);
    return `Failed to delete payment method: ${err.message}`;
  }
}

async function handle_set_default_payment_method(args) {
  try {
    const requestPayload = { paymentInstrumentId: args.paymentInstrumentId };
    const data = await fetchClink('/a/cwallet/card/setDefault', {
      method: 'PUT',
      headers: { "Authorization": `Bearer ${args.bindingToken}` },
      body: JSON.stringify(requestPayload)
    });
    await logRequest('set_default_payment_method', requestPayload, data);
    return `${formatNotificationInstruction({
      summary: 'Payment method set as default successfully.',
      notifications: createMessageRequest({ messageKey: 'payment.method.default_updated' }),
      followUp: [
        'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
        `Raw Data: ${data}`,
      ],
    })}`;
  } catch (err) {
    await logError('set_default_payment_method', err);
    return `Failed to set default payment method: ${err.message}`;
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
  const chargeBody = { paymentInstrumentId: piId, paymentMethodType: pmType };

  if (args.sessionId) {
    chargeBody.sessionId = args.sessionId;
  } else {
    chargeBody.merchantId = args.merchant_id;
    chargeBody.customAmount = args.amount;
    chargeBody.paymentCurrency = args.currency || "USD";
  }

  try {
    const data = await fetchClink('/agent/order/charge', {
      method: 'POST',
      headers: { "X-Customer-API-Key": env.CLINK_CUSTOMER_API_KEY, "X-Timestamp": timestamp },
      body: JSON.stringify(chargeBody)
    });

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

    if (data.channelPaymentResponse && data.channelPaymentResponse.flag3DS === 1) {
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
          'After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.',
          'Do NOT continue until the webhook confirms agent_order.succeeded or agent_order.failed.',
        ],
      });
    }

    if (status === 1) {
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
The payment success notification has already been sent to the user.
Immediate merchant recharge confirmation handoff failed in the background.
Do NOT send any additional notification in this turn.
Do NOT invoke the merchant-side recharge-status checker again in this turn.
Wait for the later async webhook to retry the merchant confirmation and original-task resume flow.`;
        }

        if (sendResult === 'already_completed') {
          return `[SYSTEM DIRECTIVE] Payment already succeeded synchronously.
The payment success notification was already sent earlier.
The merchant recharge confirmation handoff was already triggered earlier.
Do NOT send any additional notification in this turn.
Do NOT invoke the merchant-side recharge-status checker again in this turn.`;
        }

        return `[SYSTEM DIRECTIVE] Payment already succeeded synchronously.
The payment success notification has already been sent to the user.
Do NOT send any additional notification in this turn.
Do NOT invoke the merchant-side recharge-status checker again in this turn.`;
      } catch (sendErr) {
        await logError('clink_pay/sync_success_card', sendErr);
        return `[SYSTEM DIRECTIVE] Payment already succeeded synchronously.
Direct notification delivery failed, so do NOT send any fallback notification in this turn.
Do NOT invoke the merchant-side recharge-status checker in this turn.
Wait for the later async webhook to continue the merchant confirmation and original-task resume flow.`;
      }
    }

    if (status === 3 || status === 4 || status === 6) {
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
The failure notification was already sent earlier.
Do NOT send any additional notification in this turn.
Do NOT retry automatically.`;
        }
        return `[SYSTEM DIRECTIVE] Payment already ended with a terminal failure in the synchronous charge response.
The failure notification has already been sent to the user.
Do NOT send any additional notification in this turn.
Do NOT retry automatically.`;
      } catch (sendErr) {
        await logError('clink_pay/sync_failure_card', sendErr);
        return `[SYSTEM DIRECTIVE] Payment already ended with a terminal failure in the synchronous charge response.
Direct notification delivery failed, so do NOT send any fallback notification in this turn.
Do NOT retry automatically.`;
      }
    }

    await savePendingMerchantConfirmation(merchantIntegration, sessionId, notifyDestination);

    return `[SYSTEM DIRECTIVE] Payment submitted successfully. Order is now processing.
Do NOT send any intermediate "处理中" notification to the user for this state.
Do not send any extra notification in this turn. A brief natural-language reply is fine if helpful.
Do NOT ask the user any question.
Do NOT invoke the merchant-side recharge-status checker in this turn.
The merchant-side recharge confirmation and original-task resume must be driven by the payment-layer success handoff that owns this order. For pending / 3DS flows, wait for the later async webhook wake for payment/agent_order.succeeded.`;
  } catch (err) {
    await logError('clink_pay', err);
    const code = err instanceof ClinkApiError ? err.code : null;
    const currency = args.currency || "USD";
    const amt = formatAmountWithCurrency(args.amount, currency);

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
          'Wait for the previous order to complete via webhook callback.',
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

  const timestamp = Date.now().toString();
  const refundBody = {
    orderId,
  };

  try {
    const data = await fetchClink('/agent/cwallet/refund/apply', {
      method: 'POST',
      headers: {
        "X-Customer-API-Key": env.CLINK_CUSTOMER_API_KEY,
        "X-Timestamp": timestamp,
      },
      body: JSON.stringify(refundBody),
    });
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
Wait for the later refund webhook to deliver the final success/failure notification. The refund remains pending manual review/processing until the user explicitly asks to query its status.`;
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
        'Wait for the later refund webhook to deliver the final success/failure notification.',
        'Do NOT auto-start refund status polling. Query get_refund_status only when the user explicitly asks about refund progress/status.',
      ],
    });
  } catch (err) {
    await logError('clink_refund', err);
    const code = err instanceof ClinkApiError ? err.code : null;
    const failureReason = err instanceof ClinkApiError
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

  const timestamp = Date.now().toString();
  try {
    const data = await fetchClink(`/agent/cwallet/refund/${encodeURIComponent(refundOrderId)}`, {
      method: 'GET',
      headers: {
        "X-Customer-API-Key": env.CLINK_CUSTOMER_API_KEY,
        "X-Timestamp": timestamp,
      },
    });
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
    const code = err instanceof ClinkApiError ? err.code : null;
    const reason = err instanceof ClinkApiError
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
async function fetchInstruction(endpoint, method, bodyObj) {
  const env = await getPaymentEnv();
  if (!env.CLINK_CUSTOMER_API_KEY) {
    throw new Error("Wallet not initialized. Please run initialize_wallet first.");
  }
  // Instruction endpoints authenticate by customer API key only (no X-Customer-ID).
  return fetchClink(endpoint, {
    method,
    headers: {
      "X-Customer-API-Key": env.CLINK_CUSTOMER_API_KEY,
      "X-Timestamp": Date.now().toString(),
    },
    body: bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined,
  });
}

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
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = String(value).trim();
  if (!raw) return null;
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
    const endpoint = `/agent/cwallet/instructions?status=ACTIVE&paymentInstrumentId=${encodeURIComponent(paymentInstrumentId)}`;
    const activeInstructions = await fetchInstruction(endpoint, 'GET');
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
    const data = await fetchInstruction('/agent/cwallet/instructions', 'POST', body);
    await logRequest('create_purchase_instruction', body, data);
    if (!data?.instructionId) {
      return `Purchase instruction created, but the response did not include instructionId. It is NOT usable until you call sign_purchase_instruction with the user's Passkey result.\nRaw Data: ${JSON.stringify(data)}`;
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

async function handle_sign_purchase_instruction(args = {}) {
  if (!args.instructionId) return "ERROR: sign_purchase_instruction requires 'instructionId'.";
  if (!args.appInstance || typeof args.appInstance !== 'object') return "ERROR: sign_purchase_instruction requires 'appInstance'.";
  if (!args.authResult || typeof args.authResult !== 'object') return "ERROR: sign_purchase_instruction requires 'authResult' from the front-end Passkey flow.";

  const body = { appInstance: args.appInstance, authResult: args.authResult };
  if (args.extra !== undefined) body.extra = args.extra;

  try {
    const data = await fetchInstruction(`/agent/cwallet/instructions/${encodeURIComponent(args.instructionId)}/sign`, 'POST', body);
    // Never log authResult — it carries fidoBlob.
    await logRequest('sign_purchase_instruction', { instructionId: args.instructionId, appInstance: args.appInstance, authResult: '[REDACTED]' }, data);
    return `Purchase instruction signed (now ACTIVE). The VIC payment entry and request field are pending backend confirmation.\nRaw Data: ${JSON.stringify(data)}`;
  } catch (err) {
    await logError('sign_purchase_instruction', err);
    return `Failed to sign purchase instruction: ${err.message}`;
  }
}

async function handle_list_purchase_instructions(args = {}) {
  const params = new URLSearchParams();
  if (args.status) params.set('status', args.status);
  if (args.paymentInstrumentId) params.set('paymentInstrumentId', args.paymentInstrumentId);
  const qs = params.toString() ? `?${params.toString()}` : '';
  try {
    const data = await fetchInstruction(`/agent/cwallet/instructions${qs}`, 'GET');
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

async function handle_get_purchase_instruction_manage_link(args = {}) {
  const notification = createMessageRequest({
    messageKey: 'payment.purchase_instruction_manage_link',
    vars: {
      manageUrl: PURCHASE_INSTRUCTION_MANAGE_URL,
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

async function handle_get_purchase_instruction(args = {}) {
  if (!args.instructionId) return "ERROR: get_purchase_instruction requires 'instructionId'.";
  try {
    const data = await fetchInstruction(`/agent/cwallet/instructions/${encodeURIComponent(args.instructionId)}`, 'GET');
    return `Purchase instruction detail:\n${JSON.stringify(data, null, 2)}`;
  } catch (err) {
    await logError('get_purchase_instruction', err);
    return `Failed to get purchase instruction: ${err.message}`;
  }
}

async function handle_update_purchase_instruction(args = {}) {
  if (!args.instructionId) return "ERROR: update_purchase_instruction requires 'instructionId'.";
  if (!args.paymentInstrumentId || !args.title || !Array.isArray(args.mandates) || args.mandates.length === 0) {
    return "ERROR: update_purchase_instruction is a full update; it requires 'paymentInstrumentId', 'title', and a non-empty 'mandates' array.";
  }
  if (!args.appInstance || !args.authResult) return "ERROR: update_purchase_instruction requires fresh 'appInstance' and 'authResult' (re-authentication).";

  const body = {
    paymentInstrumentId: args.paymentInstrumentId,
    title: args.title,
    mandates: args.mandates,
    appInstance: args.appInstance,
    authResult: args.authResult,
  };
  if (args.description !== undefined) body.description = args.description;
  if (args.effectiveUntilTime !== undefined) body.effectiveUntilTime = args.effectiveUntilTime;
  if (args.extra !== undefined) body.extra = args.extra;

  try {
    const data = await fetchInstruction(`/agent/cwallet/instructions/${encodeURIComponent(args.instructionId)}`, 'PUT', body);
    await logRequest('update_purchase_instruction', { ...body, authResult: '[REDACTED]' }, data);
    return `Purchase instruction updated.\nRaw Data: ${JSON.stringify(data)}`;
  } catch (err) {
    await logError('update_purchase_instruction', err);
    return `Failed to update purchase instruction: ${err.message}`;
  }
}

async function handle_cancel_purchase_instruction(args = {}) {
  if (!args.instructionId) return "ERROR: cancel_purchase_instruction requires 'instructionId'.";
  if (!args.appInstance || !args.authResult) return "ERROR: cancel_purchase_instruction requires 'appInstance' and 'authResult'.";

  const body = { authResult: args.authResult, appInstance: args.appInstance };
  try {
    const data = await fetchInstruction(`/agent/cwallet/instructions/${encodeURIComponent(args.instructionId)}/cancel`, 'POST', body);
    await logRequest('cancel_purchase_instruction', { instructionId: args.instructionId, appInstance: args.appInstance, authResult: '[REDACTED]' }, data);
    return `Purchase instruction cancelled.\nRaw Data: ${JSON.stringify(data)}`;
  } catch (err) {
    await logError('cancel_purchase_instruction', err);
    return `Failed to cancel purchase instruction: ${err.message}`;
  }
}

async function handle_install_system_hooks(args) {
  const skillDir = SKILL_DIR;
  const hooksTarget = path.join(OPENCLAW_DIR, 'hooks', 'transforms', 'my_payment_webhook.mjs');

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
    await fs.mkdir(path.dirname(hooksTarget), { recursive: true });
    await fs.writeFile(hooksTarget, await renderWebhookModule(skillDir), 'utf8');
    await fs.unlink(path.join(OPENCLAW_DIR, 'hooks', 'transforms', 'my_payment_webhook.js')).catch(() => {});
  } catch (err) {
    await logError('install_system_hooks/copyWebhook', err);
    return `[SYSTEM DIRECTIVE] Installation FAILED at step 1 (copy webhook file): ${err.message}`;
  }

  try {
    const config = await loadConfig();
    config.hooks = config.hooks || {};
    config.hooks.mappings = config.hooks.mappings || [];

    let changed = false;
    if (!config.hooks.enabled) { config.hooks.enabled = true; changed = true; }

    // Pre-generate hooks.token if not already set — initialize_wallet will reuse this
    if (!config.hooks.token) {
      config.hooks.token = crypto.randomBytes(32).toString('hex');
      changed = true;
    }

    const CLINK_PATH = "/clink/payment";
    config.hooks.mappings = config.hooks.mappings.filter(
      m => m.transform?.module !== "my_payment_webhook.js"
    );
    const newMapping = { match: { path: CLINK_PATH }, transform: { module: "my_payment_webhook.mjs" } };
    const alreadyExists = config.hooks.mappings.some(
      m => m.transform?.module === "my_payment_webhook.mjs"
    );
    if (!alreadyExists) { config.hooks.mappings.push(newMapping); changed = true; }
    if (changed) await saveConfig(config);
  } catch (err) {
    await logError('install_system_hooks/injectConfig', err);
    return `[SYSTEM DIRECTIVE] Installation FAILED at step 2 (inject config): ${err.message}`;
  }

  if (notifyDestination) {
    try {
      const cache = await readPaymentMethodsCache() || {};
      cache.notifyDestination = notifyDestination;
      await writePaymentMethodsCache(cache);
    } catch (err) {
      await logError('install_system_hooks/saveNotifyDestination', err);
      return `[SYSTEM DIRECTIVE] Installation FAILED at step 2.5 (save notify destination): ${err.message}`;
    }
  }

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

  const { spawn } = await import('child_process');
  const openclawBin = resolveOpenClawExecutable();

  const restartChild = spawn('sh', ['-c', `sleep 3 && ${shellQuote(openclawBin)} gateway restart`], { detached: true, stdio: 'ignore' });
  restartChild.unref();

  if (statusNotificationSent) {
    return `DIRECT_SEND: Installation bootstrap completed. Gateway restart scheduled.

[SYSTEM DIRECTIVE] The installation success notification was already sent directly. Do NOT send it again. The user may reply with their email immediately; if the gateway is still restarting, they can retry a few seconds later.`;
  }

  return `SUCCESS: Webhook config updated. Gateway restart scheduled.

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
      description: "Run once per user. Generates signature key, calls Clink bootstrap API, and sets up webhook.",
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
      name: "list_payment_methods",
      description: "List all payment methods bound to the user's wallet. Requires a valid binding token.",
      inputSchema: { type: "object", properties: { bindingToken: { type: "string", description: "JWT token from the binding link flow" } }, required: ["bindingToken"] }
    },
    {
      name: "get_payment_method_detail",
      description: "Get detailed information about a specific payment method.",
      inputSchema: { type: "object", properties: { bindingToken: { type: "string" }, paymentInstrumentId: { type: "string" } }, required: ["bindingToken", "paymentInstrumentId"] }
    },
    {
      name: "update_payment_method",
      description: "Update the billing address of a specific payment method.",
      inputSchema: {
        type: "object",
        properties: {
          bindingToken: { type: "string" },
          paymentInstrumentId: { type: "string" },
          billingAddressJson: { type: "object", properties: { country: { type: "string" }, city: { type: "string" }, line1: { type: "string" }, line2: { type: "string" }, postalCode: { type: "string" }, region: { type: "string" } } }
        },
        required: ["bindingToken", "paymentInstrumentId", "billingAddressJson"]
      }
    },
    {
      name: "delete_payment_method",
      description: "Delete a specific payment method from the wallet.",
      inputSchema: { type: "object", properties: { bindingToken: { type: "string" }, paymentInstrumentId: { type: "string" } }, required: ["bindingToken", "paymentInstrumentId"] }
    },
    {
      name: "set_default_payment_method",
      description: "Set a specific payment method as the default for future transactions.",
      inputSchema: { type: "object", properties: { bindingToken: { type: "string" }, paymentInstrumentId: { type: "string" } }, required: ["bindingToken", "paymentInstrumentId"] }
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
          effectiveUntilTime: { type: "string", description: "Optional instruction expiry, UTC string \"yyyy-MM-dd HH:mm:ss\"." },
          isRecurring: { type: "boolean", description: "Optional. Default false unless the user clearly authorizes recurring payments." },
          mandates: { type: "array", description: "Non-empty array of requested mandate rules: { title?, description, amountLimit, currencyCode, merchantCategoryCode?, preferredMerchantName?, effectiveUntilTime? }" },
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
      name: "sign_purchase_instruction",
      description: "VIC: submit the user's Passkey/FIDO result and app/device context to activate a purchase instruction (status CREATED -> ACTIVE). The instructionId comes from prepare_visa_purchase_instruction state=CREATED_DRAFT or a reused ACTIVE instruction. authResult/appInstance come from the front-end Passkey flow — never fabricate them.",
      inputSchema: {
        type: "object",
        properties: {
          instructionId: { type: "string", description: "Local instruction ID from prepare_visa_purchase_instruction" },
          appInstance: { type: "object", description: "Visa app/device context, e.g. { deviceData: { type, brand, model, manufacturer }, userAgent, clientDeviceId }" },
          authResult: { type: "object", description: "FIDO/DFP result, e.g. { identifier, fidoBlob, dfpSessionId }" },
          extra: { type: "object", description: "Optional extra fields" }
        },
        required: ["instructionId", "appInstance", "authResult"]
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
      name: "get_purchase_instruction_manage_link",
      description: "VIC: when the user asks to 修改授权 查看授权 取消 instruction 授权, or semantically similar manage/view/edit/cancel authorization requests, return the agent UI link https://uat-agent.clinkbill.com. Feishu renders this as a button; other channels receive a link.",
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
      name: "get_purchase_instruction",
      description: "VIC backend API: get a single purchase instruction by instructionId. For user requests to view/manage authorization, prefer get_purchase_instruction_manage_link.",
      inputSchema: {
        type: "object",
        properties: {
          instructionId: { type: "string", description: "Local instruction ID" }
        },
        required: ["instructionId"]
      }
    },
    {
      name: "update_purchase_instruction",
      description: "VIC backend API: full update of a purchase instruction. Requires re-authentication (fresh appInstance + authResult) and the complete instruction fields + mandates. For user requests to modify authorization, prefer get_purchase_instruction_manage_link.",
      inputSchema: {
        type: "object",
        properties: {
          instructionId: { type: "string" },
          paymentInstrumentId: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          effectiveUntilTime: { type: "string", description: "UTC string \"yyyy-MM-dd HH:mm:ss\"" },
          mandates: { type: "array" },
          appInstance: { type: "object" },
          authResult: { type: "object" },
          extra: { type: "object" }
        },
        required: ["instructionId", "paymentInstrumentId", "title", "mandates", "appInstance", "authResult"]
      }
    },
    {
      name: "cancel_purchase_instruction",
      description: "VIC backend API: cancel a purchase instruction. Requires appInstance + authResult. For user requests to cancel authorization, prefer get_purchase_instruction_manage_link.",
      inputSchema: {
        type: "object",
        properties: {
          instructionId: { type: "string" },
          appInstance: { type: "object" },
          authResult: { type: "object" }
        },
        required: ["instructionId", "appInstance", "authResult"]
      }
    },
    {
      name: "install_system_hooks",
      description: "Update openclaw.json and restart the gateway in the background after a 3-second delay. Triggered directly by the install workflow with no extra text authorization required.",
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
      description: "卸载 Clink Payment Skill：清除 webhook、配置、skill 目录，并在后台延迟 3 秒重启网关。必须在用户输入文字授权后才能调用。",
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
      case "list_payment_methods":          result = await handle_list_payment_methods(args); break;
      case "get_payment_method_detail":     result = await handle_get_payment_method_detail(args); break;
      case "update_payment_method":         result = await handle_update_payment_method(args); break;
      case "delete_payment_method":         result = await handle_delete_payment_method(args); break;
      case "set_default_payment_method":    result = await handle_set_default_payment_method(args); break;
      case "pre_check_account":             result = await handle_pre_check_account(); break;
      case "clink_pay":                     result = await handle_clink_pay(args); break;
      case "clink_refund":                  result = await handle_clink_refund(args); break;
      case "get_refund_status":             result = await handle_get_refund_status(args); break;
      case "prepare_visa_purchase_instruction": result = await handle_prepare_visa_purchase_instruction(args); break;
      case "sign_purchase_instruction":     result = await handle_sign_purchase_instruction(args); break;
      case "list_purchase_instructions":    result = await handle_list_purchase_instructions(args); break;
      case "get_purchase_instruction_manage_link": result = await handle_get_purchase_instruction_manage_link(args); break;
      case "get_purchase_instruction":      result = await handle_get_purchase_instruction(args); break;
      case "update_purchase_instruction":   result = await handle_update_purchase_instruction(args); break;
      case "cancel_purchase_instruction":   result = await handle_cancel_purchase_instruction(args); break;
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
