import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';

import {
  isVisaRegistrationSucceeded,
  VIC_REGISTRATION_STATE_TTL_MS,
} from '../vic-registration-state-utils.mjs';

const indexSource = await fs.readFile(new URL('../index.mjs', import.meta.url), 'utf8');
const webhookSource = await fs.readFile(new URL('../hooks/my_payment_webhook.mjs', import.meta.url), 'utf8');
const pollSource = await fs.readFile(new URL('../scripts/poll-fallback.mjs', import.meta.url), 'utf8');
const notificationSource = await fs.readFile(new URL('../notification-utils.js', import.meta.url), 'utf8');
const skillSource = await fs.readFile(new URL('../SKILL.md', import.meta.url), 'utf8');

function sliceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  return start >= 0 && end > start ? source.slice(start, end) : '';
}

function extractFunction(source, name) {
  const functionStart = source.indexOf(`function ${name}`);
  assert.notEqual(functionStart, -1, `Missing function ${name}`);
  const asyncPrefix = 'async ';
  const start = source.slice(Math.max(0, functionStart - asyncPrefix.length), functionStart) === asyncPrefix
    ? functionStart - asyncPrefix.length
    : functionStart;
  const signatureEnd = source.indexOf(') {', start);
  const bodyStart = signatureEnd >= 0 ? signatureEnd + 2 : source.indexOf('{', start);
  assert.notEqual(bodyStart, -1, `Missing function body for ${name}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract function ${name}`);
}

function optionalExtractFunction(source, name) {
  return source.includes(`function ${name}`) ? extractFunction(source, name) : '';
}

function buildVicGateHarness() {
  const functionSources = [
    'normalizePaymentMethods',
    'normalizeCardNetwork',
    'isVisaPaymentMethod',
    'hasPaymentMethodNetworkSignal',
    'normalizePaymentMethodType',
    'isCardLikePaymentMethod',
    'shouldFailClosedForUnknownCardNetwork',
    'isVisaRegistrationCompletePaymentMethod',
    'findPaymentMethodById',
    'buildVicInstructionRequiredDirective',
    'buildUnknownPaymentMethodNetworkDirective',
    'ensureVisaVicReadyForUse',
  ]
    .map((name) => optionalExtractFunction(indexSource, name))
    .filter(Boolean)
    .join('\n\n');

  return new Function('fetchBindingDataImpl', `
    const VIC_REGISTRATION_STATE_TTL_MS = ${VIC_REGISTRATION_STATE_TTL_MS};
    const isVisaRegistrationSucceeded = ${isVisaRegistrationSucceeded.toString()};
    function resolveVicRegistrationState({ paymentInstrumentId }) {
      return {
        key: 'vic_registration:' + paymentInstrumentId,
        state: { type: 'vic_registration', status: 'pending_notified', paymentInstrumentId },
        shouldNotify: true,
      };
    }
    ${functionSources}
    async function fetchBindingData() { return fetchBindingDataImpl(); }
    async function logError() {}
    async function readPaymentMethodsCache() { return {}; }
    async function writePaymentFlowState() {}
    function normalizeCache(cache) { return cache && typeof cache === 'object' ? cache : {}; }
    function getNotifyDestination() { return null; }
    function buildVicRegistrationUrl() { return 'https://example.test/passkey-auth/pi_unknown?type=visa'; }
    function formatPaymentMethodDisplay() { return 'CARD ****'; }
    function buildVicRegistrationNotification() { return { messageKey: 'payment.vic_registration_required' }; }
    async function ensureRequiredPollFallback() { return { required: false, operation: null }; }
    function getRequiredPollFallbackLines() { return []; }
    function buildDirectSendDirective({ summary }) { return '[SYSTEM DIRECTIVE] ' + summary; }
    function formatNotificationInstruction({ summary }) { return '[SYSTEM DIRECTIVE] ' + summary; }
    return ensureVisaVicReadyForUse;
  `);
}

