import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PaymentWorkflowAction,
  PaymentWorkflowState,
  classifyPaymentError,
  classifyPaymentResponse,
} from '../lib/payment-workflow-fsm.mjs';

test('classifies 3DS response as waiting for event pump', () => {
  const result = classifyPaymentResponse({
    channelPaymentResponse: {
      flag3DS: 1,
      status: 0,
      action: { redirectUrl: 'https://issuer.example/3ds' },
    },
  });
  assert.deepEqual(result, {
    state: PaymentWorkflowState.THREE_DS_REQUIRED,
    action: PaymentWorkflowAction.SEND_3DS_AND_WAIT_EVENT,
    terminal: false,
    reason: '3ds_required',
  });
});

test('classifies sync success as notify and merchant confirmation', () => {
  const result = classifyPaymentResponse({ channelPaymentResponse: { status: 1 } });
  assert.deepEqual(result, {
    state: PaymentWorkflowState.PAY_SYNC_SUCCEEDED,
    action: PaymentWorkflowAction.NOTIFY_SUCCESS_AND_CONFIRM_MERCHANT,
    terminal: true,
    reason: 'status_1_success',
  });
});

test('classifies terminal payment statuses as failure notification', () => {
  for (const status of [3, 4, 6]) {
    const result = classifyPaymentResponse({ channelPaymentResponse: { status } });
    assert.equal(result.state, PaymentWorkflowState.PAY_SYNC_FAILED);
    assert.equal(result.action, PaymentWorkflowAction.NOTIFY_FAILURE_STOP);
    assert.equal(result.terminal, true);
    assert.equal(result.reason, `status_${status}_failure`);
  }
});

test('classifies nonterminal or missing status as submitted and waiting for event pump', () => {
  for (const payload of [{ channelPaymentResponse: { status: 0 } }, { channelPaymentResponse: {} }, {}]) {
    const result = classifyPaymentResponse(payload);
    assert.equal(result.state, PaymentWorkflowState.PAY_SUBMITTED);
    assert.equal(result.action, PaymentWorkflowAction.WAIT_EVENT_PUMP);
    assert.equal(result.terminal, false);
  }
});

test('classifies timeout/network errors as unknown without retry', () => {
  const err = new Error('request timed out');
  err.exitCode = 6;
  const result = classifyPaymentError(err);
  assert.deepEqual(result, {
    state: PaymentWorkflowState.PAY_UNKNOWN,
    action: PaymentWorkflowAction.VERIFY_BEFORE_RETRY,
    terminal: false,
    reason: 'exit_6_unknown',
  });
});

test('classifies config/auth errors as wallet setup required', () => {
  for (const exitCode of [3, 4]) {
    const err = new Error('wallet unavailable');
    err.exitCode = exitCode;
    const result = classifyPaymentError(err);
    assert.equal(result.state, PaymentWorkflowState.WALLET_SETUP_REQUIRED);
    assert.equal(result.action, PaymentWorkflowAction.ASK_WALLET_SETUP);
    assert.equal(result.terminal, false);
    assert.equal(result.reason, `exit_${exitCode}_wallet_setup_required`);
  }
});
