export const VIC_REGISTRATION_STATE_TTL_MS = 30 * 60 * 1000;

export function isVisaRegistrationSucceeded(method) {
  if (!method || typeof method !== 'object') return false;
  return method.visaRegistrationSucceeded === true ||
    method.paymentMethod?.visaRegistrationSucceeded === true;
}

function normalizeNotifyDestinationKey(notifyDestination) {
  if (!notifyDestination || typeof notifyDestination !== 'object' || Array.isArray(notifyDestination)) {
    return 'no_destination';
  }
  const channel = typeof notifyDestination.channel === 'string' && notifyDestination.channel.trim()
    ? notifyDestination.channel.trim().toLowerCase()
    : 'unknown_channel';
  const targetType = typeof notifyDestination?.target?.type === 'string' && notifyDestination.target.type.trim()
    ? notifyDestination.target.type.trim()
    : 'unknown_target_type';
  const targetId = typeof notifyDestination?.target?.id === 'string' && notifyDestination.target.id.trim()
    ? notifyDestination.target.id.trim()
    : 'unknown_target_id';
  return [channel, targetType, targetId].map((part) => encodeURIComponent(part)).join(':');
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

export function getVicRegistrationStateKey(paymentInstrumentId, notifyDestination = null) {
  return `vic_registration:${String(paymentInstrumentId || '').trim()}:${normalizeNotifyDestinationKey(notifyDestination)}`;
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
  notifyDestination = null,
  now = Date.now(),
  ttlMs = VIC_REGISTRATION_STATE_TTL_MS,
}) {
  const id = String(paymentInstrumentId || '').trim();
  if (!id) throw new Error('paymentInstrumentId is required');
  const key = getVicRegistrationStateKey(id, notifyDestination);
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
    notifyDestination: notifyDestination ? cloneJsonValue(notifyDestination) : null,
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
  const states = {};
  const existingStates = normalizePaymentFlowStates(cache);
  for (const [key, existing] of Object.entries(existingStates)) {
    if (existing?.type !== 'vic_registration') continue;
    if (existing.paymentInstrumentId !== id) continue;
    states[key] = {
      ...existing,
      type: 'vic_registration',
      status: 'ready',
      paymentInstrumentId: id,
      readyAt: now,
    };
  }

  if (Object.keys(states).length === 0) {
    const key = getVicRegistrationStateKey(id, null);
    states[key] = {
      type: 'vic_registration',
      status: 'ready',
      paymentInstrumentId: id,
      notifyDestination: null,
      readyAt: now,
    };
  }

  return { states };
}
