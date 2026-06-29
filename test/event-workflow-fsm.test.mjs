import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EventWorkflowAction,
  EventWorkflowDomain,
  EventWorkflowState,
  classifyEventWorkflow,
} from '../lib/event-workflow-fsm.mjs';

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

test('classifies unknown events without throwing', () => {
  assert.deepEqual(classifyEventWorkflow({ type: 'new.future.event' }), {
    domain: EventWorkflowDomain.UNKNOWN,
    state: EventWorkflowState.UNKNOWN_EVENT,
    action: EventWorkflowAction.LOG_ONLY,
    terminal: false,
    reason: 'new.future.event',
  });
});
