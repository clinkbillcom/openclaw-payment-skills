import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const indexSource = await fs.readFile(new URL('../index.mjs', import.meta.url), 'utf8');
const skillSource = await fs.readFile(new URL('../SKILL.md', import.meta.url), 'utf8');

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

function buildUcpCheckoutHarness() {
  const sources = [
    'normalizePaymentMethods',
    'findPaymentMethodById',
    'getPurchaseInstructionId',
    'getPurchaseInstructionMandateId',
    'isActivePurchaseInstructionStatus',
    'isActivePurchaseInstructionMandate',
    'getUcpCheckoutRequestedMandates',
    'findReusableUcpCheckoutAuthorization',
    'resolveCurrentUcpCheckoutPaymentInstrument',
    'normalizeJsonCliFlag',
    'extractUcpCheckoutId',
    'buildUcpCheckoutCreateArgs',
    'isTerminalUcpCheckoutStatus',
    'handle_ucp_checkout',
  ]
    .map((name) => extractFunction(indexSource, name))
    .join('\n\n');

  return new Function(`
    function isVisaRegistrationSucceeded(method) { return method?.visaRegistrationSucceeded === true; }
    function mandateMatchesPurchaseScope(candidateMandate = {}, requestedMandate = {}) {
      const requestedCurrency = String(requestedMandate.currencyCode || '').trim().toUpperCase();
      const candidateCurrency = String(candidateMandate.currencyCode || '').trim().toUpperCase();
      if (requestedCurrency && candidateCurrency !== requestedCurrency) return false;
      const requestedAmount = Number(requestedMandate.amountLimit);
      const candidateAmount = Number(candidateMandate.amountLimit);
      if (Number.isFinite(requestedAmount) && (!Number.isFinite(candidateAmount) || candidateAmount < requestedAmount)) return false;
      const requestedMcc = String(requestedMandate.merchantCategoryCode || '').trim();
      const candidateMcc = String(candidateMandate.merchantCategoryCode || '').trim();
      if (requestedMcc && candidateMcc && candidateMcc !== requestedMcc) return false;
      const requestedMerchant = String(requestedMandate.preferredMerchantName || '').trim().toLowerCase();
      const candidateMerchant = String(candidateMandate.preferredMerchantName || candidateMandate.title || candidateMandate.description || '').trim().toLowerCase();
      return !requestedMerchant || candidateMerchant.includes(requestedMerchant) || requestedMerchant.includes(candidateMerchant);
    }
    async function handle_prepare_visa_purchase_instruction(...args) { return globalThis.handle_prepare_visa_purchase_instruction(...args); }
    ${sources}
    async function fetchBindingData(...args) { return globalThis.fetchBindingData(...args); }
    async function runClinkCli(...args) { return globalThis.runClinkCli(...args); }
    async function logRequest(...args) { return globalThis.logRequest(...args); }
    async function logError(...args) { return globalThis.logError(...args); }
    return { handle_ucp_checkout, extractUcpCheckoutId };
  `)();
}

