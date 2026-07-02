#!/usr/bin/env node
// event-pump.mjs
// Single mailbox event consumer for the OpenClaw payment skill.
// Replaces the old webhook receiver (hooks/my_payment_webhook.mjs) + poll fallback.
//
// Drains webhook events through the vendored clink-cli bundle:
//   node <SKILL_DIR>/vendor/clink-cli/clink-cli.bundle.mjs events poll \
//        --max-wait 60 --format json
// The CLI polls POST /agent/event-hub/webhook-events/poll and acks by eventId
// via POST /agent/event-hub/webhook-events/ack.
// Each returned event is dispatched to the same notification/cache behaviour the old
// webhook handler produced.
//
// Event -> messageKey map (mirrors hooks/my_payment_webhook.mjs):
//   payment_method.added          -> payment.method.bound_success
//                                    (+ wallet.initialized_complete on first card)
//                                    (Visa registration-complete transition ->
//                                       payment.vic_registration_complete)
//   payment_method.updated/.update -> payment.vic_registration_complete (only on the
//                                    Visa registration-complete transition; otherwise
//                                    cache-only, no card — same as webhook)
//   payment_method.default_change -> payment.method.default_changed_webhook
//   agent_order.succeeded         -> payment.success (+ spawn merchant confirmation)
//   agent_order.failed            -> payment.failed.charged_manual_review |
//                                    payment.failed.unexpected
//   agent_refund.succeeded        -> refund.event_succeeded
//   agent_refund.approved         -> refund.event_approved
//   agent_refund.failed           -> refund.event_failed
//   agent_refund.rejected         -> refund.event_rejected
//   risk_rule.updated             -> risk_rule.updated
//   purchase_instruction.activated / vic_device.binding_succeeded
//                                 -> payment.vic_registration_complete (+ markVicRegistrationReady)

import { execFileSync, spawn } from 'child_process';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createMessageRequest } from '../notification-utils.js';
import {
  isVisaRegistrationSucceeded,
  markVicRegistrationReady,
} from '../vic-registration-state-utils.mjs';
import {
  classifyEventWorkflow,
  eventTypeOf as classifyEventTypeOf,
} from '../lib/event-workflow-fsm.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..');
const CACHE_PATH = path.join(SKILL_DIR, 'clink.config.json');
const LOG_PATH = path.join(SKILL_DIR, 'error.log');
const LOCK_DIR = path.join(SKILL_DIR, 'locks');
const LOCK_PATH = path.join(LOCK_DIR, 'event-pump.lock');
const LOCK_STALE_MS = 120000;
const MESSAGE_SENDER = path.join(SCRIPT_DIR, 'send-message.mjs');
const MERCHANT_CONFIRMATION_RUNNER = path.join(SCRIPT_DIR, 'run-merchant-confirmation.mjs');
const PAYMENT_INTENT_RESUME_RUNNER = path.join(SCRIPT_DIR, 'run-payment-intent-resume.mjs');
const PAYMENT_INTENT_RESUME_TOOL = 'resume_pending_payment_intent';
const CLI_BUNDLE = path.join(SKILL_DIR, 'vendor', 'clink-cli', 'clink-cli.bundle.mjs');
// `events poll` drains the webhook-events queue within this client-side window
// (the CLI polls the backend internally; there is no server-side long-poll).
const POLL_MAX_WAIT_SECONDS = 60;
const BACKOFF_MS = 1000;
const MAX_PROCESSED_SEQS = 500;

// ─── Logging ───

async function logError(context, error) {
  const line = `[${new Date().toISOString()}] [event-pump/${context}] ${error instanceof Error ? error.stack || error.message : String(error)}\n`;
  try {
    await fs.appendFile(LOG_PATH, line, 'utf8');
  } catch {}
}

async function logRequest(context, payload) {
  const entry = {
    time: new Date().toISOString(),
    context: `event-pump/${context}`,
    payload,
  };
  try {
    await fs.appendFile(LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch {}
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Notify destination normalization (mirrors poll-fallback.mjs) ───

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
  if (!normalized.orderCardStates || typeof normalized.orderCardStates !== 'object') {
    normalized.orderCardStates = {};
  }
  if (!normalized.paymentFlowStates || typeof normalized.paymentFlowStates !== 'object') {
    normalized.paymentFlowStates = {};
  }
  if (!normalized.pendingPaymentIntents || typeof normalized.pendingPaymentIntents !== 'object' || Array.isArray(normalized.pendingPaymentIntents)) {
    normalized.pendingPaymentIntents = {};
  }
  if (!Array.isArray(normalized.processedEventSeqs)) normalized.processedEventSeqs = [];
  if (normalized.lastProcessedEventSeq === undefined) normalized.lastProcessedEventSeq = null;
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

// ─── Cache I/O (CACHE_PATH = SKILL_DIR/clink.config.json) ───

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
  const normalized = normalizeCache(cache);
  normalized.cachedAt = new Date().toISOString();
  await fs.writeFile(CACHE_PATH, JSON.stringify(normalized, null, 2), 'utf8');
}

// ─── Payment method helpers (mirrors poll-fallback.mjs) ───

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
          status: method.status || ((method.isDisabled ?? false) ? 'disabled' : 'active'),
        }))
        .filter((method) => typeof method.paymentInstrumentId === 'string' && method.paymentInstrumentId.trim())
    : [];
}

