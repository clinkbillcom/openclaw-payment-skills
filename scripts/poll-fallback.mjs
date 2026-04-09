#!/usr/bin/env node
import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import https from 'https';
import { CONFIG } from '../config.mjs';
import { createMessageRequest } from '../notification-utils.js';

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const SKILL_DIR = path.join(SCRIPT_DIR, '..');
const CACHE_PATH = path.join(SKILL_DIR, 'clink.config.json');
const LOG_PATH = path.join(SKILL_DIR, 'error.log');
const MESSAGE_SENDER = path.join(SCRIPT_DIR, 'send-message.mjs');

function parseArgs(argv) {
  let operationId = '';
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--operation-id') continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('--operation-id requires a value');
    }
    operationId = value.trim();
    index += 1;
  }
  if (!operationId) throw new Error('Missing --operation-id');
  return { operationId };
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeNotifyDestinationValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const channel = typeof value.channel === 'string' && value.channel.trim()
    ? value.channel.trim().toLowerCase()
    : '';
  const targetType = typeof value?.target?.type === 'string' && value.target.type.trim()
    ? value.target.type.trim()
    : '';
  const targetId = typeof value?.target?.id === 'string' && value.target.id.trim()
    ? value.target.id.trim()
    : '';
  const locale = typeof value?.locale === 'string' && value.locale.trim()
    ? value.locale.trim()
    : '';
  if (!channel || !targetType || !targetId) return null;
  return {
    channel,
    target: {
      type: targetType,
      id: targetId,
    },
    ...(locale ? { locale } : {}),
  };
}

function normalizeCache(cache) {
  const normalized = cache && typeof cache === 'object' ? cache : {};
  if (!Array.isArray(normalized.paymentMethods)) normalized.paymentMethods = [];
  if (normalized.defaultPaymentMethodId === undefined) normalized.defaultPaymentMethodId = null;
  if (normalized.webhookAvailable === undefined) normalized.webhookAvailable = null;
  if (!normalized.asyncOperations || typeof normalized.asyncOperations !== 'object') {
    normalized.asyncOperations = {};
  }
  normalized.notifyDestination = normalizeNotifyDestinationValue(normalized.notifyDestination);
  if (
    normalized.pendingMerchantConfirmation &&
    typeof normalized.pendingMerchantConfirmation === 'object' &&
    !Array.isArray(normalized.pendingMerchantConfirmation)
  ) {
    normalized.pendingMerchantConfirmation.notifyDestination = normalizeNotifyDestinationValue(
      normalized.pendingMerchantConfirmation.notifyDestination,
    );
  }
  return normalized;
}

function getPendingNotifyDestination(cache) {
  const pendingNotifyDestination = normalizeCache(cache).pendingMerchantConfirmation?.notifyDestination || null;
  return pendingNotifyDestination ? cloneJsonValue(pendingNotifyDestination) : null;
}

function getNotifyDestination(cache, preferred = null) {
  const normalizedPreferred = normalizeNotifyDestinationValue(preferred);
  if (normalizedPreferred) return cloneJsonValue(normalizedPreferred);
  const normalizedCache = normalizeCache(cache);
  if (normalizedCache.notifyDestination) {
    return cloneJsonValue(normalizedCache.notifyDestination);
  }
  return getPendingNotifyDestination(normalizedCache);
}

async function logError(context, error) {
  const line = `[${new Date().toISOString()}] [poll-fallback/${context}] ${error instanceof Error ? error.stack || error.message : String(error)}\n`;
  try {
    await fs.appendFile(LOG_PATH, line, 'utf8');
  } catch {}
}

async function logRequest(context, payload) {
  const entry = {
    time: new Date().toISOString(),
    context: `poll-fallback/${context}`,
    payload,
  };
  try {
    await fs.appendFile(LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch {}
}

async function readCache() {
  try {
    const content = await fs.readFile(CACHE_PATH, 'utf8');
    return normalizeCache(JSON.parse(content));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      await logError('readCache', error);
    }
    return normalizeCache({});
  }
}

async function writeCache(cache) {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(normalizeCache(cache), null, 2), 'utf8');
}