test('normalizes payment methods with visaRegistrationSucceeded only and without vicReadiness', () => {
  const indexNormalizer = sliceBetween(
    indexSource,
    'function normalizePaymentMethods(methods) {',
    'function normalizeRuleSettings(settings) {',
  );
  const pollNormalizer = sliceBetween(
    pollSource,
    'function normalizePaymentMethods(methods) {',
    'function paymentMethodIdentity(method) {',
  );
  const webhookMapper = sliceBetween(
    webhookSource,
    'function toCachedPaymentMethod(data, paymentInstrumentId) {',
    'function getRefundMeta(data) {',
  );

  for (const source of [indexNormalizer, pollNormalizer, webhookMapper]) {
    assert.match(source, /visaRegistrationSucceeded/);
    assert.doesNotMatch(source, /is_vic/);
    assert.doesNotMatch(source, /vicReadiness/);
    assert.doesNotMatch(source, /vicReadinessReason/);
  }
});

test('clink_pay routes Visa cards through VIC gates before charging', () => {
  const handler = sliceBetween(
    indexSource,
    'async function handle_clink_pay(args) {',
    'async function handle_clink_refund(args) {',
  );

  assert.match(handler, /ensureVisaVicReadyForUse/);
  assert.match(indexSource, /payment\.vic_registration_required/);
  assert.match(indexSource, /VIC purchase instruction flow/);
  assert.ok(
    handler.indexOf('ensureVisaVicReadyForUse') < handler.indexOf("fetchClink('/agent/order/charge'"),
    'VIC registration check must run before /agent/order/charge',
  );
});

test('pre_check_account routes Visa cards without visaRegistrationSucceeded to VIC registration first', () => {
  const handler = sliceBetween(
    indexSource,
    'async function handle_pre_check_account() {',
    'async function handle_clink_pay(args) {',
  );

  assert.match(handler, /ensureVisaVicReadyForUse/);
  assert.match(indexSource, /VIC registration/);
  assert.match(indexSource, /VIC purchase instruction flow/);
  assert.doesNotMatch(handler, /vicReadiness/);
});

test('VIC gate uses registration state before sending duplicate registration notifications', () => {
  const gate = sliceBetween(
    indexSource,
    'async function ensureVisaVicReadyForUse',
    '// ------------------------------------------------------------------\n// TOOL IMPLEMENTATIONS',
  );

  assert.match(gate, /resolveVicRegistrationState/);
  assert.match(gate, /vicState\.shouldNotify/);
  assert.match(gate, /vic_registration_pending/);
  assert.match(gate, /writePaymentFlowState/);
});

