export function isTerminalAsyncOperationStatus(status) {
  return status === 'succeeded' || status === 'failed' || status === 'timeout' || status === 'cancelled';
}

export function isAsyncOperationExpired(operation, now = Date.now()) {
  const expireAt = Number(operation?.expireAt || 0);
  return Number.isFinite(expireAt) && expireAt > 0 && now >= expireAt;
}

export function getReusableAsyncOperation(cache, type, now = Date.now(), details = {}) {
  const requestedPaymentInstrumentId = type === 'vic_registration' && typeof details?.paymentInstrumentId === 'string'
    ? details.paymentInstrumentId.trim()
    : '';
  const operations = Object.values(cache?.asyncOperations || {});
  for (const operation of operations) {
    if (operation?.type !== type) continue;
    if (isTerminalAsyncOperationStatus(operation.status)) continue;
    if (isAsyncOperationExpired(operation, now)) continue;
    if (requestedPaymentInstrumentId) {
      const operationPaymentInstrumentId = typeof operation.paymentInstrumentId === 'string'
        ? operation.paymentInstrumentId.trim()
        : '';
      if (operationPaymentInstrumentId !== requestedPaymentInstrumentId) continue;
    }
    return operation;
  }
  return null;
}

export function buildDirectSendDirective({ summary, pollFallback, pollFallbackLines, webhookWaitMessage, suffix }) {
  const hasScheduledPollFallback = Boolean(pollFallback?.required && pollFallback?.operation);
  const directive = hasScheduledPollFallback ? 'DIRECT_SEND_POLL_REQUIRED' : 'DIRECT_SEND';
  const waitContent = pollFallback?.required
    ? pollFallbackLines.join('\n')
    : webhookWaitMessage;
  let result = `[SYSTEM DIRECTIVE] ${directive}: ${summary}\nThe notification has been sent. Do NOT send another card.\n${waitContent}`;
  if (suffix) result += '\n\n' + suffix;
  return result;
}

export function buildPollFallbackTimeoutMessageRequest(type) {
  if (type === 'update_rule') {
    return {
      messageKey: 'poll_fallback.timeout',
      vars: {
        flowLabel: 'risk rule update',
        referenceId: 'N/A',
        expectedEvent: 'risk_rule.updated',
      },
    };
  }
  if (type === 'change_card') {
    return {
      messageKey: 'poll_fallback.timeout',
      vars: {
        flowLabel: 'payment method change',
        referenceId: 'N/A',
        expectedEvent: 'payment_method.added',
      },
    };
  }
  if (type === 'vic_registration') {
    return {
      messageKey: 'poll_fallback.timeout',
      vars: {
        flowLabel: 'VIC registration',
        referenceId: 'N/A',
        expectedEvent: 'payment_method.added/update',
      },
    };
  }
  return {
    messageKey: 'poll_fallback.timeout',
    vars: {
      flowLabel: 'payment method setup',
      referenceId: 'N/A',
      expectedEvent: 'payment_method.added',
    },
  };
}
