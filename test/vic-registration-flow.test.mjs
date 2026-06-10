import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';

import {
  isVisaRegistrationSucceeded,
  VIC_REGISTRATION_STATE_TTL_MS,
} from '../vic-registration-state-utils.mjs';
import {
  createMessageRequest,
  renderMessageFeishuCard,
  renderMessageMarkdown,
  renderMessagePlainText,
} from '../notification-utils.js';

const indexSource = await fs.readFile(new URL('../index.mjs', import.meta.url), 'utf8');
const webhookSource = await fs.readFile(new URL('../hooks/my_payment_webhook.mjs', import.meta.url), 'utf8');
const pollSource = await fs.readFile(new URL('../scripts/poll-fallback.mjs', import.meta.url), 'utf8');
const notificationSource = await fs.readFile(new URL('../notification-utils.js', import.meta.url), 'utf8');
const skillSource = await fs.readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
const configSource = await fs.readFile(new URL('../config.mjs', import.meta.url), 'utf8');

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

function buildCreatePurchaseInstructionDraftHarness() {
  const sources = [
    'buildRedirectUrl',
    'buildPurchaseInstructionPasskeyUrl',
    'buildPurchaseInstructionAuthNotification',
    'isPlainObject',
    'normalizePurchaseInstructionFulfillmentType',
    'validatePurchaseInstructionFulfillmentType',
    'purchaseInstructionNeedsShippingAddress',
    'validatePurchaseInstructionShippingAddress',
    'validatePurchaseInstructionScope',
    'createPurchaseInstructionDraft',
  ]
    .map((name) => extractFunction(indexSource, name))
    .join('\n\n');

  return new Function('createMessageRequestImpl', `
    const createMessageRequest = createMessageRequestImpl;
    ${sources}
    function parseNotifyDestinationArgs() { return null; }
    function formatPaymentMethodDisplay(method) {
      return [method.cardBrand || method.paymentMethodType || 'CARD', method.cardLast4 || ''].filter(Boolean).join(' ');
    }
    async function fetchInstruction(...args) { return globalThis.fetchInstruction(...args); }
    async function logRequest(...args) { return globalThis.logRequest(...args); }
    async function logError(...args) { return globalThis.logError(...args); }
    async function resolvePurchaseInstructionBindingUrl() { return { bindingUrl: 'https://uat-agent.clinkbill.com/bind', cache: {} }; }
    function getNotifyDestination() { return null; }
    async function writePaymentMethodsCache() {}
    function sendNotificationDirect() { throw new Error('direct send should not run'); }
    async function logNotificationFallback(...args) { return globalThis.logNotificationFallback(...args); }
    function buildDirectSendDirective({ summary }) { return '[SYSTEM DIRECTIVE] ' + summary; }
    function formatNotificationInstruction({ summary, notifications, followUp }) {
      return { summary, notifications, followUp };
    }
    return createPurchaseInstructionDraft;
  `)(createMessageRequest);
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

test('purchase instruction draft creation sends passkey auth URL with instructionId', () => {
  const createHandler = extractFunction(indexSource, 'createPurchaseInstructionDraft');
  const bindingResolver = extractFunction(indexSource, 'resolvePurchaseInstructionBindingUrl');

  assert.match(indexSource, /function buildPurchaseInstructionPasskeyUrl/);
  assert.match(indexSource, /instructionId=\$\{encodeURIComponent\(instructionId\)\}/);
  assert.match(createHandler, /data\.instructionId/);
  assert.match(createHandler, /resolvePurchaseInstructionBindingUrl/);
  assert.match(bindingResolver, /readPaymentMethodsCache/);
  assert.match(bindingResolver, /cache\.bindingUrl/);
  assert.match(bindingResolver, /fetchBindingData/);
  assert.match(createHandler, /buildPurchaseInstructionPasskeyUrl\(bindingUrl,\s*paymentInstrumentId,\s*data\.instructionId\)/);
  assert.match(createHandler, /getNotifyDestination/);
  assert.match(createHandler, /sendNotificationDirect/);
  assert.match(createHandler, /buildDirectSendDirective/);
  assert.match(createHandler, /formatNotificationInstruction/);
  assert.match(indexSource, /payment\.purchase_instruction_auth_required/);
  assert.match(notificationSource, /'payment\.purchase_instruction_auth_required'/);
  assert.match(notificationSource, /instructionId/);
  assert.match(notificationSource, /passkeyUrl/);
});

test('purchase instruction draft auth notification includes the requested instruction scope', async () => {
  const createPurchaseInstructionDraft = buildCreatePurchaseInstructionDraftHarness();
  const requestBody = {
    paymentInstrumentId: 'cpi_9031',
    title: '全季酒店住宿预订',
    description: '明天入住，离上海迪士尼最近且交通方便',
    effectiveUntilTime: '2026-06-10T23:59:59Z',
    mandates: [{
      title: 'Hotel Booking',
      description: 'Booking for Ji Hotel near Shanghai Disney',
      amountLimit: 500,
      currencyCode: 'CNY',
      merchantCategoryCode: '7011',
      preferredMerchantName: '全季酒店',
      effectiveUntilTime: '2026-06-10T23:59:59Z',
    }],
  };
  const args = {
    ...requestBody,
    fulfillmentType: 'NO_SHIPPING_REQUIRED',
  };
  let fallbackMessage = null;

  globalThis.fetchInstruction = async (endpoint, method, body) => {
    assert.equal(endpoint, '/agent/cwallet/instructions');
    assert.equal(method, 'POST');
    assert.deepEqual(body, requestBody);
    return {
      instructionId: 'inst_hotel',
      paymentInstrumentId: 'cpi_9031',
      cardScheme: 'Visa',
      cardLastFour: '9031',
      cardType: 'CREDIT',
      status: 'CREATED',
    };
  };
  globalThis.logRequest = async () => {};
  globalThis.logError = async () => {};
  globalThis.logNotificationFallback = async (_context, payload) => {
    fallbackMessage = payload.message;
  };

  try {
    const result = await createPurchaseInstructionDraft(args);

    assert.equal(result.notifications.message_key, 'payment.purchase_instruction_auth_required');
    assert.equal(result.notifications.vars.instructionId, 'inst_hotel');
    assert.equal(result.notifications.vars.title, requestBody.title);
    assert.equal(result.notifications.vars.description, requestBody.description);
    assert.equal(result.notifications.vars.effectiveUntilTime, requestBody.effectiveUntilTime);
    assert.deepEqual(result.notifications.vars.mandates, requestBody.mandates);
    assert.deepEqual(fallbackMessage, result.notifications);
  } finally {
    delete globalThis.fetchInstruction;
    delete globalThis.logRequest;
    delete globalThis.logError;
    delete globalThis.logNotificationFallback;
  }
});

test('purchase instruction draft creation passes US shipping address for delivered goods', async () => {
  const createPurchaseInstructionDraft = buildCreatePurchaseInstructionDraftHarness();
  const requestBody = {
    paymentInstrumentId: 'cpi_9031',
    title: 'Physical goods purchase',
    description: 'One-time goods order that requires delivery',
    shippingAddress: {
      name: 'Jim',
      line1: '123 Market St',
      line2: 'Apt 201',
      city: 'San Francisco',
      state: 'CA',
      zip: '94105',
      countryCode: 'US',
      deliveryContactDetails: { phone: '+14155550100' },
    },
    mandates: [{
      title: 'Goods order',
      description: 'Physical goods purchase',
      amountLimit: 120,
      currencyCode: 'USD',
      merchantCategoryCode: '5311',
      preferredMerchantName: 'Example Store',
    }],
  };
  const args = {
    ...requestBody,
    fulfillmentType: 'PHYSICAL_GOODS_REQUIRES_SHIPPING',
  };

  globalThis.fetchInstruction = async (endpoint, method, body) => {
    assert.equal(endpoint, '/agent/cwallet/instructions');
    assert.equal(method, 'POST');
    assert.deepEqual(body, requestBody);
    return {
      instructionId: 'inst_goods',
      paymentInstrumentId: 'cpi_9031',
      cardScheme: 'Visa',
      cardLastFour: '9031',
      cardType: 'CREDIT',
      status: 'CREATED',
    };
  };
  globalThis.logRequest = async () => {};
  globalThis.logError = async () => {};
  globalThis.logNotificationFallback = async () => {};

  try {
    const result = await createPurchaseInstructionDraft(args);

    assert.deepEqual(result.notifications.vars.shippingAddress, requestBody.shippingAddress);
  } finally {
    delete globalThis.fetchInstruction;
    delete globalThis.logRequest;
    delete globalThis.logError;
    delete globalThis.logNotificationFallback;
  }
});

test('purchase instruction authorization card renders mandate amount and merchant scope', () => {
  const request = createMessageRequest({
    messageKey: 'payment.purchase_instruction_auth_required',
    locale: 'zh-CN',
    vars: {
      paymentInstrumentId: 'cpi_9031',
      instructionId: 'inst_hotel',
      cardDisplay: 'VISA 9031',
      title: '全季酒店住宿预订',
      description: '明天入住，离上海迪士尼最近且交通方便',
      effectiveUntilTime: '2026-06-10T23:59:59Z',
      passkeyUrl: 'https://uat-agent.clinkbill.com/passkey-auth/cpi_9031?type=visa&instructionId=inst_hotel',
      mandates: [{
        title: 'Hotel Booking',
        description: 'Booking for Ji Hotel near Shanghai Disney',
        amountLimit: 500,
        currencyCode: 'CNY',
        merchantCategoryCode: '7011',
        preferredMerchantName: '全季酒店',
        effectiveUntilTime: '2026-06-10T23:59:59Z',
      }],
    },
  });

  const text = renderMessagePlainText(request, { preferredLocale: 'zh-CN' });

  assert.match(text, /全季酒店住宿预订/);
  assert.match(text, /明天入住，离上海迪士尼最近且交通方便/);
  assert.match(text, /500/);
  assert.match(text, /CNY/);
  assert.match(text, /7011/);
  assert.match(text, /全季酒店/);
  assert.match(text, /2026-06-10T23:59:59Z/);
});

test('purchase instruction authorization card renders shipping address', () => {
  const request = createMessageRequest({
    messageKey: 'payment.purchase_instruction_auth_required',
    locale: 'zh-CN',
    vars: {
      paymentInstrumentId: 'cpi_9031',
      instructionId: 'inst_goods',
      cardDisplay: 'VISA 9031',
      title: 'Physical goods purchase',
      passkeyUrl: 'https://uat-agent.clinkbill.com/passkey-auth/cpi_9031?type=visa&instructionId=inst_goods',
      shippingAddress: {
        name: 'Jim',
        line1: '123 Market St',
        line2: 'Apt 201',
        city: 'San Francisco',
        state: 'CA',
        zip: '94105',
        countryCode: 'US',
      },
      mandates: [{
        amountLimit: 120,
        currencyCode: 'USD',
        merchantCategoryCode: '5311',
      }],
    },
  });

  const text = renderMessagePlainText(request, { preferredLocale: 'zh-CN' });

  assert.match(text, /收货地址/);
  assert.match(text, /Jim/);
  assert.match(text, /123 Market St/);
  assert.match(text, /Apt 201/);
  assert.match(text, /San Francisco/);
  assert.match(text, /CA/);
  assert.match(text, /94105/);
  assert.match(text, /US/);
});

test('purchase instruction passkey URL keeps instructionId inside redirectUrl', () => {
  const buildRedirectUrlSource = extractFunction(indexSource, 'buildRedirectUrl');
  const buildPasskeyUrlSource = extractFunction(indexSource, 'buildPurchaseInstructionPasskeyUrl');
  const buildPurchaseInstructionPasskeyUrl = new Function(`
    ${buildRedirectUrlSource}
    ${buildPasskeyUrlSource}
    return buildPurchaseInstructionPasskeyUrl;
  `)();

  const url = new URL(buildPurchaseInstructionPasskeyUrl(
    'https://example.test/bind?existing=1#token',
    'cpi_9031',
    'inst_a&b',
  ));

  assert.equal(url.origin, 'https://example.test');
  assert.equal(url.searchParams.get('existing'), '1');
  assert.equal(
    url.searchParams.get('redirectUrl'),
    '/passkey-auth/cpi_9031?type=visa&instructionId=inst_a%26b',
  );
});

test('purchase instruction APIs use the default UAT API domain', () => {
  const fetchInstruction = extractFunction(indexSource, 'fetchInstruction');

  assert.match(configSource, /API_BASE_URL:\s*"https:\/\/uat-api\.clinkbill\.com"/);
  assert.doesNotMatch(configSource, /AGENT_API_BASE_URL/);
  assert.doesNotMatch(indexSource, /AGENT_BASE_URL/);
  assert.match(fetchInstruction, /fetchClink\(endpoint/);
});

test('purchase instruction APIs use the agent cwallet instruction path', () => {
  assert.match(indexSource, /fetchInstruction\('\/agent\/cwallet\/instructions', 'POST'/);
  assert.match(indexSource, /`\/agent\/cwallet\/instructions\/\$\{encodeURIComponent\(args\.instructionId\)\}\/sign`/);
  assert.match(indexSource, /`\/agent\/cwallet\/instructions\$\{qs\}`/);
  assert.match(indexSource, /`\/agent\/cwallet\/instructions\/\$\{encodeURIComponent\(args\.instructionId\)\}`/);
  assert.match(indexSource, /`\/agent\/cwallet\/instructions\/\$\{encodeURIComponent\(args\.instructionId\)\}\/cancel`/);
  assert.doesNotMatch(indexSource, /\/a\/cwallet\/instructions/);
});

test('purchase instruction manage link notification renders Feishu button and markdown link', () => {
  const request = createMessageRequest({
    messageKey: 'payment.purchase_instruction_manage_link',
    locale: 'zh-CN',
    vars: {
      manageUrl: 'https://uat-agent.clinkbill.com',
    },
  });

  const card = renderMessageFeishuCard(request, { preferredLocale: 'zh-CN' });
  const cardJson = JSON.stringify(card);
  const markdown = renderMessageMarkdown(request, { preferredLocale: 'zh-CN' });

  assert.match(cardJson, /"tag":"button"/);
  assert.match(cardJson, /https:\/\/uat-agent\.clinkbill\.com/);
  assert.match(cardJson, /管理 instruction 授权/);
  assert.match(markdown, /\[管理 instruction 授权\]\(https:\/\/uat-agent\.clinkbill\.com\)/);
});

test('instruction authorization manage intents route to the agent UI link tool', () => {
  assert.match(indexSource, /name: "get_purchase_instruction_manage_link"/);
  assert.match(indexSource, /https:\/\/uat-agent\.clinkbill\.com/);
  assert.match(indexSource, /修改授权[\s\S]*查看授权[\s\S]*取消 instruction 授权/);
  assert.match(indexSource, /case "get_purchase_instruction_manage_link"/);
  assert.match(notificationSource, /'payment\.purchase_instruction_manage_link'/);
  assert.match(skillSource, /修改授权[\s\S]*查看授权[\s\S]*取消 instruction 授权/);
  assert.match(skillSource, /get_purchase_instruction_manage_link/);
});

test('create purchase instruction is not exposed as a public tool', () => {
  assert.doesNotMatch(indexSource, /name: "create_purchase_instruction"/);
  assert.doesNotMatch(indexSource, /case "create_purchase_instruction"/);
  assert.doesNotMatch(skillSource, /\n  - name: create_purchase_instruction/);
  assert.match(indexSource, /function createPurchaseInstructionDraft/);
});

test('list purchase instructions filters by status and paymentInstrumentId', async () => {
  const listHandlerSource = extractFunction(indexSource, 'handle_list_purchase_instructions');
  const handleListPurchaseInstructions = new Function(`
    ${listHandlerSource}
    return handle_list_purchase_instructions;
  `)();

  const calls = [];
  globalThis.fetchInstruction = async (endpoint, method) => {
    calls.push({ endpoint, method });
    return [{ instructionId: 'ins_100001', paymentInstrumentId: 'pi_123456', status: 'ACTIVE' }];
  };
  globalThis.logError = async () => {};

  try {
    const result = await handleListPurchaseInstructions({
      status: 'ACTIVE',
      paymentInstrumentId: 'pi_123456',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].endpoint, '/agent/cwallet/instructions?status=ACTIVE&paymentInstrumentId=pi_123456');
    assert.match(result, /ins_100001/);
  } finally {
    delete globalThis.fetchInstruction;
    delete globalThis.logError;
  }
});

test('empty active Visa instruction list directs agent to create a draft when scope is complete', async () => {
  const listHandlerSource = extractFunction(indexSource, 'handle_list_purchase_instructions');
  const handleListPurchaseInstructions = new Function(`
    ${listHandlerSource}
    return handle_list_purchase_instructions;
  `)();

  globalThis.fetchInstruction = async () => [];
  globalThis.logError = async () => {};

  try {
    const result = await handleListPurchaseInstructions({
      status: 'ACTIVE',
      paymentInstrumentId: 'pi_vic',
    });

    assert.match(result, /Purchase instructions:\n\[\]/);
    assert.match(result, /No matching ACTIVE purchase instruction/i);
    assert.match(result, /call prepare_visa_purchase_instruction/i);
    assert.match(result, /Do NOT ask for a payment link/i);
  } finally {
    delete globalThis.fetchInstruction;
    delete globalThis.logError;
  }
});

function buildPrepareInstructionHarness() {
  const sources = [
    'normalizeCache',
    'normalizePaymentMethods',
    'findPaymentMethodById',
    'resolveSelectedPaymentMethod',
    'normalizeInstructionComparableText',
    'parseInstructionTimeMs',
    'isPlainObject',
    'normalizePurchaseInstructionFulfillmentType',
    'validatePurchaseInstructionFulfillmentType',
    'purchaseInstructionNeedsShippingAddress',
    'validatePurchaseInstructionShippingAddress',
    'validatePurchaseInstructionScope',
    'mandateMatchesPurchaseScope',
    'findReusablePurchaseInstruction',
    'isPurchaseInstructionDraftCreateSuccess',
    'handle_prepare_visa_purchase_instruction',
  ]
    .map((name) => extractFunction(indexSource, name))
    .join('\n\n');

  return new Function(`
    function isVisaRegistrationSucceeded(method) { return method?.visaRegistrationSucceeded === true; }
    ${sources}
    return handle_prepare_visa_purchase_instruction;
  `)();
}

test('prepare visa purchase instruction state machine lists before creating a draft', async () => {
  const handlePrepareVisaPurchaseInstruction = buildPrepareInstructionHarness();
  const calls = [];

  globalThis.readPaymentMethodsCache = async () => ({
    defaultPaymentMethodId: 'pi_vic',
    paymentMethods: [{
      paymentInstrumentId: 'pi_vic',
      paymentMethodType: 'CARD',
      cardBrand: 'visa',
      visaRegistrationSucceeded: true,
      isDefault: true,
    }],
  });
  globalThis.fetchBindingData = async () => {
    throw new Error('fetchBindingData should not be needed');
  };
  globalThis.ensureVisaVicReadyForUse = async ({ paymentInstrumentId }) => ({
    blocked: true,
    route: 'vic_instruction_required',
    paymentMethod: {
      paymentInstrumentId,
      paymentMethodType: 'CARD',
      cardBrand: 'visa',
      visaRegistrationSucceeded: true,
    },
    response: 'VIC-ready',
  });
  globalThis.fetchInstruction = async (endpoint, method) => {
    calls.push({ type: 'fetchInstruction', endpoint, method });
    return [];
  };
  globalThis.createPurchaseInstructionDraft = async (args) => {
    calls.push({ type: 'create', args });
    return 'Purchase instruction draft created.\nInstruction ID: inst_created';
  };
  globalThis.logRequest = async () => {};
  globalThis.logError = async () => {};

  try {
    const result = await handlePrepareVisaPurchaseInstruction({
      title: '全季酒店住宿预订',
      fulfillmentType: 'NO_SHIPPING_REQUIRED',
      mandates: [{
        description: '全季酒店住宿预订，靠近上海迪士尼',
        amountLimit: 500,
        currencyCode: 'CNY',
        merchantCategoryCode: '7011',
        preferredMerchantName: '全季酒店',
      }],
    });

    assert.equal(calls[0].type, 'fetchInstruction');
    assert.equal(calls[0].endpoint, '/agent/cwallet/instructions?status=ACTIVE&paymentInstrumentId=pi_vic');
    assert.equal(calls[1].type, 'create');
    assert.equal(calls[1].args.paymentInstrumentId, 'pi_vic');
    assert.match(result, /state=CREATED_DRAFT/);
    assert.match(result, /Purchase instruction draft created/);
  } finally {
    delete globalThis.readPaymentMethodsCache;
    delete globalThis.fetchBindingData;
    delete globalThis.ensureVisaVicReadyForUse;
    delete globalThis.fetchInstruction;
    delete globalThis.createPurchaseInstructionDraft;
    delete globalThis.logRequest;
    delete globalThis.logError;
  }
});

test('prepare visa purchase instruction state machine returns missing scope before list or create', async () => {
  const handlePrepareVisaPurchaseInstruction = buildPrepareInstructionHarness();
  let listed = false;
  let created = false;

  globalThis.fetchInstruction = async () => {
    listed = true;
    return [];
  };
  globalThis.createPurchaseInstructionDraft = async () => {
    created = true;
    return 'unexpected create';
  };
  globalThis.logError = async () => {};

  try {
    const result = await handlePrepareVisaPurchaseInstruction({
      title: '全季酒店住宿预订',
      fulfillmentType: 'NO_SHIPPING_REQUIRED',
      mandates: [{
        description: '全季酒店住宿预订',
        currencyCode: 'CNY',
      }],
    });

    assert.equal(listed, false);
    assert.equal(created, false);
    assert.match(result, /state=MISSING_SCOPE/);
    assert.match(result, /amountLimit/i);
    assert.match(result, /merchantCategoryCode or preferredMerchantName/i);
  } finally {
    delete globalThis.fetchInstruction;
    delete globalThis.createPurchaseInstructionDraft;
    delete globalThis.logError;
  }
});

test('prepare visa purchase instruction state machine requires explicit fulfillment type before list or create', async () => {
  const handlePrepareVisaPurchaseInstruction = buildPrepareInstructionHarness();
  let listed = false;
  let created = false;

  globalThis.fetchInstruction = async () => {
    listed = true;
    return [];
  };
  globalThis.createPurchaseInstructionDraft = async () => {
    created = true;
    return 'unexpected create';
  };
  globalThis.logError = async () => {};

  try {
    const result = await handlePrepareVisaPurchaseInstruction({
      title: 'Physical goods purchase',
      mandates: [{
        description: 'Physical goods purchase',
        amountLimit: 120,
        currencyCode: 'USD',
        merchantCategoryCode: '5311',
      }],
    });

    assert.equal(listed, false);
    assert.equal(created, false);
    assert.match(result, /state=MISSING_FULFILLMENT_TYPE/);
    assert.match(result, /fulfillmentType/i);
  } finally {
    delete globalThis.fetchInstruction;
    delete globalThis.createPurchaseInstructionDraft;
    delete globalThis.logError;
  }
});

test('prepare visa purchase instruction state machine blocks unknown fulfillment type before list or create', async () => {
  const handlePrepareVisaPurchaseInstruction = buildPrepareInstructionHarness();
  let listed = false;
  let created = false;

  globalThis.fetchInstruction = async () => {
    listed = true;
    return [];
  };
  globalThis.createPurchaseInstructionDraft = async () => {
    created = true;
    return 'unexpected create';
  };
  globalThis.logError = async () => {};

  try {
    const result = await handlePrepareVisaPurchaseInstruction({
      title: 'Ambiguous purchase',
      fulfillmentType: 'UNKNOWN',
      mandates: [{
        description: 'Ambiguous purchase',
        amountLimit: 120,
        currencyCode: 'USD',
        merchantCategoryCode: '5311',
      }],
    });

    assert.equal(listed, false);
    assert.equal(created, false);
    assert.match(result, /state=MISSING_FULFILLMENT_TYPE/);
    assert.match(result, /must be resolved/i);
  } finally {
    delete globalThis.fetchInstruction;
    delete globalThis.createPurchaseInstructionDraft;
    delete globalThis.logError;
  }
});

test('prepare visa purchase instruction state machine requires shipping address for delivered goods', async () => {
  const handlePrepareVisaPurchaseInstruction = buildPrepareInstructionHarness();
  let listed = false;
  let created = false;

  globalThis.fetchInstruction = async () => {
    listed = true;
    return [];
  };
  globalThis.createPurchaseInstructionDraft = async () => {
    created = true;
    return 'unexpected create';
  };
  globalThis.logError = async () => {};

  try {
    const result = await handlePrepareVisaPurchaseInstruction({
      title: 'Physical goods purchase',
      fulfillmentType: 'PHYSICAL_GOODS_REQUIRES_SHIPPING',
      mandates: [{
        description: 'Physical goods purchase',
        amountLimit: 120,
        currencyCode: 'USD',
        merchantCategoryCode: '5311',
      }],
    });

    assert.equal(listed, false);
    assert.equal(created, false);
    assert.match(result, /state=MISSING_SCOPE/);
    assert.match(result, /shippingAddress/i);
  } finally {
    delete globalThis.fetchInstruction;
    delete globalThis.createPurchaseInstructionDraft;
    delete globalThis.logError;
  }
});

test('prepare visa purchase instruction state machine rejects non-US shipping address', async () => {
  const handlePrepareVisaPurchaseInstruction = buildPrepareInstructionHarness();
  let listed = false;
  let created = false;

  globalThis.fetchInstruction = async () => {
    listed = true;
    return [];
  };
  globalThis.createPurchaseInstructionDraft = async () => {
    created = true;
    return 'unexpected create';
  };
  globalThis.logError = async () => {};

  try {
    const result = await handlePrepareVisaPurchaseInstruction({
      title: 'Physical goods purchase',
      fulfillmentType: 'PHYSICAL_GOODS_REQUIRES_SHIPPING',
      shippingAddress: {
        name: 'Jim',
        line1: 'xxx road',
        city: 'Shanghai',
        state: 'Shanghai',
        zip: '200000',
        countryCode: 'CN',
      },
      mandates: [{
        description: 'Physical goods purchase',
        amountLimit: 120,
        currencyCode: 'USD',
        merchantCategoryCode: '5311',
      }],
    });

    assert.equal(listed, false);
    assert.equal(created, false);
    assert.match(result, /state=MISSING_SCOPE/);
    assert.match(result, /shippingAddress\.countryCode must be US/i);
  } finally {
    delete globalThis.fetchInstruction;
    delete globalThis.createPurchaseInstructionDraft;
    delete globalThis.logError;
  }
});

test('prepare visa purchase instruction state machine does not mark failed draft creation as created', async () => {
  const handlePrepareVisaPurchaseInstruction = buildPrepareInstructionHarness();

  globalThis.readPaymentMethodsCache = async () => ({
    defaultPaymentMethodId: 'pi_vic',
    paymentMethods: [{
      paymentInstrumentId: 'pi_vic',
      paymentMethodType: 'CARD',
      cardBrand: 'visa',
      visaRegistrationSucceeded: true,
      isDefault: true,
    }],
  });
  globalThis.fetchBindingData = async () => {
    throw new Error('fetchBindingData should not be needed');
  };
  globalThis.ensureVisaVicReadyForUse = async ({ paymentInstrumentId }) => ({
    blocked: true,
    route: 'vic_instruction_required',
    paymentMethod: {
      paymentInstrumentId,
      paymentMethodType: 'CARD',
      cardBrand: 'visa',
      visaRegistrationSucceeded: true,
    },
    response: 'VIC-ready',
  });
  globalThis.fetchInstruction = async () => [];
  globalThis.createPurchaseInstructionDraft = async () => 'Failed to create purchase instruction: backend unavailable';
  globalThis.logRequest = async () => {};
  globalThis.logError = async () => {};

  try {
    const result = await handlePrepareVisaPurchaseInstruction({
      title: '全季酒店住宿预订',
      fulfillmentType: 'NO_SHIPPING_REQUIRED',
      mandates: [{
        description: '全季酒店住宿预订',
        amountLimit: 500,
        currencyCode: 'CNY',
        merchantCategoryCode: '7011',
      }],
    });

    assert.match(result, /state=CREATE_FAILED/);
    assert.doesNotMatch(result, /state=CREATED_DRAFT/);
  } finally {
    delete globalThis.readPaymentMethodsCache;
    delete globalThis.fetchBindingData;
    delete globalThis.ensureVisaVicReadyForUse;
    delete globalThis.fetchInstruction;
    delete globalThis.createPurchaseInstructionDraft;
    delete globalThis.logRequest;
    delete globalThis.logError;
  }
});

test('prepare visa purchase instruction state machine reuses a matching active instruction', async () => {
  const handlePrepareVisaPurchaseInstruction = buildPrepareInstructionHarness();
  let createCalled = false;

  globalThis.readPaymentMethodsCache = async () => ({
    defaultPaymentMethodId: 'pi_vic',
    paymentMethods: [{
      paymentInstrumentId: 'pi_vic',
      paymentMethodType: 'CARD',
      cardBrand: 'visa',
      visaRegistrationSucceeded: true,
      isDefault: true,
    }],
  });
  globalThis.fetchBindingData = async () => {
    throw new Error('fetchBindingData should not be needed');
  };
  globalThis.ensureVisaVicReadyForUse = async ({ paymentInstrumentId }) => ({
    blocked: true,
    route: 'vic_instruction_required',
    paymentMethod: {
      paymentInstrumentId,
      paymentMethodType: 'CARD',
      cardBrand: 'visa',
      visaRegistrationSucceeded: true,
    },
    response: 'VIC-ready',
  });
  globalThis.fetchInstruction = async () => [{
    instructionId: 'ins_hotel',
    paymentInstrumentId: 'pi_vic',
    status: 'ACTIVE',
    mandates: [{
      amountLimit: 800,
      currencyCode: 'CNY',
      merchantCategoryCode: '7011',
      effectiveUntilTime: '2026-06-10T23:59:59Z',
    }],
  }];
  globalThis.createPurchaseInstructionDraft = async () => {
    createCalled = true;
    return 'unexpected create';
  };
  globalThis.logRequest = async () => {};
  globalThis.logError = async () => {};

  try {
    const result = await handlePrepareVisaPurchaseInstruction({
      title: '全季酒店住宿预订',
      fulfillmentType: 'NO_SHIPPING_REQUIRED',
      mandates: [{
        description: '全季酒店住宿预订，靠近上海迪士尼',
        amountLimit: 500,
        currencyCode: 'CNY',
        merchantCategoryCode: '7011',
        preferredMerchantName: '全季酒店',
        effectiveUntilTime: '2026-06-10T23:00:00Z',
      }],
    });

    assert.equal(createCalled, false);
    assert.match(result, /state=REUSED_ACTIVE_INSTRUCTION/);
    assert.match(result, /Instruction ID: ins_hotel/);
  } finally {
    delete globalThis.readPaymentMethodsCache;
    delete globalThis.fetchBindingData;
    delete globalThis.ensureVisaVicReadyForUse;
    delete globalThis.fetchInstruction;
    delete globalThis.createPurchaseInstructionDraft;
    delete globalThis.logRequest;
    delete globalThis.logError;
  }
});

test('skill routes current Visa card purchase intents to VIC before merchant plugin fallback', () => {
  assert.match(skillSource, /description: .*purchase\/book.*VIC.*current card is Visa/i);
  assert.match(skillSource, /Current Visa Card \+ Purchase Intent/i);
  assert.match(skillSource, /current\/selected\/default payment method is a Visa card/i);
  assert.match(skillSource, /even when the message does not mention Visa/i);
  assert.match(skillSource, /current payment method is not already known[\s\S]*prepare_visa_purchase_instruction/i);
  assert.match(skillSource, /Purchase intent signals include:[\s\S]*buy[\s\S]*purchase[\s\S]*order[\s\S]*book[\s\S]*reserve[\s\S]*下单[\s\S]*购买[\s\S]*预订[\s\S]*订酒店[\s\S]*买票/i);
  assert.match(skillSource, /prepare_visa_purchase_instruction/);
  assert.match(skillSource, /list_purchase_instructions/);
  assert.match(skillSource, /VIC registration/i);
  assert.match(skillSource, /Do NOT call clink_pay for Visa/i);
  assert.match(skillSource, /do not answer only that the merchant booking plugin is missing/i);
  assert.match(skillSource, /Do NOT ask the user for a payment link/i);
  assert.match(skillSource, /Session ID/i);
});

test('tool descriptions route scoped Visa booking requests into the state machine before fallback', () => {
  assert.match(indexSource, /name: "prepare_visa_purchase_instruction"[\s\S]*VIC state machine/);
  assert.match(indexSource, /name: "prepare_visa_purchase_instruction"[\s\S]*purchase\/book\/order intents/);
  assert.match(indexSource, /name: "prepare_visa_purchase_instruction"[\s\S]*current\/default card/);
  assert.match(indexSource, /name: "prepare_visa_purchase_instruction"[\s\S]*fulfillmentType/);
  assert.match(indexSource, /name: "prepare_visa_purchase_instruction"[\s\S]*PHYSICAL_GOODS_REQUIRES_SHIPPING/);
  assert.match(indexSource, /required: \["title", "fulfillmentType", "mandates"\]/);
  assert.doesNotMatch(indexSource, /requiresShipping/);
  assert.match(indexSource, /name: "prepare_visa_purchase_instruction"[\s\S]*shippingAddress/);
  assert.match(indexSource, /name: "prepare_visa_purchase_instruction"[\s\S]*countryCode[\s\S]*US/);
  assert.match(indexSource, /name: "prepare_visa_purchase_instruction"[\s\S]*do not manually chain pre_check_account\/list\/create first/);
  assert.match(skillSource, /For this exact request, when the current\/default card is Visa, call `prepare_visa_purchase_instruction`/);
  assert.match(skillSource, /state machine then resolves the card/);
  assert.match(skillSource, /creates a draft if no semantic match is returned/);
  assert.match(skillSource, /fulfillmentType/);
  assert.match(skillSource, /NO_SHIPPING_REQUIRED/);
  assert.match(skillSource, /PHYSICAL_GOODS_REQUIRES_SHIPPING/);
  assert.doesNotMatch(skillSource, /requiresShipping/);
  assert.match(skillSource, /shippingAddress/);
  assert.match(skillSource, /countryCode.*US/s);
});

test('skill forces list-then-create flow for scoped Visa hotel booking intents', () => {
  assert.match(skillSource, /prepare_visa_purchase_instruction` must be the next tool call/i);
  assert.match(skillSource, /Do NOT call `create_purchase_instruction` before the state machine list step/i);
  assert.match(skillSource, /semantic match/i);
  assert.match(skillSource, /paymentInstrumentId/);
  assert.match(skillSource, /amountLimit/);
  assert.match(skillSource, /currencyCode/);
  assert.match(skillSource, /merchantCategoryCode.*7011/s);
  assert.match(skillSource, /全季酒店/);
  assert.match(skillSource, /500\.00/);
  assert.match(skillSource, /CNY/);
  assert.match(skillSource, /preferredMerchantName/);
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
  assert.match(result.response, /prepare_visa_purchase_instruction/i);
  assert.match(result.response, /state machine must list ACTIVE instructions/i);
  assert.match(result.response, /paymentInstrumentId=pi_vic/);
  assert.match(result.response, /Do NOT manually call create_purchase_instruction before the state machine list step/i);
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
