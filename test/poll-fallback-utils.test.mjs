import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDirectSendDirective,
  buildPollFallbackTimeoutMessageRequest,
  getReusableAsyncOperation,
} from '../poll-fallback-utils.mjs';

test('reuses non-terminal operations by type for active poll fallbacks', () => {
  const cache = {
    asyncOperations: {
      activeBind: {
        id: 'op_bind_1',
        type: 'bind_card',
        status: 'pending',
        expireAt: Date.now() + 60_000,
      },
      timedOutBind: {
        id: 'op_bind_2',
        type: 'bind_card',
        status: 'timeout',
        expireAt: Date.now() + 60_000,
      },
    },
  };

  assert.equal(
    getReusableAsyncOperation(cache, 'bind_card')?.id,
    'op_bind_1',
  );
  assert.equal(
    getReusableAsyncOperation(cache, 'refund_status'),
    null,
  );
});

test('does not reuse VIC registration operations for a different payment instrument', () => {
  const cache = {
    asyncOperations: {
      activeVicRegistration: {
        id: 'op_vic_1',
        type: 'vic_registration',
        paymentInstrumentId: 'pi_visa_1',
        status: 'pending',
        expireAt: Date.now() + 60_000,
      },
    },
  };

  assert.equal(
    getReusableAsyncOperation(cache, 'vic_registration', Date.now(), { paymentInstrumentId: 'pi_visa_2' }),
    null,
  );
  assert.equal(
    getReusableAsyncOperation(cache, 'vic_registration', Date.now(), { paymentInstrumentId: 'pi_visa_1' })?.id,
    'op_vic_1',
  );
});

test('keeps DIRECT_SEND_POLL_REQUIRED only when a poll operation actually exists', () => {
  const started = buildDirectSendDirective({
    summary: 'Setup link sent.',
    pollFallback: { required: true, operation: { id: 'op_123' } },
    pollFallbackLines: ['Poll fallback operation: op_123'],
    webhookWaitMessage: 'Wait for webhook.',
  });
  assert.match(started, /^\[SYSTEM DIRECTIVE\] DIRECT_SEND_POLL_REQUIRED:/);

  const unscheduled = buildDirectSendDirective({
    summary: 'Setup link sent.',
    pollFallback: { required: true, operation: null },
    pollFallbackLines: ['Poll fallback could not be scheduled automatically.'],
    webhookWaitMessage: 'Wait for webhook.',
  });
  assert.match(unscheduled, /^\[SYSTEM DIRECTIVE\] DIRECT_SEND:/);
  assert.doesNotMatch(unscheduled, /DIRECT_SEND_POLL_REQUIRED/);
});

test('builds a timeout notification payload for bind-card poll fallback flows', () => {
  const message = buildPollFallbackTimeoutMessageRequest('bind_card');

  assert.deepEqual(message, {
    messageKey: 'poll_fallback.timeout',
    vars: {
      flowLabel: 'payment method setup',
      referenceId: 'N/A',
      expectedEvent: 'payment_method.added',
    },
  });
});

test('builds a timeout notification payload for VIC registration poll fallback flows', () => {
  const message = buildPollFallbackTimeoutMessageRequest('vic_registration');

  assert.deepEqual(message, {
    messageKey: 'poll_fallback.timeout',
    vars: {
      flowLabel: 'VIC registration',
      referenceId: 'N/A',
      expectedEvent: 'payment_method.added',
    },
  });
});