function normalizePaymentMethods(methods) {
  return Array.isArray(methods)
    ? methods
        .map((method) => ({
          paymentInstrumentId: method.paymentInstrumentId || null,
          paymentMethodType: method.paymentMethodType || method.paymentInstrumentType || null,
          cardBrand: method.cardBrand || method.cardScheme || null,
          cardLast4: method.cardLast4 || method.cardLastFour || null,
          issuerBank: method.issuerBank || null,
          walletAccountTag: method.walletAccountTag || method.wallet?.accountTag || null,
          isDefault: method.isDefault ?? false,
          isDisabled: method.isDisabled ?? false,
          status: method.status || ((method.isDisabled ?? false) ? 'disabled' : 'active'),
        }))
        .filter((method) => typeof method.paymentInstrumentId === 'string' && method.paymentInstrumentId.trim())
    : [];
}

function paymentMethodIdentity(method) {
  return [
    method.paymentInstrumentId || '',
    method.cardBrand || '',
    method.cardLast4 || '',
    method.walletAccountTag || '',
    method.paymentMethodType || '',
  ].join('|');
}

function serializePaymentMethods(methods) {
  return JSON.stringify(
    normalizePaymentMethods(methods)
      .map((method) => ({
        paymentInstrumentId: method.paymentInstrumentId,
        cardBrand: method.cardBrand || '',
        cardLast4: method.cardLast4 || '',
        walletAccountTag: method.walletAccountTag || '',
        paymentMethodType: method.paymentMethodType || '',
        isDefault: Boolean(method.isDefault),
        status: method.status || '',
      }))
      .sort((left, right) => paymentMethodIdentity(left).localeCompare(paymentMethodIdentity(right))),
  );
}

function isSamePaymentMethods(left, right) {
  return serializePaymentMethods(left) === serializePaymentMethods(right);
}

function detectNewCard(beforeMethods, afterMethods) {
  const beforeSet = new Set(normalizePaymentMethods(beforeMethods).map(paymentMethodIdentity));
  return normalizePaymentMethods(afterMethods).find((method) => !beforeSet.has(paymentMethodIdentity(method))) || null;
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

function isSameRuleSettings(left, right) {
  return JSON.stringify(normalizeRuleSettings(left)) === JSON.stringify(normalizeRuleSettings(right));
}

function formatPaymentMethodDisplay(method) {
  if (!method) return 'Unknow';
  const brand = method.cardBrand || method.cardScheme || method.paymentMethodType || method.paymentInstrumentType || 'Unknow';
  const last4 = method.cardLast4 || method.cardLastFour || null;
  const walletAccountTag = method.walletAccountTag || method.wallet?.accountTag || null;
  if (walletAccountTag) {
    return `${String(brand).toUpperCase()} ${walletAccountTag}`;
  }
  return `${String(brand).toUpperCase()} ••••${last4 || '****'}`;
}

function buildNotificationPayload(notifyDestination, message) {
  const payload = {
    channel: notifyDestination.channel,
    target: {
      type: notifyDestination.target.type,
      id: notifyDestination.target.id,
      ...(notifyDestination.locale ? { locale: notifyDestination.locale } : {}),
    },
    deliver: true,
  };
  payload.message_key = String(message.message_key || message.messageKey || '').trim();
  payload.vars = cloneJsonValue(message.vars || {});
  payload.locale = typeof message.locale === 'string' ? message.locale : 'auto';
  if (message.delivery_policy || message.deliveryPolicy) {
    payload.delivery_policy = cloneJsonValue(message.delivery_policy || message.deliveryPolicy);
  }
  return payload;
}

function sendNotificationDirect(notifyDestination, message) {
  const payload = buildNotificationPayload(notifyDestination, message);
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

async function sendNotifications(notifyDestination, notifications) {
  const items = Array.isArray(notifications) ? notifications : [notifications];
  for (const notification of items.filter(Boolean)) {
    sendNotificationDirect(notifyDestination, notification);
  }
}

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
    const request = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        ...(options.headers || {}),
      },
    }, (response) => {
      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });
    request.on('error', reject);
    if (bodyStr) request.write(bodyStr);
    request.end();
  });
}

