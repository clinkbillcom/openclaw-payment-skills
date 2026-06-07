import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveVicRegistrationState,
  markVicRegistrationReady,
} from '../vic-registration-state-utils.mjs';

test('first unresolved Visa registration enters pending_notified and should notify', () => {
  const result = resolveVicRegistrationState({
    cache: {},
    paymentInstrumentId: 'pi_visa_1',
    cardDisplay: 'VISA ****9031',
    now: 1_000,
    ttlMs: 30_000,
  });

  assert.equal(result.shouldNotify, true);
  assert.equal(result.key, 'vic_registration:pi_visa_1');
  assert.equal(result.state.status, 'pending_notified');
  assert.equal(result.state.paymentInstrumentId, 'pi_visa_1');
  assert.equal(result.state.cardDisplay, 'VISA ****9031');
  assert.equal(result.state.notifiedAt, 1_000);
  assert.equal(result.state.expireAt, 31_000);
});

test('same unresolved Visa registration reuses pending state without notifying again', () => {
  const cache = {
    paymentFlowStates: {
      'vic_registration:pi_visa_1': {
        type: 'vic_registration',
        status: 'pending_notified',
        paymentInstrumentId: 'pi_visa_1',
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
    now: 2_000,
    ttlMs: 30_000,
  });

  assert.equal(result.shouldNotify, false);
  assert.equal(result.state.status, 'pending_notified');
  assert.equal(result.state.notifiedAt, 1_000);
});

test('expired unresolved Visa registration notifies again with a fresh pending state', () => {
  const cache = {
    paymentFlowStates: {
      'vic_registration:pi_visa_1': {
        type: 'vic_registration',
        status: 'pending_notified',
        paymentInstrumentId: 'pi_visa_1',
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
    now: 3_000,
    ttlMs: 30_000,
  });

  assert.equal(result.shouldNotify, true);
  assert.equal(result.state.status, 'pending_notified');
  assert.equal(result.state.notifiedAt, 3_000);
  assert.equal(result.state.expireAt, 33_000);
});

test('VIC registration completion marks the matching state ready', () => {
  const cache = {
    paymentFlowStates: {
      'vic_registration:pi_visa_1': {
        type: 'vic_registration',
        status: 'pending_notified',
        paymentInstrumentId: 'pi_visa_1',
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

  assert.equal(result.state.status, 'ready');
  assert.equal(result.state.readyAt, 4_000);
});
