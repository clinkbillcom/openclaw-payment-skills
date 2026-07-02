import { formatWorkflowMarker } from './workflow-marker.mjs';

export const PaymentWorkflowState = Object.freeze({
  PAYMENT_INPUT_MISSING: 'PAYMENT_INPUT_MISSING',
  ACCOUNT_PRECHECK: 'ACCOUNT_PRECHECK',
  READY_TO_PAY: 'READY_TO_PAY',
  PAY_SUBMITTED: 'PAY_SUBMITTED',
  PAY_SYNC_SUCCEEDED: 'PAY_SYNC_SUCCEEDED',
  PAY_SYNC_FAILED: 'PAY_SYNC_FAILED',
  THREE_DS_REQUIRED: 'THREE_DS_REQUIRED',
  PAY_UNKNOWN: 'PAY_UNKNOWN',
  WALLET_SETUP_REQUIRED: 'WALLET_SETUP_REQUIRED',
  CLI_ERROR: 'CLI_ERROR',
});

export const PaymentWorkflowAction = Object.freeze({
  ASK_FOR_INPUT: 'ASK_FOR_INPUT',
  RUN_PRECHECK: 'RUN_PRECHECK',
  RUN_PAY: 'RUN_PAY',
  WAIT_EVENT_PUMP: 'WAIT_EVENT_PUMP',
  SEND_3DS_AND_WAIT_EVENT: 'SEND_3DS_AND_WAIT_EVENT',
  NOTIFY_SUCCESS_AND_CONFIRM_MERCHANT: 'NOTIFY_SUCCESS_AND_CONFIRM_MERCHANT',
  NOTIFY_FAILURE_STOP: 'NOTIFY_FAILURE_STOP',
  VERIFY_BEFORE_RETRY: 'VERIFY_BEFORE_RETRY',
  ASK_WALLET_SETUP: 'ASK_WALLET_SETUP',
  SURFACE_ERROR: 'SURFACE_ERROR',
});

function numericStatus(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function classifyPaymentResponse(data = {}) {
  const cpr = data?.channelPaymentResponse && typeof data.channelPaymentResponse === 'object'
    ? data.channelPaymentResponse
    : {};
  if (Number(cpr.flag3DS) === 1) {
    return {
      state: PaymentWorkflowState.THREE_DS_REQUIRED,
      action: PaymentWorkflowAction.SEND_3DS_AND_WAIT_EVENT,
      terminal: false,
      reason: '3ds_required',
    };
  }

  const status = numericStatus(cpr.status ?? data.status);
  if (status === 1) {
    return {
      state: PaymentWorkflowState.PAY_SYNC_SUCCEEDED,
      action: PaymentWorkflowAction.NOTIFY_SUCCESS_AND_CONFIRM_MERCHANT,
      terminal: true,
      reason: 'status_1_success',
    };
  }

  if ([3, 4, 6].includes(status)) {
    return {
      state: PaymentWorkflowState.PAY_SYNC_FAILED,
      action: PaymentWorkflowAction.NOTIFY_FAILURE_STOP,
      terminal: true,
      reason: `status_${status}_failure`,
    };
  }

  return {
    state: PaymentWorkflowState.PAY_SUBMITTED,
    action: PaymentWorkflowAction.WAIT_EVENT_PUMP,
    terminal: false,
    reason: status === null ? 'status_missing_wait_event' : `status_${status}_wait_event`,
  };
}

export function classifyPaymentError(error = {}) {
  const exitCode = Number(error.exitCode);
  if (exitCode === 6) {
    return {
      state: PaymentWorkflowState.PAY_UNKNOWN,
      action: PaymentWorkflowAction.VERIFY_BEFORE_RETRY,
      terminal: false,
      reason: 'exit_6_unknown',
    };
  }
  if (exitCode === 3 || exitCode === 4) {
    return {
      state: PaymentWorkflowState.WALLET_SETUP_REQUIRED,
      action: PaymentWorkflowAction.ASK_WALLET_SETUP,
      terminal: false,
      reason: `exit_${exitCode}_wallet_setup_required`,
    };
  }
  return {
    state: PaymentWorkflowState.CLI_ERROR,
    action: PaymentWorkflowAction.SURFACE_ERROR,
    terminal: true,
    reason: Number.isFinite(exitCode) ? `exit_${exitCode}_cli_error` : 'cli_error',
  };
}

export function formatPaymentFsmMarker(workflow, marker = 'PAYMENT_FSM') {
  return formatWorkflowMarker(marker, workflow);
}