test('builds passkey-auth registration links from paymentInstrumentId', () => {
  assert.match(indexSource, /function buildVicRegistrationUrl/);
  assert.match(indexSource, /passkey-auth\/\$\{encodeURIComponent\(paymentInstrumentId\)\}\?type=visa/);
  assert.match(indexSource, /ensureRequiredPollFallback\(\s*'vic_registration'/);
});

test('VIC registration notification exists and uses passkeyUrl', () => {
  assert.match(notificationSource, /'payment\.vic_registration_required'/);
  assert.match(notificationSource, /passkeyUrl/);
  assert.match(notificationSource, /Complete VIC Registration|完成 VIC 注册/);
});

test('skill routes explicit Visa purchase intent to VIC before merchant plugin fallback', () => {
  assert.match(skillSource, /description: .*Visa.*purchase.*book.*VIC/i);
  assert.match(skillSource, /Explicit Visa Purchase Intent/i);
  assert.match(skillSource, /visa.*purchase.*intent/i);
  assert.match(skillSource, /Visa card|Visa 卡/);
  assert.match(skillSource, /buy|purchase|order|book|reserve|下单|购买|预订|订酒店/);
  assert.match(skillSource, /list_purchase_instructions/);
  assert.match(skillSource, /pre_check_account/);
  assert.match(skillSource, /create_purchase_instruction/);
  assert.match(skillSource, /VIC registration/i);
  assert.match(skillSource, /Do NOT call clink_pay for Visa/i);
  assert.match(skillSource, /do not answer only that the merchant booking plugin is missing/i);
  assert.match(skillSource, /Do NOT ask the user for a payment link/i);
  assert.match(skillSource, /Session ID/i);
});

test('blocks card payment when brand/network is unknown and payment method refresh fails', async () => {
  const ensureVisaVicReadyForUse = buildVicGateHarness()(async () => {
    throw new Error('refresh unavailable');
  });

  const result = await ensureVisaVicReadyForUse({
    paymentInstrumentId: 'pi_unknown',
    selectedMethod: {
      paymentInstrumentId: 'pi_unknown',
      paymentMethodType: 'CARD',
      visaRegistrationSucceeded: false,
    },
    context: 'clink_pay',
  });

  assert.equal(result.blocked, true);
  assert.notEqual(result.route, 'legacy');
  assert.match(result.response, /Do NOT call clink_pay/);
  assert.match(result.response, /refresh unavailable/);
});

test('routes Visa cards with visaRegistrationSucceeded to purchase instruction flow', async () => {
  const ensureVisaVicReadyForUse = buildVicGateHarness()(async () => {
    throw new Error('refresh should not be needed');
  });

  const result = await ensureVisaVicReadyForUse({
    paymentInstrumentId: 'pi_vic',
    selectedMethod: {
      paymentInstrumentId: 'pi_vic',
      cardBrand: 'visa',
      paymentMethodType: 'CARD',
      visaRegistrationSucceeded: true,
    },
    context: 'clink_pay',
  });

  assert.equal(result.blocked, true);
  assert.equal(result.route, 'vic_instruction_required');
  assert.match(result.response, /VIC purchase instruction flow/);
  assert.match(result.response, /Do NOT call clink_pay/);
});

test('does not treat isVic as VIC registration completion', async () => {
  const ensureVisaVicReadyForUse = buildVicGateHarness()(async () => ({
    bindingUrl: 'https://example.test/bind',
    methods: [{
      paymentInstrumentId: 'pi_vic',
      cardBrand: 'visa',
      paymentMethodType: 'CARD',
      isVic: true,
    }],
  }));

  const result = await ensureVisaVicReadyForUse({
    paymentInstrumentId: 'pi_vic',
    selectedMethod: {
      paymentInstrumentId: 'pi_vic',
      cardBrand: 'visa',
      paymentMethodType: 'CARD',
      isVic: true,
    },
    context: 'clink_pay',
  });

  assert.equal(result.blocked, true);
  assert.equal(result.route, 'vic_registration_required');
  assert.doesNotMatch(result.response, /VIC purchase instruction flow/);
});

test('does not fail closed for non-card payment methods without card network fields', async () => {
  const ensureVisaVicReadyForUse = buildVicGateHarness()(async () => {
    throw new Error('refresh unavailable');
  });

  const result = await ensureVisaVicReadyForUse({
    paymentInstrumentId: 'pi_paypal',
    selectedMethod: {
      paymentInstrumentId: 'pi_paypal',
      paymentMethodType: 'PAYPAL',
    },
    context: 'clink_pay',
  });

  assert.equal(result.blocked, false);
  assert.equal(result.route, 'legacy');
});

test('webhook treats a VIC-ready update on the same Visa card as VIC registration completion', () => {
  assert.match(webhookSource, /isVisaRegistrationComplete/);
  assert.match(webhookSource, /visaRegistrationSucceeded/);
  assert.match(webhookSource, /payment\.vic_registration_complete/);
  assert.match(webhookSource, /Continue the VIC purchase instruction flow/);
  assert.match(webhookSource, /Do NOT call clink_pay/);
});

test('poll fallback treats VIC registration changes as payment method changes', () => {
  const identity = sliceBetween(
    pollSource,
    'function paymentMethodIdentity(method) {',
    'function serializePaymentMethods(methods) {',
  );
  const serializer = sliceBetween(
    pollSource,
    'function serializePaymentMethods(methods) {',
    'function isSamePaymentMethods(left, right) {',
  );

  assert.match(pollSource, /visaRegistrationSucceeded/);
  assert.match(pollSource, /operation\.type === 'vic_registration'/);
});

test('skill guidance uses visaRegistrationSucceeded for Visa routing and removes vicReadiness', () => {
  assert.match(skillSource, /visaRegistrationSucceeded/);
  assert.match(skillSource, /passkey-auth\/\{paymentInstrumentId\}\?type=visa/);
  assert.doesNotMatch(skillSource, /isVic/);
  assert.doesNotMatch(skillSource, /vicReadiness/);
  assert.doesNotMatch(skillSource, /vicReadinessReason/);
});
