export const EventWorkflowDomain = Object.freeze({
  PAYMENT_METHOD: 'PAYMENT_METHOD',
  PAYMENT: 'PAYMENT',
  REFUND: 'REFUND',
  RISK_RULE: 'RISK_RULE',
  VIC: 'VIC',
  UNKNOWN: 'UNKNOWN',
});

export const EventWorkflowState = Object.freeze({
  METHOD_BOUND: 'METHOD_BOUND',
  METHOD_UPDATED: 'METHOD_UPDATED',
  METHOD_DEFAULT_CHANGED: 'METHOD_DEFAULT_CHANGED',
  PAY_ASYNC_SUCCEEDED: 'PAY_ASYNC_SUCCEEDED',
  PAY_ASYNC_FAILED: 'PAY_ASYNC_FAILED',
  REFUND_SUCCEEDED: 'REFUND_SUCCEEDED',
  REFUND_FAILED: 'REFUND_FAILED',
  REFUND_REJECTED: 'REFUND_REJECTED',
  RISK_RULE_UPDATED: 'RISK_RULE_UPDATED',
  VIC_READY: 'VIC_READY',
  ORDER_CREATED_OBSERVED: 'ORDER_CREATED_OBSERVED',
  UNKNOWN_EVENT: 'UNKNOWN_EVENT',
});

export const EventWorkflowAction = Object.freeze({
  UPDATE_CACHE_AND_NOTIFY: 'UPDATE_CACHE_AND_NOTIFY',
  CACHE_ONLY: 'CACHE_ONLY',
  NOTIFY_AND_CONFIRM_MERCHANT: 'NOTIFY_AND_CONFIRM_MERCHANT',
  NOTIFY_FAILURE_AND_CLEAR_PENDING: 'NOTIFY_FAILURE_AND_CLEAR_PENDING',
  NOTIFY_REFUND_FINAL: 'NOTIFY_REFUND_FINAL',
  NOTIFY_RISK_RULE_UPDATED: 'NOTIFY_RISK_RULE_UPDATED',
  MARK_VIC_READY_AND_NOTIFY: 'MARK_VIC_READY_AND_NOTIFY',
  IGNORE_INTERMEDIATE: 'IGNORE_INTERMEDIATE',
  LOG_ONLY: 'LOG_ONLY',
});

export function eventTypeOf(event) {
  return event?.eventType || event?.data?.type || event?.type || '';
}

export function classifyEventWorkflow(event = {}) {
  const type = eventTypeOf(event);
  switch (type) {
    case 'payment_method.added':
      return {
        domain: EventWorkflowDomain.PAYMENT_METHOD,
        state: EventWorkflowState.METHOD_BOUND,
        action: EventWorkflowAction.UPDATE_CACHE_AND_NOTIFY,
        terminal: true,
        reason: type,
      };
    case 'payment_method.updated':
    case 'payment_method.update':
      return {
        domain: EventWorkflowDomain.PAYMENT_METHOD,
        state: EventWorkflowState.METHOD_UPDATED,
        action: EventWorkflowAction.CACHE_ONLY,
        terminal: true,
        reason: type,
      };
    case 'payment_method.default_change':
      return {
        domain: EventWorkflowDomain.PAYMENT_METHOD,
        state: EventWorkflowState.METHOD_DEFAULT_CHANGED,
        action: EventWorkflowAction.UPDATE_CACHE_AND_NOTIFY,
        terminal: true,
        reason: type,
      };
    case 'agent_order.created':
      return {
        domain: EventWorkflowDomain.PAYMENT,
        state: EventWorkflowState.ORDER_CREATED_OBSERVED,
        action: EventWorkflowAction.IGNORE_INTERMEDIATE,
        terminal: false,
        reason: type,
      };
    case 'agent_order.succeeded':
      return {
        domain: EventWorkflowDomain.PAYMENT,
        state: EventWorkflowState.PAY_ASYNC_SUCCEEDED,
        action: EventWorkflowAction.NOTIFY_AND_CONFIRM_MERCHANT,
        terminal: true,
        reason: type,
      };
    case 'agent_order.failed':
      return {
        domain: EventWorkflowDomain.PAYMENT,
        state: EventWorkflowState.PAY_ASYNC_FAILED,
        action: EventWorkflowAction.NOTIFY_FAILURE_AND_CLEAR_PENDING,
        terminal: true,
        reason: type,
      };
    case 'agent_refund.succeeded':
    case 'agent_refund.approved':
      return {
        domain: EventWorkflowDomain.REFUND,
        state: EventWorkflowState.REFUND_SUCCEEDED,
        action: EventWorkflowAction.NOTIFY_REFUND_FINAL,
        terminal: true,
        reason: type,
      };
    case 'agent_refund.failed':
      return {
        domain: EventWorkflowDomain.REFUND,
        state: EventWorkflowState.REFUND_FAILED,
        action: EventWorkflowAction.NOTIFY_REFUND_FINAL,
        terminal: true,
        reason: type,
      };
    case 'agent_refund.rejected':
      return {
        domain: EventWorkflowDomain.REFUND,
        state: EventWorkflowState.REFUND_REJECTED,
        action: EventWorkflowAction.NOTIFY_REFUND_FINAL,
        terminal: true,
        reason: type,
      };
    case 'risk_rule.updated':
      return {
        domain: EventWorkflowDomain.RISK_RULE,
        state: EventWorkflowState.RISK_RULE_UPDATED,
        action: EventWorkflowAction.NOTIFY_RISK_RULE_UPDATED,
        terminal: true,
        reason: type,
      };
    case 'purchase_instruction.activated':
    case 'vic_device.binding_succeeded':
      return {
        domain: EventWorkflowDomain.VIC,
        state: EventWorkflowState.VIC_READY,
        action: EventWorkflowAction.MARK_VIC_READY_AND_NOTIFY,
        terminal: true,
        reason: type,
      };
    default:
      return {
        domain: EventWorkflowDomain.UNKNOWN,
        state: EventWorkflowState.UNKNOWN_EVENT,
        action: EventWorkflowAction.LOG_ONLY,
        terminal: false,
        reason: type || 'missing_event_type',
      };
  }
}