test('ucp_checkout creates then completes with the current default payment instrument', async () => {
  const { handle_ucp_checkout } = buildUcpCheckoutHarness();
  const calls = [];
  const requestedMandate = {
    title: 'T-shirt purchase',
    description: 'Shop Example T-shirt',
    amountLimit: 10,
    currencyCode: 'USD',
    merchantCategoryCode: '5311',
    preferredMerchantName: 'Shop Example',
  };

  globalThis.fetchBindingData = async () => ({
    methods: [{
      paymentInstrumentId: 'pi_default',
      paymentMethodType: 'CARD',
      cardBrand: 'visa',
      isDefault: true,
    }],
  });
  globalThis.runClinkCli = async (args) => {
    calls.push(args);
    if (args[0] === 'instruction' && args[1] === 'list') {
      return [{
        instructionId: 'ins_matched',
        paymentInstrumentId: 'pi_default',
        status: 'ACTIVE',
        mandates: [{
          ...requestedMandate,
          mandateId: 'mndt_matched',
          status: 'ACTIVE',
        }],
      }];
    }
    if (args[0] === 'ucp-checkout' && args[1] === 'create') {
      assert.ok(args.includes('--instruction-id'));
      assert.equal(args[args.indexOf('--instruction-id') + 1], 'ins_matched');
      assert.ok(args.includes('--mandate-id'));
      assert.equal(args[args.indexOf('--mandate-id') + 1], 'mndt_matched');
      return { checkout_id: 'chk_created', status: 'ready_for_complete' };
    }
    if (args[0] === 'ucp-checkout' && args[1] === 'complete') {
      assert.ok(!args.includes('--instruction-id'));
      assert.ok(!args.includes('--mandate-id'));
      return { checkoutId: 'chk_created', status: 'completed', orderId: 'ord_123' };
    }
    throw new Error(`unexpected CLI call: ${JSON.stringify(args)}`);
  };
  globalThis.logRequest = async () => {};
  globalThis.logError = async () => {};

  try {
    const result = await handle_ucp_checkout({
      merchant_url: 'https://shop.example/products/t-shirt?variant=123',
      merchant_name: 'Shop Example',
      merchant_category_code: '5311',
      currency: 'USD',
      title: 'Shop Example T-shirt',
      fulfillmentType: 'NO_SHIPPING_REQUIRED',
      mandates: [requestedMandate],
      line_items: [{ id: 'li_sku_1', item: { id: 'sku_1', title: 'T-shirt', price: 1000 }, quantity: 1 }],
      buyer: { email: 'buyer@example.com' },
    });

    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], [
      'instruction', 'list',
      '--status', 'ACTIVE',
      '--payment-instrument-id', 'pi_default',
    ]);
    assert.deepEqual(calls[1].slice(0, 2), ['ucp-checkout', 'create']);
    assert.deepEqual(calls[2].slice(0, 2), ['ucp-checkout', 'complete']);
    assert.equal(calls[2][calls[2].indexOf('--checkout-id') + 1], 'chk_created');
    assert.equal(calls[2][calls[2].indexOf('--payment-instrument-id') + 1], 'pi_default');
    assert.match(result, /\[UCP_CHECKOUT_FSM\] state=COMPLETED/);
    assert.match(result, /Checkout ID: chk_created/);
    assert.match(result, /Payment Instrument ID: pi_default/);
  } finally {
    delete globalThis.fetchBindingData;
    delete globalThis.runClinkCli;
    delete globalThis.logRequest;
    delete globalThis.logError;
  }
});

test('ucp_checkout invokes instruction creation workflow when no active instruction mandate matches', async () => {
  const { handle_ucp_checkout } = buildUcpCheckoutHarness();
  const calls = [];
  const requestedMandate = {
    description: 'Shop Example T-shirt',
    amountLimit: 10,
    currencyCode: 'USD',
    merchantCategoryCode: '5311',
    preferredMerchantName: 'Shop Example',
  };

  globalThis.fetchBindingData = async () => ({
    methods: [{ paymentInstrumentId: 'pi_default', paymentMethodType: 'CARD', cardBrand: 'visa', isDefault: true }],
  });
  globalThis.runClinkCli = async (args) => {
    calls.push(args);
    if (args[0] === 'instruction' && args[1] === 'list') return [];
    throw new Error(`ucp-checkout must not run without an active instruction+mandate: ${JSON.stringify(args)}`);
  };
  globalThis.handle_prepare_visa_purchase_instruction = async (args) => {
    calls.push(['prepare_visa_purchase_instruction', args]);
    assert.equal(args.paymentInstrumentId, 'pi_default');
    assert.equal(args.title, 'Shop Example T-shirt');
    assert.equal(args.fulfillmentType, 'NO_SHIPPING_REQUIRED');
    assert.deepEqual(args.mandates, [requestedMandate]);
    return '[VIC_STATE_MACHINE] state=CREATED_DRAFT\nInstruction ID: ins_new';
  };
  globalThis.logRequest = async () => {};
  globalThis.logError = async () => {};

  try {
    const result = await handle_ucp_checkout({
      merchant_url: 'https://shop.example/products/t-shirt?variant=123',
      merchant_name: 'Shop Example',
      merchant_category_code: '5311',
      currency: 'USD',
      title: 'Shop Example T-shirt',
      fulfillmentType: 'NO_SHIPPING_REQUIRED',
      mandates: [requestedMandate],
      line_items: [{ id: 'li_sku_1', item: { id: 'sku_1', title: 'T-shirt', price: 1000 }, quantity: 1 }],
    });

    assert.deepEqual(calls[0], [
      'instruction', 'list',
      '--status', 'ACTIVE',
      '--payment-instrument-id', 'pi_default',
    ]);
    assert.equal(calls[1][0], 'prepare_visa_purchase_instruction');
    assert.match(result, /state=INSTRUCTION_WORKFLOW_REQUIRED/);
    assert.match(result, /no matching ACTIVE instruction\+mandate/i);
    assert.doesNotMatch(result, /state=COMPLETED/);
  } finally {
    delete globalThis.fetchBindingData;
    delete globalThis.runClinkCli;
    delete globalThis.handle_prepare_visa_purchase_instruction;
    delete globalThis.logRequest;
    delete globalThis.logError;
  }
});