async function fetchClink(endpoint, options = {}) {
  const url = `${CONFIG.API_BASE_URL}${endpoint}`;
  const body = options.body ? JSON.parse(options.body) : null;
  const response = await httpsRequest(url, { method: options.method || 'GET', headers: options.headers }, body);
  if (response.code !== 200) {
    throw new ClinkApiError(response.code, response.msg, response);
  }
  return response.data;
}

async function queryBindingMethods(cache) {
  if (!cache.customerAPIKey || !cache.customerId) {
    throw new Error('Wallet not initialized.');
  }
  const data = await fetchClink('/agent/cwallet/card/bindingLink', {
    method: 'POST',
    headers: {
      'X-Customer-API-Key': cache.customerAPIKey,
      'X-Customer-ID': cache.customerId,
      'X-Timestamp': Date.now().toString(),
    },
  });
  return normalizePaymentMethods(data.paymentMethodsVoList || []);
}

async function queryRiskRules(cache) {
  if (!cache.customerAPIKey) {
    throw new Error('Wallet not initialized.');
  }
  const data = await fetchClink('/agent/risk/rule/settings', {
    method: 'GET',
    headers: {
      'X-Customer-API-Key': cache.customerAPIKey,
    },
  });
  return normalizeRuleSettings(data);
}

async function updateOperation(operationId, updater) {
  const cache = await readCache();
  const operation = cache.asyncOperations?.[operationId];
  if (!operation) return null;
  const nextOperation = typeof updater === 'function'
    ? updater(cloneJsonValue(operation))
    : { ...operation, ...(updater || {}) };
  if (!nextOperation) return null;
  cache.asyncOperations[operationId] = nextOperation;
  await writeCache(cache);
  return nextOperation;
}

async function finalizeOperation(operationId, patch) {
  return updateOperation(operationId, (operation) => ({
    ...operation,
    ...patch,
    completedAt: Date.now(),
  }));
}

async function markOperationProgress(operationId, patch = {}) {
  return updateOperation(operationId, (operation) => ({
    ...operation,
    status: 'polling',
    retryCount: Number(operation.retryCount || 0) + 1,
    lastPolledAt: Date.now(),
    ...patch,
  }));
}

function isTerminalStatus(status) {
  return status === 'succeeded' || status === 'failed' || status === 'timeout' || status === 'cancelled';
}

function resolveDefaultPaymentMethodId(methods) {
  const normalizedMethods = normalizePaymentMethods(methods);
  const defaultMethod = normalizedMethods.find((method) => method.isDefault) || normalizedMethods[0] || null;
  return defaultMethod?.paymentInstrumentId || null;
}

async function tryHandleBindLikeSuccess(operation, latestMethods) {
  const cache = await readCache();
  const newCard = detectNewCard(operation.snapshotBefore, latestMethods);
  if (!newCard) return false;

  const notifyDestination = getNotifyDestination(cache, operation.notifyDestination);
  if (!notifyDestination) {
    await updateOperation(operation.id, { lastError: 'Missing notify destination for poll fallback delivery.' });
    return false;
  }

  const hadExistingPaymentMethod = normalizePaymentMethods(operation.snapshotBefore).length > 0;
  const shouldSendCompleteCard = !cache.initialized && !hadExistingPaymentMethod;
  const cardDisplay = formatPaymentMethodDisplay(newCard);
  const email = cache.email || 'N/A';
  const successCard = createMessageRequest({
    messageKey: 'payment.method.bound_success',
    vars: {
      cardDisplay,
      email,
    },
  });
  const notifications = shouldSendCompleteCard
    ? [
        successCard,
        createMessageRequest({
          messageKey: 'wallet.initialized_complete',
          vars: { cardDisplay },
        }),
      ]
    : [successCard];

  try {
    await sendNotifications(notifyDestination, notifications);
  } catch (error) {
    await logError(`${operation.type}/send`, error);
    await updateOperation(operation.id, { lastError: error instanceof Error ? error.message : String(error) });
    return false;
  }

  const freshCache = await readCache();
  freshCache.paymentMethods = normalizePaymentMethods(latestMethods);
  freshCache.defaultPaymentMethodId = resolveDefaultPaymentMethodId(latestMethods);
  if (!freshCache.initialized) freshCache.initialized = true;
  freshCache.cachedAt = new Date().toISOString();
  await writeCache(freshCache);
  await finalizeOperation(operation.id, {
    status: 'succeeded',
    resultPayload: {
      completionSource: 'poll',
      paymentInstrumentId: newCard.paymentInstrumentId || null,
    },
  });
  await logRequest(`${operation.type}/succeeded`, {
    operationId: operation.id,
    paymentInstrumentId: newCard.paymentInstrumentId || null,
  });
  return true;
}

