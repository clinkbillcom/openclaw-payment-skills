export const VIC_REGISTRATION_STATE_TTL_MS = 30 * 60 * 1000;

export function isVisaRegistrationSucceeded(method) {
  if (!method || typeof method !== 'object') return false;
  return method.visaRegistrationSucceeded === true ||
    method.paymentMethod?.visaRegistrationSucceeded === true;
}

export function getVicRegistrationStateKey(paymentInstrumentId) {
  return `vic_registration:${String(paymentInstrumentId || '').trim()}`;
}

function normalizePaymentFlowStates(cache) {
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return {};
  return cache.paymentFlowStates && typeof cache.paymentFlowStates === 'object' && !Array.isArray(cache.paymentFlowStates)
    ? cache.paymentFlowStates
    : {};
}

function isExpired(state, now) {
  const expireAt = Number(state?.expireAt || 0);
  return Number.isFinite(expireAt) && expireAt > 0 && now >= expireAt;
}

export function resolveVicRegistrationState({
  cache,
  paymentInstrumentId,
  cardDisplay = 'N/A',
  now = Date.now(),
  ttlMs = VIC_REGISTRATION_STATE_TTL_MS,
}) {
  const id = String(paymentInstrumentId || '').trim();
  if (!id) throw new Error('paymentInstrumentId is required');
  const key = getVicRegistrationStateKey(id);
  const existing = normalizePaymentFlowStates(cache)[key] || null;

  if (
    existing?.type === 'vic_registration' &&
    existing.paymentInstrumentId === id &&
    existing.status === 'pending_notified' &&
    !isExpired(existing, now)
  ) {
    return { key, state: existing, shouldNotify: false };
  }

  const state = {
    type: 'vic_registration',
    status: 'pending_notified',
    paymentInstrumentId: id,
    cardDisplay,
    notifiedAt: now,
    expireAt: now + ttlMs,
  };
  return { key, state, shouldNotify: true };
}

export function markVicRegistrationReady({
  cache,
  paymentInstrumentId,
  now = Date.now(),
}) {
  const id = String(paymentInstrumentId || '').trim();
  if (!id) throw new Error('paymentInstrumentId is required');
  const key = getVicRegistrationStateKey(id);
  const existing = normalizePaymentFlowStates(cache)[key] || {};
  const state = {
    ...existing,
    type: 'vic_registration',
    status: 'ready',
    paymentInstrumentId: id,
    readyAt: now,
  };
  return { key, state };
}
