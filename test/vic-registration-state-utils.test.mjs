import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveVicRegistrationState,
  markVicRegistrationReady,
  getVicRegistrationStateKey,
} from '../vic-registration-state-utils.mjs';

const chatA = {
  channel: 'feishu',
  target: { type: 'chat_id', id: 'oc_a' },
};

const chatB = {
  channel: 'feishu',
  target: { type: 'chat_id', id: 'oc_b' },
};

test('first unresolved Visa registration enters pending_notified and should notify', () => {
  const result = resolveVicRegistrationState({
    cache: {},
    paymentInstrumentId: 'pi_visa_1',
    cardDisplay: 'VISA ****9031',
    notifyDestination: chatA,
    now: 1_000,
    ttlMs: 30_000,
  });

  assert.equal(result.shouldNotify, true);
  assert.equal(result.key, 'vic_registration:pi_visa_1:feishu:chat_id:oc_a');
  assert.equal(result.state.status, 'pending_notified');
  assert.equal(result.state.paymentInstrumentId, 'pi_visa_1');
  assert.deepEqual(result.state.notifyDestination, chatA);
  assert.equal(result.state.cardDisplay, 'VISA ****9031');
  assert.equal(result.state.notifiedAt, 1_000);
  assert.equal(result.state.expireAt, 31_000);
});

test('same unresolved Visa registration reuses pending state without notifying again', () => {
  const key = getVicRegistrationStateKey('pi_visa_1', chatA);
  const cache = {
    paymentFlowStates: {
      [key]: {
        type: 'vic_registration',
        status: 'pending_notified',
        paymentInstrumentId: 'pi_visa_1',
        notifyDestination: chatA,
        cardDisplay: 'VISA ****9031',
        notifiedAt: 1_000,
        expireAt: 31_000,
      },
    },
  };

  const result = resolveVicRegistrationState({
    cache,
    paymentInstrumentId: 'pi_visa_1',
    cardDisplay: 'VISA ****9031',
    notifyDestination: chatA,
    now: 2_000,
    ttlMs: 30_000,
  });

  assert.equal(result.shouldNotify, false);
  assert.equal(result.state.status, 'pending_notified');
  assert.equal(result.state.notifiedAt, 1_000);
});

test('same Visa registration notifies separately for a different destination', () => {
  const key = getVicRegistrationStateKey('pi_visa_1', chatA);
  const cache = {
    paymentFlowStates: {
      [key]: {
        type: 'vic_registration',
        status: 'pending_notified',
        paymentInstrumentId: 'pi_visa_1',
        notifyDestination: chatA,
        cardDisplay: 'VISA ****9031',
        notifiedAt: 1_000,
        expireAt: 31_000,
      },
    },
  };

  const result = resolveVicRegistrationState({
    cache,
    paymentInstrumentId: 'pi_visa_1',
    cardDisplay: 'VISA ****9031',
    notifyDestination: chatB,
    now: 2_000,
    ttlMs: 30_000,
  });

  assert.equal(result.shouldNotify, true);
  assert.equal(result.key, 'vic_registration:pi_visa_1:feishu:chat_id:oc_b');
  assert.deepEqual(result.state.notifyDestination, chatB);
});

test('expired unresolved Visa registration notifies again with a fresh pending state', () => {
  const key = getVicRegistrationStateKey('pi_visa_1', chatA);
  const cache = {
    paymentFlowStates: {
      [key]: {
        type: 'vic_registration',
        status: 'pending_notified',
        paymentInstrumentId: 'pi_visa_1',
        notifyDestination: chatA,
        cardDisplay: 'VISA ****9031',
        notifiedAt: 1_000,
        expireAt: 2_000,
      },
    },
  };

  const result = resolveVicRegistrationState({
    cache,
    paymentInstrumentId: 'pi_visa_1',
    cardDisplay: 'VISA ****9031',
    notifyDestination: chatA,
    now: 3_000,
    ttlMs: 30_000,
  });

  assert.equal(result.shouldNotify, true);
  assert.equal(result.state.status, 'pending_notified');
  assert.equal(result.state.notifiedAt, 3_000);
  assert.equal(result.state.expireAt, 33_000);
});

test('VIC registration completion marks matching states ready', () => {
  const keyA = getVicRegistrationStateKey('pi_visa_1', chatA);
  const keyB = getVicRegistrationStateKey('pi_visa_1', chatB);
  const cache = {
    paymentFlowStates: {
      [keyA]: {
        type: 'vic_registration',
        status: 'pending_notified',
        paymentInstrumentId: 'pi_visa_1',
        notifyDestination: chatA,
        notifiedAt: 1_000,
        expireAt: 31_000,
      },
      [keyB]: {
        type: 'vic_registration',
        status: 'pending_notified',
        paymentInstrumentId: 'pi_visa_1',
        notifyDestination: chatB,
        notifiedAt: 1_000,
        expireAt: 31_000,
      },
    },
  };

  const result = markVicRegistrationReady({
    cache,
    paymentInstrumentId: 'pi_visa_1',
    now: 4_000,
  });

  assert.equal(result.states[keyA].status, 'ready');
  assert.equal(result.states[keyA].readyAt, 4_000);
  assert.equal(result.states[keyB].status, 'ready');
  assert.equal(result.states[keyB].readyAt, 4_000);
});