test('ucp checkout id extraction accepts all current create response shapes', () => {
  const { extractUcpCheckoutId } = buildUcpCheckoutHarness();

  assert.equal(extractUcpCheckoutId({ id: 'chk_id' }), 'chk_id');
  assert.equal(extractUcpCheckoutId({ checkout_id: 'chk_snake' }), 'chk_snake');
  assert.equal(extractUcpCheckoutId({ checkoutId: 'chk_camel' }), 'chk_camel');
  assert.equal(extractUcpCheckoutId({ data: { id: 'chk_nested' } }), 'chk_nested');
});

test('ucp_checkout tool and SKILL docs require continuous create to complete handoff', () => {
  assert.match(indexSource, /name: "ucp_checkout"/);
  assert.match(indexSource, /case "ucp_checkout"/);
  assert.match(indexSource, /instruction',\s*'list'/);
  assert.match(indexSource, /ucp-checkout',\s*'create'/);
  assert.match(indexSource, /ucp-checkout',\s*'complete'/);
  assert.match(indexSource, /--payment-instrument-id/);

  assert.match(skillSource, /UCP Checkout Product Order Flow/i);
  assert.match(skillSource, /ucp_checkout/);
  assert.match(skillSource, /instruction list/i);
  assert.match(skillSource, /instruction_id/i);
  assert.match(skillSource, /mandate_id/i);
  assert.match(skillSource, /创建 instruction workflow|instruction creation workflow/i);
  assert.match(skillSource, /create.*complete/is);
  assert.match(skillSource, /checkoutId/);
  assert.match(skillSource, /current\/default paymentInstrumentId/i);
  assert.match(skillSource, /UCP checkout completion is not merchant fulfillment/i);
  assert.doesNotMatch(skillSource, /credential-token/i);
});

test('vendored clink-cli exposes ucp checkout complete with payment instrument only', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    new URL('../vendor/clink-cli/clink-cli.bundle.mjs', import.meta.url).pathname,
    'ucp-checkout',
    '--help',
  ]);

  assert.match(stdout, /complete\s+Complete checkout with a payment instrument/);
  assert.match(stdout, /--payment-instrument-id <id>\s+Required payment instrument ID for complete/);
  assert.match(stdout, /external complete sends payment_instrument_id only/);
  assert.doesNotMatch(stdout, /credential-token/);
});

test('vendored clink-cli preserves OpenClaw epoch-second instruction expiry contract', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    new URL('../vendor/clink-cli/clink-cli.bundle.mjs', import.meta.url).pathname,
    'instruction',
    '--help',
  ]);

  assert.match(stdout, /effectiveUntilTime are Unix epoch seconds/);
  assert.match(stdout, /--effective-until-time "1782345600"/);
  assert.doesNotMatch(stdout, /yyyy-MM-dd HH:mm:ss/);
});