function normalizeCardNetwork(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isVisaPaymentMethod(method) {
  if (!method || typeof method !== 'object') return false;
  return [
    method.cardBrand,
    method.cardScheme,
    method.network,
    method.cardNetwork,
    method.paymentNetwork,
    method.paymentMethodType,
    method.paymentInstrumentType,
  ].some((candidate) => normalizeCardNetwork(candidate) === 'visa');
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

// Resolve a display string for an order/refund event, preferring the cached method.
function formatCardForEvent(paymentInstrumentId, data, cache) {
  if (Array.isArray(cache?.paymentMethods)) {
    const matched = cache.paymentMethods.find(
      (method) => method.paymentInstrumentId === paymentInstrumentId,
    );
    if (matched) return formatPaymentMethodDisplay(matched);
  }
  const walletAccountTag = data.walletAccountTag || data.wallet?.accountTag || null;
  if (data.cardBrand || data.cardScheme || data.cardLast4 || data.cardLastFour || walletAccountTag) {
    return formatPaymentMethodDisplay({
      cardBrand: data.cardBrand || data.cardScheme,
      cardScheme: data.cardScheme || data.cardBrand,
      cardLast4: data.cardLast4 || data.cardLastFour,
      walletAccountTag,
      paymentMethodType: data.paymentMethodType || data.paymentInstrumentType,
    });
  }
  if (data.paymentMethod) {
    const pm = data.paymentMethod;
    if (pm.cardBrand || pm.cardScheme || pm.cardLast4 || pm.cardLastFour || pm.walletAccountTag || pm.wallet?.accountTag) {
      return formatPaymentMethodDisplay({
        cardBrand: pm.cardBrand || pm.cardScheme,
        cardScheme: pm.cardScheme || pm.cardBrand,
        cardLast4: pm.cardLast4 || pm.cardLastFour,
        walletAccountTag: pm.walletAccountTag || pm.wallet?.accountTag,
        paymentMethodType: pm.paymentMethodType || pm.paymentInstrumentType,
      });
    }
  }
  return 'N/A';
}

// ─── Notification delivery (must go through scripts/send-message.mjs) ───

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

// ─── Order card-state tracking (mirrors hooks/my_payment_webhook.mjs) ───

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
  const normalized = normalizeCache(cache);
  for (const key of getOrderCardStateKeys(orderId, status, sessionId)) {
    if (normalized.orderCardStates[key]) {
      return normalized.orderCardStates[key];
    }
  }
  return null;
}

async function updateOrderCardState(orderId, status, sessionId, patch) {
  if (!Object.keys(patch || {}).length) return null;
  const cache = await readCache();
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
  await writeCache(cache);
  return nextState;
}

// ─── Merchant confirmation handoff (mirrors index.mjs) ───

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

function resolveMcporterConfigPath() {
  if (process.env.MCPORTER_CONFIG_PATH) return process.env.MCPORTER_CONFIG_PATH;
  const home = process.env.OPENCLAW_HOME || process.env.HOME || '';
  return path.join(home, '.openclaw', 'config', 'mcporter.json');
}

function spawnMerchantConfirmation(merchantContext, merchantArgs, { orderId, sessionId }) {
  const child = spawn(process.execPath, [
    MERCHANT_CONFIRMATION_RUNNER,
    '--config-path', resolveMcporterConfigPath(),
    '--server', merchantContext.server,
    '--tool', merchantContext.tool,
    '--args-json', JSON.stringify(merchantArgs),
    '--order-id', orderId || '',
    '--session-id', sessionId || '',
    '--pending-session-id', merchantContext.sessionId || '',
    '--trigger-source', 'event_pump',
  ], {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', (err) => {
    logError('agent_order.succeeded.trigger_merchant_confirmation.spawn', err);
  });
  child.unref();
}

function spawnPaymentIntentResume(paymentIntentId) {
  const child = spawn(process.execPath, [
    PAYMENT_INTENT_RESUME_RUNNER,
    '--config-path', resolveMcporterConfigPath(),
    '--tool', PAYMENT_INTENT_RESUME_TOOL,
    '--payment-intent-id', paymentIntentId,
  ], {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', (err) => {
    logError('payment_intent.resume.spawn', err);
  });
  child.unref();
}

function resolveInstructionIdForEvent(event, data) {
  return (
    data.instructionId ||
    data.instruction_id ||
    data.purchaseInstructionId ||
    data.purchase_instruction_id ||
    data.id ||
    event?.resourceId ||
    null
  );
}

function markPendingPaymentIntentsInstructionActivated(cache, event, data) {
  const normalized = normalizeCache(cache);
  const instructionId = resolveInstructionIdForEvent(event, data);
  const paymentInstrumentId = data.paymentInstrumentId || data.payment_instrument_id || null;
  const activated = [];
  const now = new Date().toISOString();
  for (const intent of Object.values(normalized.pendingPaymentIntents)) {
    if (!intent || typeof intent !== 'object') continue;
    if (!['WAITING_INSTRUCTION_AUTH', 'INSTRUCTION_WORKFLOW_REQUIRED'].includes(intent.state)) continue;
    const draftInstructionId = typeof intent.draftInstructionId === 'string' && intent.draftInstructionId.trim()
      ? intent.draftInstructionId.trim()
      : '';
    const instructionMatches = instructionId && draftInstructionId && draftInstructionId === instructionId;
    // Precise FSM correlation: once a pending payment intent recorded the draft
    // instruction it created, a later activation for another instruction on the
    // same card must not resume this intent. The paymentInstrumentId fallback is
    // only for legacy/incomplete pending intents that predate draftInstructionId.
    const paymentInstrumentMatches = !draftInstructionId && paymentInstrumentId && intent.paymentInstrumentId === paymentInstrumentId;
    if (!instructionMatches && !paymentInstrumentMatches) continue;
    const next = {
      ...intent,
      state: 'INSTRUCTION_ACTIVATED',
      activationEventType: eventTypeOf(event),
      activationEventId: event?.eventId || null,
      activationEventSeq: event?.seq ?? null,
      updatedAt: now,
    };
    normalized.pendingPaymentIntents[intent.paymentIntentId] = next;
    activated.push(next);
  }
  return activated;
}

// ─── Amount formatting (mirrors hooks/my_payment_webhook.mjs) ───

function formatAmount(data) {
  const currency = data.currency || data.paymentCurrency || '';
  const symbol = currency === 'USD' ? '$' : currency;
  const amount = data.amount ?? data.amountTotal ?? data.amountSubtotal ?? 'N/A';
  const parsed = Number(amount);
  return amount === 'N/A' || !Number.isFinite(parsed) ? 'N/A' : `${symbol}${parsed.toFixed(2)}`;
}

function formatRefundAmount(data) {
  const currency = data.refund_currency || data.refundCurrency || '';
  const symbol = currency === 'USD' ? '$' : currency;
  const amount = data.refund_amount ?? data.refundAmount ?? 'N/A';
  const parsed = Number(amount);
  return amount === 'N/A' || !Number.isFinite(parsed) ? 'N/A' : `${symbol}${parsed.toFixed(2)}`;
}

function getRefundMeta(data) {
  return {
    amt: formatRefundAmount(data),
    paymentInstrumentId: data.payment_instrument_id || data.paymentInstrumentId || null,
    orderId: data.order_id || data.orderId || 'N/A',
    refundId: data.refund_id || data.refundId || 'N/A',
    customerId: data.customer_id || data.customerId || 'N/A',
  };
}

// ─── Cached payment method upsert (mirrors hooks/my_payment_webhook.mjs) ───

function toCachedPaymentMethod(data) {
  return normalizePaymentMethods([{ ...data, paymentInstrumentId: data.paymentInstrumentId }])[0]
    || {
      paymentInstrumentId: data.paymentInstrumentId || null,
      paymentMethodType: data.paymentMethodType || data.paymentInstrumentType || null,
      cardBrand: data.cardBrand || data.cardScheme || null,
      cardScheme: data.cardScheme || data.cardBrand || null,
      network: data.network || data.cardNetwork || data.paymentNetwork || null,
      cardLast4: data.cardLast4 || data.cardLastFour || null,
      issuerBank: data.issuerBank || null,
      walletAccountTag: data.walletAccountTag || data.wallet?.accountTag || null,
      visaRegistrationSucceeded: isVisaRegistrationSucceeded(data),
      isDefault: data.isDefault ?? false,
      isDisabled: data.isDisabled ?? false,
      status: data.status || ((data.isDisabled ?? false) ? 'disabled' : 'active'),
    };
}

function isVisaRegistrationCompleteTransition(previousMethod, cachedMethod) {
  return Boolean(
    previousMethod &&
    cachedMethod.paymentInstrumentId === previousMethod.paymentInstrumentId &&
    isVisaPaymentMethod(cachedMethod) &&
    cachedMethod.visaRegistrationSucceeded === true &&
    previousMethod.visaRegistrationSucceeded !== true,
  );
}

// Upsert a method into cache; returns flags mirroring the webhook's upsert result.
async function upsertCachedPaymentMethod(data, cachedMethod, { markInitialized = false } = {}) {
  const cache = await readCache();
  const hadExistingPaymentMethod = Array.isArray(cache.paymentMethods) && cache.paymentMethods.length > 0;
  const wasInitialized = Boolean(cache.initialized);
  const existing = cache.paymentMethods.findIndex((m) => m.paymentInstrumentId === data.paymentInstrumentId);
  const previousMethod = existing >= 0 ? cache.paymentMethods[existing] : null;
  const isVisaRegistrationComplete = isVisaRegistrationCompleteTransition(previousMethod, cachedMethod);

  if (isVisaRegistrationComplete && cachedMethod.paymentInstrumentId) {
    const readyState = markVicRegistrationReady({
      cache,
      paymentInstrumentId: cachedMethod.paymentInstrumentId,
      now: Date.now(),
    });
    for (const [key, state] of Object.entries(readyState.states)) {
      cache.paymentFlowStates[key] = state;
    }
  }

  if (existing >= 0) {
    cache.paymentMethods[existing] = cachedMethod;
  } else {
    cache.paymentMethods.push(cachedMethod);
  }
  if (data.isDefault) {
    cache.paymentMethods.forEach((m) => { m.isDefault = m.paymentInstrumentId === data.paymentInstrumentId; });
    cache.defaultPaymentMethodId = data.paymentInstrumentId;
  }
  if (markInitialized && !cache.initialized) cache.initialized = true;
  if (markInitialized && data.customerEmail && !cache.email) cache.email = data.customerEmail;
  await writeCache(cache);

  return {
    isVisaRegistrationComplete,
    shouldSendCompleteCard: markInitialized && !wasInitialized && !hadExistingPaymentMethod,
  };
}

async function sendVicRegistrationComplete(cachedMethod, data) {
  const cache = await readCache();
  const notifyDestination = getNotifyDestination(cache);
  if (!notifyDestination) {
    await logError('vic_registration_complete', 'missing notify destination');
    return;
  }
  const cardDisplay = formatPaymentMethodDisplay(cachedMethod);
  const card = createMessageRequest({
    messageKey: 'payment.vic_registration_complete',
    vars: {
      cardDisplay,
      paymentInstrumentId: cachedMethod.paymentInstrumentId || data.paymentInstrumentId || 'N/A',
    },
  });
  await sendNotifications(notifyDestination, [card]);
}

// ─── Event dispatch ───

function eventTypeOf(event) {
  return classifyEventTypeOf(event);
}

function formatEventFsmLog(workflow) {
  return {
    domain: workflow.domain,
    state: workflow.state,
    action: workflow.action,
    terminal: workflow.terminal,
    reason: workflow.reason,
  };
}

function resolveVicTargetId(event) {
  const data = event?.data || {};
  return (
    data.paymentInstrumentId ||
    data.payment_instrument_id ||
    event?.resourceId ||
    data.resourceId ||
    null
  );
}

async function dispatchEvent(event) {
  const type = eventTypeOf(event);
  const workflow = classifyEventWorkflow(event);
  await logRequest('event_fsm', {
    type,
    resourceId: event?.resourceId || null,
    workflow: formatEventFsmLog(workflow),
  });
  const data = (event && event.data && typeof event.data === 'object') ? event.data : {};

  switch (type) {
    // ─── Card binding completed ───
    case 'payment_method.added': {
      await logRequest('payment_method.added', data);
      const cachedMethod = toCachedPaymentMethod(data);
      const cardDisplay = formatPaymentMethodDisplay(cachedMethod);
      const email = data.customerEmail || 'N/A';

      let shouldSendCompleteCard = true;
      let isVisaRegistrationComplete = false;
      try {
        const result = await upsertCachedPaymentMethod(data, cachedMethod, { markInitialized: true });
        shouldSendCompleteCard = result.shouldSendCompleteCard;
        isVisaRegistrationComplete = result.isVisaRegistrationComplete;
      } catch (err) {
        await logError('payment_method.added cache update', err);
      }

      if (isVisaRegistrationComplete) {
        await sendVicRegistrationComplete(cachedMethod, data);
        return;
      }

      const notifyDestination = getNotifyDestination(await readCache());
      if (!notifyDestination) {
        await logError('payment_method.added', 'missing notify destination');
        return;
      }
      const notifications = [
        createMessageRequest({
          messageKey: 'payment.method.bound_success',
          vars: { cardDisplay, email },
        }),
      ];
      if (shouldSendCompleteCard) {
        notifications.push(createMessageRequest({
          messageKey: 'wallet.initialized_complete',
          vars: { cardDisplay },
        }));
      }
      await sendNotifications(notifyDestination, notifications);
      return;
    }

    // ─── Payment method updated ───
    case 'payment_method.updated':
    case 'payment_method.update': {
      await logRequest(type, data);
      const cachedMethod = toCachedPaymentMethod(data);
      let isVisaRegistrationComplete = false;
      try {
        const result = await upsertCachedPaymentMethod(data, cachedMethod);
        isVisaRegistrationComplete = result.isVisaRegistrationComplete;
      } catch (err) {
        await logError(`${type} cache update`, err);
      }
      // Same as the webhook: only emit a card on the Visa registration-complete
      // transition; otherwise this is a silent cache update.
      if (isVisaRegistrationComplete) {
        await sendVicRegistrationComplete(cachedMethod, data);
      }
      return;
    }

    // ─── Default payment method changed ───
    case 'payment_method.default_change': {
      await logRequest('payment_method.default_change', data);
      const cachedMethod = toCachedPaymentMethod(data);
      const cardDisplay = formatPaymentMethodDisplay(cachedMethod);
      try {
        const cache = await readCache();
        const existing = cache.paymentMethods.findIndex((m) => m.paymentInstrumentId === data.paymentInstrumentId);
        if (existing >= 0) {
          cache.paymentMethods[existing] = cachedMethod;
        } else {
          cache.paymentMethods.push(cachedMethod);
        }
        cache.paymentMethods.forEach((m) => { m.isDefault = m.paymentInstrumentId === data.paymentInstrumentId; });
        cache.defaultPaymentMethodId = data.paymentInstrumentId;
        await writeCache(cache);
      } catch (err) {
        await logError('payment_method.default_change cache update', err);
      }

      const notifyDestination = getNotifyDestination(await readCache());
      if (!notifyDestination) {
        await logError('payment_method.default_change', 'missing notify destination');
        return;
      }
      await sendNotifications(notifyDestination, [
        createMessageRequest({
          messageKey: 'payment.method.default_changed_webhook',
          vars: {
            cardDisplay,
            paymentInstrumentId: data.paymentInstrumentId || 'N/A',
          },
        }),
      ]);
      return;
    }

    // ─── Order created (intermediate, no action) ───
    case 'agent_order.created': {
      return;
    }

    // ─── Payment succeeded ───
    case 'agent_order.succeeded': {
      await logRequest('agent_order.succeeded', data);
      const amt = formatAmount(data);
      const cache = await readCache();
      const paymentInstrumentId = data.paymentInstrumentId || data.paymentMethod?.paymentInstrumentId || null;
      const card = formatCardForEvent(paymentInstrumentId, data, cache);
      const rawOrderId = data.orderId || null;
      const orderId = rawOrderId || 'N/A';
      const sessionId = data.sessionId || data.session_id || null;

      const merchantContext = cache.pendingMerchantConfirmation || null;
      const notifyDestination = getNotifyDestination(cache, merchantContext?.notifyDestination);

      // Send the success card once per order.
      const latestState = getOrderCardState(cache, rawOrderId, 1, sessionId);
      if (!latestState?.paymentSuccessCardSent) {
        if (!notifyDestination) {
          await logError('agent_order.succeeded', 'missing notify destination');
        } else {
          await sendNotifications(notifyDestination, [
            createMessageRequest({
              messageKey: 'payment.success',
              vars: { amountDisplay: amt, cardDisplay: card, orderId },
            }),
          ]);
          await updateOrderCardState(rawOrderId, 1, sessionId, {
            paymentSuccessCardSent: true,
            paymentSuccessCardSentAt: new Date().toISOString(),
            paymentSuccessCardSource: 'event_pump',
          });
        }
      }

      // Trigger merchant confirmation if pending and not already in flight.
      const postCache = await readCache();
      const effectiveMerchantContext = postCache.pendingMerchantConfirmation || merchantContext;
      const dispatchState = getOrderCardState(postCache, rawOrderId, 1, sessionId);
      if (
        effectiveMerchantContext?.server &&
        effectiveMerchantContext?.tool &&
        !dispatchState?.merchantConfirmationTriggered &&
        !dispatchState?.merchantConfirmationDispatched
      ) {
        try {
          const handoffDestination = getNotifyDestination(postCache, effectiveMerchantContext.notifyDestination);
          if (!handoffDestination) {
            throw new Error('missing notify destination for merchant handoff');
          }
          const merchantArgs = buildMerchantConfirmArgs(
            effectiveMerchantContext,
            buildMerchantPaymentHandoff(orderId, sessionId, handoffDestination, 'event_pump'),
          );
          await logRequest('agent_order.succeeded.trigger_merchant_confirmation', {
            context: effectiveMerchantContext,
            args: merchantArgs,
          });
          spawnMerchantConfirmation(effectiveMerchantContext, merchantArgs, { orderId, sessionId });
          await updateOrderCardState(rawOrderId, 1, sessionId, {
            merchantConfirmationDispatched: true,
            merchantConfirmationDispatchedAt: new Date().toISOString(),
            merchantConfirmationDispatchSource: 'event_pump',
          });
        } catch (err) {
          await logError('agent_order.succeeded.trigger_merchant_confirmation', err);
        }
      }
      return;
    }

    // ─── Payment failed ───
    case 'agent_order.failed': {
      await logRequest('agent_order.failed', data);
      // Clear any pending merchant confirmation, mirroring the webhook.
      try {
        const cache = await readCache();
        if (cache.pendingMerchantConfirmation) {
          delete cache.pendingMerchantConfirmation;
          await writeCache(cache);
        }
      } catch (err) {
        await logError('agent_order.failed clear_pending', err);
      }

      const cache = await readCache();
      const amt = formatAmount(data);
      const rawOrderId = data.orderId || null;
      const orderId = rawOrderId || 'N/A';
      const sessionId = data.sessionId || data.session_id || null;
      const status = data.status || 'failed';
      const normalizedStatus = normalizeOrderStatus(status);
      const failureCode = data.failureCode || '';
      const failureReason = data.failureMessage || failureCode || '支付处理异常';
      const isCharged = status === 'charged' || status === 'paid';
      const paymentInstrumentId = data.paymentInstrumentId || data.paymentMethod?.paymentInstrumentId || null;
      const card = formatCardForEvent(paymentInstrumentId, data, cache);

      const latestState = getOrderCardState(cache, rawOrderId, normalizedStatus, sessionId);
      if (latestState?.paymentFailureCardSent) {
        return;
      }
      const notifyDestination = getNotifyDestination(cache);
      if (!notifyDestination) {
        await logError('agent_order.failed', 'missing notify destination');
        return;
      }
      await sendNotifications(notifyDestination, [
        createMessageRequest({
          messageKey: isCharged ? 'payment.failed.charged_manual_review' : 'payment.failed.unexpected',
          vars: {
            amountDisplay: amt,
            reason: failureReason,
            code: status,
            orderId,
            cardDisplay: card,
          },
        }),
      ]);
      await updateOrderCardState(rawOrderId, normalizedStatus, sessionId, {
        paymentFailureCardSent: true,
        paymentFailureCardSentAt: new Date().toISOString(),
        paymentFailureCardSource: 'event_pump',
        paymentFailureKind: `${failureCode}${data.declinedCode || ''}`.includes('risk') ? 'risk_reject' : 'payment_failed',
      });
      return;
    }

    // ─── Refund succeeded / approved ───
    case 'agent_refund.succeeded':
    case 'agent_refund.approved': {
      await logRequest(type, data);
      const cache = await readCache();
      const { amt, paymentInstrumentId, orderId, refundId } = getRefundMeta(data);
      const card = formatCardForEvent(paymentInstrumentId, data, cache);
      const isApproved = type === 'agent_refund.approved';
      const notifyDestination = getNotifyDestination(cache);
      if (!notifyDestination) {
        await logError(type, 'missing notify destination');
        return;
      }
      await sendNotifications(notifyDestination, [
        createMessageRequest({
          messageKey: isApproved ? 'refund.event_approved' : 'refund.event_succeeded',
          vars: { amountDisplay: amt, orderId, refundId, cardDisplay: card },
        }),
      ]);
      return;
    }

    // ─── Refund failed / rejected ───
    case 'agent_refund.failed':
    case 'agent_refund.rejected': {
      await logRequest(type, data);
      const cache = await readCache();
      const { amt, paymentInstrumentId, orderId, refundId } = getRefundMeta(data);
      const card = formatCardForEvent(paymentInstrumentId, data, cache);
      const failureReason =
        data.failure_message || data.failureMessage || data.failure_code || data.failureCode || '退款处理失败';
      const isRejected = type === 'agent_refund.rejected';
      const notifyDestination = getNotifyDestination(cache);
      if (!notifyDestination) {
        await logError(type, 'missing notify destination');
        return;
      }
      await sendNotifications(notifyDestination, [
        createMessageRequest({
          messageKey: isRejected ? 'refund.event_rejected' : 'refund.event_failed',
          vars: { amountDisplay: amt, orderId, refundId, cardDisplay: card, reason: failureReason },
        }),
      ]);
      return;
    }

    // ─── Risk rules updated ───
    case 'risk_rule.updated': {
      await logRequest('risk_rule.updated', data);
      try {
        const cache = await readCache();
        cache.riskRules = data;
        await writeCache(cache);
      } catch (err) {
        await logError('risk_rule.updated cache update', err);
      }
      const notifyDestination = getNotifyDestination(await readCache());
      if (!notifyDestination) {
        await logError('risk_rule.updated', 'missing notify destination');
        return;
      }
      await sendNotifications(notifyDestination, [
        createMessageRequest({
          messageKey: 'risk_rule.updated',
          vars: {
            singleRechargeLimit: data.singleRechargeLimit ?? 'N/A',
            dailyTotalLimit: data.dailyTotalLimit ?? 'N/A',
            dailyMaxCount: data.dailyMaxCount ?? 'N/A',
            rechargeInterval: data.rechargeInterval ?? 'N/A',
          },
        }),
      ]);
      return;
    }

    // ─── VIC purchase instruction activated / device binding succeeded ───
    case 'purchase_instruction.activated':
    case 'vic_device.binding_succeeded': {
      await logRequest(type, { resourceId: event?.resourceId, data });
      const targetId = resolveVicTargetId(event);
      if (!targetId) {
        await logError(type, 'missing paymentInstrumentId/resourceId');
        return;
      }
      let cachedMethod = null;
      let activatedPaymentIntents = [];
      try {
        const cache = await readCache();
        cachedMethod = (cache.paymentMethods || []).find((m) => m.paymentInstrumentId === targetId) || null;
        const readyState = markVicRegistrationReady({
          cache,
          paymentInstrumentId: targetId,
          now: Date.now(),
        });
        for (const [key, state] of Object.entries(readyState.states)) {
          cache.paymentFlowStates[key] = state;
        }
        activatedPaymentIntents = markPendingPaymentIntentsInstructionActivated(cache, event, data);
        for (const intent of activatedPaymentIntents) {
          if (!intent.resumeDispatchedAt) {
            cache.pendingPaymentIntents[intent.paymentIntentId] = {
              ...intent,
              resumeDispatchedAt: new Date().toISOString(),
              resumeDispatchSource: 'event_pump',
            };
          }
        }
        await writeCache(cache);
      } catch (err) {
        await logError(`${type} markVicRegistrationReady`, err);
      }

      for (const intent of activatedPaymentIntents) {
        if (!intent.resumeDispatchedAt) {
          spawnPaymentIntentResume(intent.paymentIntentId);
        }
      }

      const notifyDestination = getNotifyDestination(await readCache());
      if (!notifyDestination) {
        await logError(type, 'missing notify destination');
        return;
      }
      const cardDisplay = cachedMethod ? formatPaymentMethodDisplay(cachedMethod) : formatCardForEvent(targetId, data, await readCache());
      await sendNotifications(notifyDestination, [
        createMessageRequest({
          messageKey: 'payment.vic_registration_complete',
          vars: { cardDisplay, paymentInstrumentId: targetId },
        }),
      ]);
      return;
    }

    // ─── Unknown event type ───
    default: {
      await logError('unknown event', `[${type}] ${JSON.stringify(data).slice(0, 1000)}`);
      return;
    }
  }
}

// ─── Idempotency: track processed seqs ───

function eventSeqKey(event) {
  if (event && event.seq !== undefined && event.seq !== null) return `seq:${event.seq}`;
  if (event && event.eventId) return `eid:${event.eventId}`;
  return null;
}

async function isEventProcessed(event) {
  const key = eventSeqKey(event);
  if (!key) return false;
  const cache = await readCache();
  return cache.processedEventSeqs.includes(key);
}

async function markEventProcessed(event) {
  const key = eventSeqKey(event);
  if (!key) return;
  const cache = await readCache();
  if (!cache.processedEventSeqs.includes(key)) {
    cache.processedEventSeqs.push(key);
    if (cache.processedEventSeqs.length > MAX_PROCESSED_SEQS) {
      cache.processedEventSeqs = cache.processedEventSeqs.slice(-MAX_PROCESSED_SEQS);
    }
  }
  if (event && typeof event.seq === 'number') {
    if (cache.lastProcessedEventSeq === null || event.seq > cache.lastProcessedEventSeq) {
      cache.lastProcessedEventSeq = event.seq;
    }
  }
  await writeCache(cache);
}

// ─── Singleton lock (mirrors the skill's lock pattern) ───

async function acquireLock() {
  await fs.mkdir(LOCK_DIR, { recursive: true });
  while (true) {
    try {
      const handle = await fs.open(LOCK_PATH, 'wx');
      await handle.writeFile(String(process.pid), 'utf8');
      await handle.close();
      return true;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      // A lock exists. Treat it as live unless stale, then take over.
      try {
        const stats = await fs.stat(LOCK_PATH);
        if (Date.now() - stats.mtimeMs >= LOCK_STALE_MS) {
          await fs.unlink(LOCK_PATH).catch(() => {});
          continue;
        }
      } catch (statErr) {
        if (statErr?.code === 'ENOENT') {
          continue;
        }
        throw statErr;
      }
      // Another live pump holds the lock — exit immediately.
      return false;
    }
  }
}

async function releaseLock() {
  try {
    const pid = await fs.readFile(LOCK_PATH, 'utf8').catch(() => '');
    if (String(pid).trim() === String(process.pid)) {
      await fs.unlink(LOCK_PATH).catch(() => {});
    }
  } catch {}
}

let _lockHeld = false;
async function touchLock() {
  // Keep the lock mtime fresh so a long-lived pump is not treated as stale.
  if (!_lockHeld) return;
  try {
    const now = new Date();
    await fs.utimes(LOCK_PATH, now, now);
  } catch {}
}

// ─── CLI poll ───

function runEventsPoll(cache) {
  return new Promise((resolve) => {
    // Base URL is owned by clink-cli (CLINK_BASE_URL env > its own config >
    // production default); a real CLINK_BASE_URL env var transparently overrides.
    const env = {
      ...process.env,
      CLINK_CUSTOMER_ID: cache.customerId,
      CLINK_CUSTOMER_API_KEY: cache.customerAPIKey,
    };
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(process.execPath, [
        CLI_BUNDLE,
        'events', 'poll',
        '--max-wait', String(POLL_MAX_WAIT_SECONDS),
        '--format', 'json',
      ], { env });
    } catch (err) {
      resolve({ ok: false, error: err });
      return;
    }
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => resolve({ ok: false, error: err, stderr }));
    child.on('close', (code) => {
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function parseEnvelope(stdout) {
  const lines = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

// ─── Main loop ───

async function runOnce() {
  const cache = await readCache();
  if (!cache.customerId || !cache.customerAPIKey) {
    return 'no_creds';
  }

  const result = await runEventsPoll(cache);
  await touchLock();

  if (!result.ok) {
    await logError('events_poll', `exit_code=${result.code === undefined ? 'spawn_error' : result.code} ${result.error ? (result.error.message || result.error) : ''} ${result.stderr || ''}`.trim());
    return 'backoff';
  }

  const envelope = parseEnvelope(result.stdout);
  if (!envelope || envelope.ok !== true) {
    await logError('events_poll', `bad envelope: ${envelope ? JSON.stringify(envelope).slice(0, 500) : (result.stdout || '').slice(0, 500)}`);
    return 'backoff';
  }

  const events = Array.isArray(envelope.data?.events) ? envelope.data.events : [];
  for (const event of events) {
    try {
      if (await isEventProcessed(event)) {
        continue;
      }
      await dispatchEvent(event);
      await markEventProcessed(event);
    } catch (err) {
      await logError('dispatchEvent', err);
    }
  }
  return 'ok';
}

async function main() {
  const acquired = await acquireLock();
  if (!acquired) {
    // Another live pump is already running.
    process.exit(0);
  }
  _lockHeld = true;

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      const pid = fsSync.readFileSync(LOCK_PATH, 'utf8');
      if (String(pid).trim() === String(process.pid)) {
        fsSync.unlinkSync(LOCK_PATH);
      }
    } catch {}
  };
  process.on('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      cleanup();
      process.exit(0);
    });
  }

  try {
    // Wallet not initialized -> self-exit immediately.
    const initialCache = await readCache();
    if (!initialCache.customerId || !initialCache.customerAPIKey) {
      await releaseLock();
      _lockHeld = false;
      process.exit(0);
    }

    while (true) {
      let outcome;
      try {
        outcome = await runOnce();
      } catch (err) {
        await logError('runOnce', err);
        outcome = 'backoff';
      }
      if (outcome === 'no_creds') {
        // Credentials disappeared (wallet reset) — stop the pump.
        break;
      }
      if (outcome === 'backoff') {
        await sleep(BACKOFF_MS);
      }
      // On 'ok', the CLI's own --wait/--max-wait already provided the delay.
    }
  } finally {
    await releaseLock();
    _lockHeld = false;
  }

  process.exit(0);
}

main().catch(async (error) => {
  await logError('main', error);
  await releaseLock();
  process.exit(1);
});
