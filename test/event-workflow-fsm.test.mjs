import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EventWorkflowAction,
  EventWorkflowDomain,
  EventWorkflowState,
  classifyEventWorkflow,
  correlateEventWorkflow,
} from '../lib/event-workflow-fsm.mjs';
import { formatWorkflowMarker } from '../lib/workflow-marker.mjs';

test('exports stable event workflow enum contracts', () => {
  assert.deepEqual(Object.values(EventWorkflowDomain), [
    'PAYMENT_METHOD',
    'PAYMENT',
    'REFUND',
    'RISK_RULE',
    'VIC',
    'UNKNOWN',
  ]);
  assert.deepEqual(Object.values(EventWorkflowAction), [
    'UPDATE_CACHE_AND_NOTIFY',
    'CACHE_ONLY',
    'NOTIFY_AND_CONFIRM_MERCHANT',
    'NOTIFY_FAILURE_AND_CLEAR_PENDING',
    'NOTIFY_REFUND_FINAL',
    'NOTIFY_RISK_RULE_UPDATED',
    'MARK_VIC_READY_AND_NOTIFY',
    'IGNORE_INTERMEDIATE',
    'LOG_ONLY',
  ]);
});

test('classifies payment method added as method bound notification', () => {
  assert.deepEqual(classifyEventWorkflow({ type: 'payment_method.added' }), {
    domain: EventWorkflowDomain.PAYMENT_METHOD,
    state: EventWorkflowState.METHOD_BOUND,
    action: EventWorkflowAction.UPDATE_CACHE_AND_NOTIFY,
    terminal: true,
    reason: 'payment_method.added',
  });
});

test('classifies order success as payment async success and merchant confirmation', () => {
  assert.deepEqual(classifyEventWorkflow({ type: 'agent_order.succeeded' }), {
    domain: EventWorkflowDomain.PAYMENT,
    state: EventWorkflowState.PAY_ASYNC_SUCCEEDED,
    action: EventWorkflowAction.NOTIFY_AND_CONFIRM_MERCHANT,
    terminal: true,
    reason: 'agent_order.succeeded',
  });
});

test('classifies refund final events', () => {
  assert.equal(classifyEventWorkflow({ type: 'agent_refund.succeeded' }).state, EventWorkflowState.REFUND_SUCCEEDED);
  assert.equal(classifyEventWorkflow({ type: 'agent_refund.approved' }).state, EventWorkflowState.REFUND_SUCCEEDED);
  assert.equal(classifyEventWorkflow({ type: 'agent_refund.failed' }).state, EventWorkflowState.REFUND_FAILED);
  assert.equal(classifyEventWorkflow({ type: 'agent_refund.rejected' }).state, EventWorkflowState.REFUND_REJECTED);
});

test('classifies eventType and data.type aliases', () => {
  assert.equal(classifyEventWorkflow({ eventType: 'risk_rule.updated' }).state, EventWorkflowState.RISK_RULE_UPDATED);
  assert.equal(classifyEventWorkflow({ data: { type: 'purchase_instruction.activated' } }).state, EventWorkflowState.VIC_READY);
});

test('classifies Visa-ready payment method updates as VIC ready notifications', () => {
  assert.deepEqual(classifyEventWorkflow({
    type: 'payment_method.updated',
    data: {
      paymentInstrumentId: 'pi_visa',
      visaRegistrationSucceeded: true,
    },
  }), {
    domain: EventWorkflowDomain.VIC,
    state: EventWorkflowState.VIC_READY,
    action: EventWorkflowAction.MARK_VIC_READY_AND_NOTIFY,
    terminal: true,
    reason: 'payment_method.updated_vic_ready',
  });
});

test('formats event workflow markers consistently', () => {
  const workflow = classifyEventWorkflow({ eventType: 'agent_order.succeeded' });

  assert.equal(
    formatWorkflowMarker('EVENT_FSM', workflow),
    '[EVENT_FSM] domain=PAYMENT state=PAY_ASYNC_SUCCEEDED action=NOTIFY_AND_CONFIRM_MERCHANT reason=agent_order.succeeded',
  );
});

test('correlates payment and refund events to expected resources', () => {
  assert.deepEqual(correlateEventWorkflow({
    type: 'agent_order.succeeded',
    data: { sessionId: 'sess_123' },
  }, { sessionId: 'sess_123' }), {
    matched: true,
    missingKeys: [],
    mismatchedKeys: [],
    workflow: {
      domain: EventWorkflowDomain.PAYMENT,
      state: EventWorkflowState.PAY_ASYNC_SUCCEEDED,
      action: EventWorkflowAction.NOTIFY_AND_CONFIRM_MERCHANT,
      terminal: true,
      reason: 'agent_order.succeeded',
    },
  });

  assert.deepEqual(correlateEventWorkflow({
    type: 'agent_refund.failed',
    data: { refundOrderId: 'rfd_123' },
  }, { refundOrderId: 'rfd_456' }), {
    matched: false,
    missingKeys: [],
    mismatchedKeys: ['refundOrderId|refundId'],
    workflow: {
      domain: EventWorkflowDomain.REFUND,
      state: EventWorkflowState.REFUND_FAILED,
      action: EventWorkflowAction.NOTIFY_REFUND_FINAL,
      terminal: true,
      reason: 'agent_refund.failed',
    },
  });
});

test('correlates VIC events to instruction or payment instrument resources', () => {
  assert.equal(correlateEventWorkflow({
    type: 'purchase_instruction.activated',
    data: { instructionId: 'ins_123' },
  }, { instructionId: 'ins_123' }).matched, true);

  assert.deepEqual(correlateEventWorkflow({
    type: 'payment_method.updated',
    data: {
      paymentInstrumentId: 'pi_visa',
      visaRegistrationSucceeded: true,
    },
  }, { paymentInstrumentId: 'pi_other' }), {
    matched: false,
    missingKeys: [],
    mismatchedKeys: ['paymentInstrumentId'],
    workflow: {
      domain: EventWorkflowDomain.VIC,
      state: EventWorkflowState.VIC_READY,
      action: EventWorkflowAction.MARK_VIC_READY_AND_NOTIFY,
      terminal: true,
      reason: 'payment_method.updated_vic_ready',
    },
  });
});

test('does not treat type-only events as correlated workflow completion', () => {
  const result = correlateEventWorkflow({ type: 'agent_order.succeeded' }, {});

  assert.equal(result.matched, false);
  assert.deepEqual(result.missingKeys, ['expectedResource']);
});

test('classifies unknown events without throwing', () => {
  assert.deepEqual(classifyEventWorkflow({ type: 'new.future.event' }), {
    domain: EventWorkflowDomain.UNKNOWN,
    state: EventWorkflowState.UNKNOWN_EVENT,
    action: EventWorkflowAction.LOG_ONLY,
    terminal: false,
    reason: 'new.future.event',
  });
});