async function tryHandleRuleSuccess(operation, latestRules) {
  const cache = await readCache();
  if (isSameRuleSettings(latestRules, operation.snapshotBefore)) {
    return false;
  }

  const notifyDestination = getNotifyDestination(cache, operation.notifyDestination);
  if (!notifyDestination) {
    await updateOperation(operation.id, { lastError: 'Missing notify destination for poll fallback delivery.' });
    return false;
  }

  const riskCard = createMessageRequest({
    messageKey: 'risk_rule.updated',
    vars: {
      singleRechargeLimit: latestRules?.singleRechargeLimit ?? 'N/A',
      dailyTotalLimit: latestRules?.dailyTotalLimit ?? 'N/A',
      dailyMaxCount: latestRules?.dailyMaxCount ?? 'N/A',
      rechargeInterval: latestRules?.rechargeInterval ?? 'N/A',
    },
  });

  try {
    await sendNotifications(notifyDestination, [riskCard]);
  } catch (error) {
    await logError('update_rule/send', error);
    await updateOperation(operation.id, { lastError: error instanceof Error ? error.message : String(error) });
    return false;
  }

  const freshCache = await readCache();
  freshCache.riskRules = cloneJsonValue(latestRules);
  freshCache.cachedAt = new Date().toISOString();
  await writeCache(freshCache);
  await finalizeOperation(operation.id, {
    status: 'succeeded',
    resultPayload: {
      completionSource: 'poll',
      riskRules: cloneJsonValue(latestRules),
    },
  });
  await logRequest('update_rule/succeeded', {
    operationId: operation.id,
    latestRules,
  });
  return true;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOperation(operationId) {
  while (true) {
    const cache = await readCache();
    const operation = cache.asyncOperations?.[operationId];
    if (!operation) return;
    if (isTerminalStatus(operation.status)) return;

    const now = Date.now();
    const firstPollAt = Number(operation.firstPollAt || 0);
    const expireAt = Number(operation.expireAt || 0);
    if (Number.isFinite(expireAt) && expireAt > 0 && now >= expireAt) {
      await finalizeOperation(operationId, { status: 'timeout' });
      await logRequest('timeout', { operationId, type: operation.type });
      return;
    }
    if (Number.isFinite(firstPollAt) && firstPollAt > now) {
      await sleep(Math.min(firstPollAt - now, 1000));
      continue;
    }

    await markOperationProgress(operationId);

    try {
      if (operation.type === 'bind_card' || operation.type === 'change_card') {
        const latestMethods = await queryBindingMethods(cache);
        const completed = await tryHandleBindLikeSuccess(operation, latestMethods);
        if (completed) return;
      } else if (operation.type === 'update_rule') {
        const latestRules = await queryRiskRules(cache);
        const completed = await tryHandleRuleSuccess(operation, latestRules);
        if (completed) return;
      } else {
        await finalizeOperation(operationId, {
          status: 'failed',
          lastError: `Unsupported operation type: ${operation.type}`,
        });
        return;
      }
    } catch (error) {
      await logError(`run/${operation.type}`, error);
      if (error instanceof ClinkApiError && Number(error.code) === 401) {
        await finalizeOperation(operationId, {
          status: 'failed',
          lastError: error.message,
          resultPayload: { code: error.code, reason: 'UNAUTHORIZED' },
        });
        return;
      }
      await updateOperation(operationId, {
        lastError: error instanceof Error ? error.message : String(error),
      });
    }

    await sleep(Number(operation.pollIntervalMs || 5000));
  }
}

async function main() {
  const { operationId } = parseArgs(process.argv.slice(2));
  await runOperation(operationId);
}

main().catch(async (error) => {
  await logError('main', error);
  process.exitCode = 1;
});
