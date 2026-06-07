import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

async function setupWebhookTestSkillDir(initialCache) {
  const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), 'payment-webhook-update-'));
  await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'notification-utils.js'),
    [
      'export function createMessageRequest({ messageKey, vars = {} }) {',
      '  return { message_key: messageKey, messageKey, vars };',
      '}',
      'export function renderMessageMarkdown(message) {',
      '  return `${message.messageKey || message.message_key} ${JSON.stringify(message.vars || {})}`;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.copyFile(
    new URL('../vic-registration-state-utils.mjs', import.meta.url),
    path.join(skillDir, 'vic-registration-state-utils.mjs'),
  );
  await fs.writeFile(
    path.join(skillDir, 'clink.config.json'),
    JSON.stringify(initialCache, null, 2),
    'utf8',
  );
  return skillDir;
}

async function importWebhookForSkillDir(skillDir) {
  globalThis.__AGENT_PAYMENT_SKILL_DIR__ = skillDir;
  const webhookUrl = new URL('../hooks/my_payment_webhook.mjs', import.meta.url);
  webhookUrl.searchParams.set('cacheBust', `${Date.now()}-${Math.random()}`);
  const module = await import(webhookUrl.href);
  return module.default;
}

async function readCache(skillDir) {
  return JSON.parse(await fs.readFile(path.join(skillDir, 'clink.config.json'), 'utf8'));
}

test('payment_method.update upserts an existing payment method and triggers VIC completion', async () => {
  const skillDir = await setupWebhookTestSkillDir({
    initialized: true,
    paymentMethods: [{
      paymentInstrumentId: 'pi_visa_1',
      paymentMethodType: 'CARD',
      cardBrand: 'visa',
      cardLast4: '4242',
      visaRegistrationSucceeded: false,
      isDefault: true,
    }],
    defaultPaymentMethodId: 'pi_visa_1',
  });
  const webhook = await importWebhookForSkillDir(skillDir);

  const result = await webhook({
    payload: {
      type: 'payment_method.update',
      data: {
        paymentInstrumentId: 'pi_visa_1',
        paymentMethodType: 'CARD',
        cardBrand: 'visa',
        cardLast4: '4242',
        visaRegistrationSucceeded: true,
        isDefault: true,
      },
    },
  });

  const cache = await readCache(skillDir);
  assert.equal(cache.paymentMethods.length, 1);
  assert.equal(cache.paymentMethods[0].paymentInstrumentId, 'pi_visa_1');
  assert.equal(cache.paymentMethods[0].visaRegistrationSucceeded, true);
  assert.equal(cache.defaultPaymentMethodId, 'pi_visa_1');
  assert.match(result.message, /VIC 注册完成回调/);
  assert.match(result.message, /Continue the VIC purchase instruction flow/);
});

test('payment_method.update treats visaRegistrationSucceeded as VIC completion', async () => {
  const skillDir = await setupWebhookTestSkillDir({
    initialized: true,
    paymentMethods: [{
      paymentInstrumentId: 'pi_visa_1',
      paymentMethodType: 'CARD',
      cardBrand: 'visa',
      cardLast4: '4242',
      visaRegistrationSucceeded: false,
      isDefault: true,
    }],
    defaultPaymentMethodId: 'pi_visa_1',
  });
  const webhook = await importWebhookForSkillDir(skillDir);

  const result = await webhook({
    payload: {
      type: 'payment_method.update',
      data: {
        paymentInstrumentId: 'pi_visa_1',
        paymentMethodType: 'CARD',
        cardBrand: 'visa',
        cardLast4: '4242',
        visaRegistrationSucceeded: true,
        isDefault: true,
      },
    },
  });

  const cache = await readCache(skillDir);
  assert.equal(cache.paymentMethods[0].visaRegistrationSucceeded, true);
  assert.ok(
    Object.values(cache.paymentFlowStates).some((state) =>
      state.paymentInstrumentId === 'pi_visa_1' && state.status === 'ready'
    ),
  );
  assert.match(result.message, /VIC 注册完成回调/);
});

test('payment_method.update inserts an unseen payment method into cache without bound-success notification', async () => {
  const skillDir = await setupWebhookTestSkillDir({
    initialized: true,
    paymentMethods: [],
    defaultPaymentMethodId: null,
  });
  const webhook = await importWebhookForSkillDir(skillDir);

  const result = await webhook({
    payload: {
      type: 'payment_method.update',
      data: {
        paymentInstrumentId: 'pi_new_card',
        paymentMethodType: 'CARD',
        cardBrand: 'mastercard',
        cardLast4: '5555',
        visaRegistrationSucceeded: false,
        isDefault: true,
      },
    },
  });

  const cache = await readCache(skillDir);
  assert.equal(cache.paymentMethods.length, 1);
  assert.equal(cache.paymentMethods[0].paymentInstrumentId, 'pi_new_card');
  assert.equal(cache.paymentMethods[0].cardBrand, 'mastercard');
  assert.equal(cache.defaultPaymentMethodId, 'pi_new_card');
  assert.equal(result, null);
});
