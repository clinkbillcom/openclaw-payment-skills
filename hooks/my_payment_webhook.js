// my_payment_webhook.js
// OpenClaw webhook transform for Clink payment callbacks.
// Placed in ~/.openclaw/hooks/transforms/ at install time.
//
// Handles:
//   1. payment_method.added        — user finished binding a card on Clink hosted page
//   2. payment_method.default_change — user changed their default payment method
//   3. agent_order.created  — charge order created (intermediate)
//   4. agent_order.succeeded — payment succeeded
//   5. agent_order.failed   — payment or recharge failed
//   6. agent_refund.succeeded — refund succeeded
//   7. agent_refund.failed — refund failed
//   8. agent_refund.approved — refund approved
//   9. agent_refund.rejected — refund rejected
//   10. risk_rule.updated — risk rules changed

const fs = require('fs/promises');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const SKILL_DIR = typeof __AGENT_PAYMENT_SKILL_DIR__ === 'string'
  ? __AGENT_PAYMENT_SKILL_DIR__
  : path.resolve(__dirname, '..');
const CACHE_PATH = path.join(SKILL_DIR, 'clink.config.json');
const LOG_PATH = path.join(SKILL_DIR, 'error.log');
const LOCK_DIR = path.join(SKILL_DIR, 'locks');
const LOCK_STALE_MS = 120000;
const MESSAGE_SENDER = `${SKILL_DIR}/scripts/send-message.mjs`;
const {
  createNotification,
  renderNotificationMarkdown,
} = require(`${SKILL_DIR}/notification-utils.cjs`);

function normalizeCache(cache) {
  const normalized = cache && typeof cache === 'object' ? cache : {};
  if (!Array.isArray(normalized.paymentMethods)) normalized.paymentMethods = [];
  if (normalized.defaultPaymentMethodId === undefined) normalized.defaultPaymentMethodId = null;
  if (!normalized.orderCardStates || typeof normalized.orderCardStates !== 'object') {
    normalized.orderCardStates = {};
  }
  if (
    normalized.notifyDestination &&
    typeof normalized.notifyDestination === 'object' &&
    !Array.isArray(normalized.notifyDestination) &&
    typeof normalized.notifyDestination.channel === 'string' &&
    normalized.notifyDestination.channel.trim() &&
    normalized.notifyDestination.target &&
    typeof normalized.notifyDestination.target === 'object' &&
    !Array.isArray(normalized.notifyDestination.target) &&
    typeof normalized.notifyDestination.target.id === 'string' &&
    normalized.notifyDestination.target.id.trim() &&
    typeof normalized.notifyDestination.target.type === 'string' &&
    normalized.notifyDestination.target.type.trim()
  ) {
    normalized.notifyDestination = {
      channel: normalized.notifyDestination.channel.trim().toLowerCase(),
      target: {
        type: normalized.notifyDestination.target.type.trim(),
        id: normalized.notifyDestination.target.id.trim(),
      },
    };
  } else {
    normalized.notifyDestination = null;
  }
  if (
    normalized.pendingMerchantConfirmation &&
    typeof normalized.pendingMerchantConfirmation === 'object' &&
    !Array.isArray(normalized.pendingMerchantConfirmation)
  ) {
    const pending = normalized.pendingMerchantConfirmation;
    if (
      pending.notifyDestination &&
      typeof pending.notifyDestination === 'object' &&
      !Array.isArray(pending.notifyDestination) &&
      typeof pending.notifyDestination.channel === 'string' &&
      pending.notifyDestination.channel.trim() &&
      pending.notifyDestination.target &&
      typeof pending.notifyDestination.target === 'object' &&
      !Array.isArray(pending.notifyDestination.target) &&
      typeof pending.notifyDestination.target.id === 'string' &&
      pending.notifyDestination.target.id.trim() &&
      typeof pending.notifyDestination.target.type === 'string' &&
      pending.notifyDestination.target.type.trim()
    ) {
      pending.notifyDestination = {
        channel: pending.notifyDestination.channel.trim().toLowerCase(),
        target: {
          type: pending.notifyDestination.target.type.trim(),
          id: pending.notifyDestination.target.id.trim(),
        },
      };
    } else {
      pending.notifyDestination = null;
    }
  }
  return normalized;
}

// Read notify destination from cache (stored at install time).
let _notifyDestination = null;
try {
  const cache = normalizeCache(JSON.parse(require('fs').readFileSync(CACHE_PATH, 'utf8')));
  _notifyDestination = cache.notifyDestination || null;
} catch {}

async function logError(context, error) {
  const line = `[${new Date().toISOString()}] [${context}] ${error instanceof Error ? error.stack || error.message : String(error)}\n`;
  try {
    await fs.appendFile(LOG_PATH, line, 'utf8');
  } catch {}
}

async function logRequest(context, payload) {
  const entry = {
    time: new Date().toISOString(),
    context,
    payload,
  };
  try {
    await fs.appendFile(LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch {}
}

async function readCache() {
  try {
    const content = await fs.readFile(CACHE_PATH, 'utf8');
    return normalizeCache(JSON.parse(content));
  } catch (err) {
    await logError('readCache', err);
    return normalizeCache({ cachedAt: null });
  }
}

async function writeCache(cache) {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  const normalized = normalizeCache(cache);
  normalized.cachedAt = new Date().toISOString();
  await fs.writeFile(CACHE_PATH, JSON.stringify(normalized, null, 2), 'utf8');
}

function buildCardStateLockName(orderId, status, sessionId) {
  const parts = getOrderCardStateKeys(orderId, status, sessionId);
  if (parts.length === 0) return 'global';
  return parts[0].replace(/[^a-zA-Z0-9._-]+/g, '_');
}

async function withCardStateLock(orderId, status, sessionId, fn) {
  const lockName = buildCardStateLockName(orderId, status, sessionId);
  const lockPath = path.join(LOCK_DIR, `${lockName}.lock`);
  await fs.mkdir(LOCK_DIR, { recursive: true });

  const timeoutMs = 15000;
  const retryMs = 100;
  const startedAt = Date.now();

  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(String(process.pid), 'utf8');
        return await fn();
      } finally {
        await handle.close().catch(() => {});
        await fs.unlink(lockPath).catch(() => {});
      }
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        throw err;
      }
      try {
        const stats = await fs.stat(lockPath);
        if (Date.now() - stats.mtimeMs >= LOCK_STALE_MS) {
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch (statErr) {
        if (statErr?.code === 'ENOENT') {
          continue;
        }
        await logError('withCardStateLock/stat', statErr);
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for card-state lock: ${lockName}`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

function normalizeOrderStatus(status) {
  if (status === undefined || status === null || status === '') return null;
  return String(status).trim();
}

function getOrderCardStateKeys(orderId, status, sessionId) {
  const keys = [];
  const normalizedStatus = normalizeOrderStatus(status);
  if (typeof orderId === 'string' && orderId.trim() && normalizedStatus) {
    keys.push(`order_status:${orderId.trim()}:${normalizedStatus}`);
  }
  if (typeof orderId === 'string' && orderId.trim()) keys.push(`order:${orderId.trim()}`);
  if (typeof sessionId === 'string' && sessionId.trim()) keys.push(`session:${sessionId.trim()}`);
  return keys;
}

function getOrderCardState(cache, orderId, status, sessionId) {
  const normalized = normalizeCache(cache);
  for (const key of getOrderCardStateKeys(orderId, status, sessionId)) {
    if (normalized.orderCardStates[key]) {
      return normalized.orderCardStates[key];
    }
  }
  return null;
}

async function updateOrderCardState(orderId, status, sessionId, patch) {
  if (!Object.keys(patch || {}).length) return null;
  const cache = await readCache();
  const existing = getOrderCardState(cache, orderId, status, sessionId) || {};
  const nextState = {
    ...existing,
    ...patch,
    orderId: typeof orderId === 'string' && orderId.trim() ? orderId.trim() : existing.orderId || null,
    status: normalizeOrderStatus(status) || existing.status || null,
    sessionId: typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : existing.sessionId || null,
    updatedAt: new Date().toISOString(),
  };

  for (const key of getOrderCardStateKeys(nextState.orderId, nextState.status, nextState.sessionId)) {
    cache.orderCardStates[key] = nextState;
  }

  await writeCache(cache);
  return nextState;
}

async function clearPendingMerchantConfirmation() {
  try {
    const cache = await readCache();
    if (cache.pendingMerchantConfirmation) {
      delete cache.pendingMerchantConfirmation;
      await writeCache(cache);
    }
  } catch (err) {
    await logError('clearPendingMerchantConfirmation', err);
  }
}

function formatExecError(error) {
  if (!(error instanceof Error)) return String(error);
  const details = [];
  if (typeof error.message === 'string' && error.message) details.push(error.message);
  if (typeof error.stdout === 'string' && error.stdout.trim()) details.push(`stdout: ${error.stdout.trim()}`);
  if (typeof error.stderr === 'string' && error.stderr.trim()) details.push(`stderr: ${error.stderr.trim()}`);
  return details.join('\n') || error.message;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildNotificationPayload(notification, destination = _notifyDestination) {
  const channel = typeof destination?.channel === 'string' && destination.channel.trim()
    ? destination.channel.trim().toLowerCase()
    : '';
  const targetType = typeof destination?.target?.type === 'string' && destination.target.type.trim()
    ? destination.target.type.trim()
    : '';
  const targetId = typeof destination?.target?.id === 'string' && destination.target.id.trim()
    ? destination.target.id.trim()
    : '';
  if (!channel || !targetType || !targetId) {
    throw new Error('notify destination must include channel, target.type, and target.id');
  }
  const payload = {
    channel,
    target: {
      type: targetType,
      id: targetId,
    },
    deliver: true,
  };
  if (notification?.notification && typeof notification.notification === 'object' && !Array.isArray(notification.notification)) {
    payload.notification = JSON.parse(JSON.stringify(notification.notification));
  }
  if (notification?.card) {
    payload.card = notification.card;
  }
  if (typeof notification?.text === 'string' && notification.text.trim()) {
    payload.text = notification.text.trim();
  }
  return payload;
}

function sendNotificationDirect(notification, destination = _notifyDestination) {
  const payload = buildNotificationPayload(notification, destination);
  if (!payload.target?.id) {
    throw new Error('notify destination is missing; cannot send notification directly');
  }

  execFileSync(
    process.execPath,
    [MESSAGE_SENDER, '--payload', JSON.stringify(payload)],
    {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 15000,
    },
  );
}

function formatNotificationInstruction(summary, notifications, followUp = []) {
  const items = Array.isArray(notifications) ? notifications.filter(Boolean) : [notifications].filter(Boolean);
  const sections = [`[SYSTEM DIRECTIVE] ${summary}`];

  if (items.length > 0) {
    sections.push(
      items.length === 1
        ? 'Send the following user-facing message in Markdown:'
        : 'Send the following user-facing messages in Markdown, in order:',
    );
    sections.push(
      items
        .map((notification, index) => {
          const body = renderNotificationMarkdown(notification);
          if (items.length === 1) return body;
          return `Notification ${index + 1}:\n${body}`;
        })
        .join('\n\n'),
    );
  }

  const normalizedFollowUp = Array.isArray(followUp)
    ? followUp.map((line) => String(line || '').trim()).filter(Boolean)
    : [];
  if (normalizedFollowUp.length > 0) {
    sections.push(normalizedFollowUp.join('\n'));
  }

  return sections.join('\n\n');
}

async function sendCardsDirect(context, cards) {
  try {
    for (const card of cards) {
      sendNotificationDirect({ notification: card });
    }
    return true;
  } catch (err) {
    await logError(`${context} direct notification send`, formatExecError(err));
    return false;
  }
}

function buildMerchantPaymentHandoff(orderId, sessionId, context, triggerSource) {
  const notifyDestination = context?.notifyDestination || _notifyDestination || null;
  if (!notifyDestination?.channel || !notifyDestination?.target?.type || !notifyDestination?.target?.id) {
    throw new Error('merchant handoff requires notifyDestination.channel, notifyDestination.target.type, and notifyDestination.target.id');
  }
  const handoff = {
    order_id: orderId,
    trigger_source: triggerSource,
    channel: notifyDestination.channel,
  };
  if (typeof sessionId === 'string' && sessionId.trim()) {
    handoff.session_id = sessionId.trim();
  }
  handoff.notify_target = {
    type: notifyDestination.target.type,
    id: notifyDestination.target.id,
  };
  return handoff;
}

function buildMerchantConfirmArgs(orderId, sessionId, context, triggerSource) {
  const args = context && typeof context.args === 'object' && context.args
    ? JSON.parse(JSON.stringify(context.args))
    : {};
  args.payment_handoff = buildMerchantPaymentHandoff(orderId, sessionId, context, triggerSource);
  return args;
}

function buildMerchantConfirmCommand(context, args) {
  return [
    'npx',
    'mcporter',
    'call',
    context.server,
    context.tool,
    '--args',
    JSON.stringify(args),
  ].map(shellQuote).join(' ');
}

async function triggerMerchantConfirmation(context, args) {
  await logRequest('agent_order.succeeded.trigger_merchant_confirmation', { context, args });
  try {
    const cmd = buildMerchantConfirmCommand(context, args);
    const child = spawn(cmd, [], {
      detached: true,
      stdio: 'ignore',
      shell: true,
    });
    child.on('error', (err) => {
      logError('agent_order.succeeded trigger_merchant_confirmation spawn', err);
    });
    child.unref();
    return true;
  } catch (err) {
    await logError('agent_order.succeeded trigger_merchant_confirmation', err);
    return false;
  }
}

function toCachedPaymentMethod(data, paymentInstrumentId) {
  return {
    paymentInstrumentId,
    paymentMethodType: data.paymentMethodType || data.paymentInstrumentType || data.payment_method_type || data.payment_instrument_type || null,
    cardBrand: data.cardBrand || data.cardScheme || data.card_brand || data.card_scheme || null,
    cardLast4: data.cardLast4 || data.cardLastFour || data.card_last4 || data.card_last_four || null,
    issuerBank: data.issuerBank || null,
    walletAccountTag: data.walletAccountTag || data.wallet?.accountTag || null,
    isDefault: data.isDefault ?? false,
    isDisabled: data.isDisabled ?? false,
    status: data.status || ((data.isDisabled ?? false) ? 'disabled' : 'active'),
  };
}

function getRefundMeta(data) {
  return {
    amt: formatRefundAmount(data),
    paymentInstrumentId: data.payment_instrument_id || data.paymentInstrumentId || null,
    orderId: data.order_id || data.orderId || "N/A",
    refundId: data.refund_id || data.refundId || "N/A",
    customerId: data.customer_id || data.customerId || "N/A",
  };
}

module.exports = async function(ctx) {
  const { type, data } = ctx.payload || {};

  if (!type || !data) {
    return { kind: "wake", text: "[Clink Webhook] Received unknown payload with no type or data." };
  }

  switch (type) {

    // ─── Card binding completed ───
    case "payment_method.added": {
      await logRequest('payment_method.added', data);
      const cachedMethod = toCachedPaymentMethod(data, data.paymentInstrumentId);
      const cardDisplay = formatCachedCard(cachedMethod);
      const email = data.customerEmail || "N/A";
      let shouldSendCompleteCard = true;

      // Update cache
      try {
        const cache = await readCache();
        const hadExistingPaymentMethod = Array.isArray(cache.paymentMethods) && cache.paymentMethods.length > 0;
        shouldSendCompleteCard = !cache.initialized && !hadExistingPaymentMethod;
        const existing = cache.paymentMethods.findIndex(m => m.paymentInstrumentId === data.paymentInstrumentId);
        if (existing >= 0) {
          cache.paymentMethods[existing] = cachedMethod;
        } else {
          cache.paymentMethods.push(cachedMethod);
        }
        if (data.isDefault) {
          cache.paymentMethods.forEach(m => { m.isDefault = m.paymentInstrumentId === data.paymentInstrumentId; });
          cache.defaultPaymentMethodId = data.paymentInstrumentId;
        }
        if (!cache.initialized) cache.initialized = true;
        if (data.customerEmail && !cache.email) cache.email = data.customerEmail;
        await writeCache(cache);
      } catch (err) { await logError('payment_method.added cache update', err); }

      const successCard = createNotification({
        title: "✅ 支付方式绑定成功",
        theme: "green",
        details: [
          ["绑定支付方式", cardDisplay],
          ["邮箱", email],
        ],
      });

      const completeCard = createNotification({
        title: "🎉 Clink 初始化完成！",
        theme: "green",
        details: [
          ["绑定支付方式", `${cardDisplay} ✓`],
          ["规则状态", "已生效"],
        ],
        paragraphs: ["你现在可以部署自动充值任务。风控规则可选，可随时通过「查看风控规则」配置。如需修改支付方式，请告知我。"],
      });

      const cardsToSend = shouldSendCompleteCard ? [successCard, completeCard] : [successCard];
      const sent = await sendCardsDirect('payment_method.added', cardsToSend);
      if (sent) {
        return null;
      }

      return {
        kind: "agent",
        name: "Clink",
        message: `[Clink Webhook] 绑卡成功回调。

事件: payment_method.added
客户邮箱: ${email}
客户 ID: ${data.customerId || "N/A"}
支付方式 ID: ${data.paymentInstrumentId || "N/A"}
卡片: ${cardDisplay}
状态: ${data.status || "active"}

${formatNotificationInstruction(
  `The user has successfully bound a new payment method.${shouldSendCompleteCard ? " Initialization is now complete." : ""}`,
  shouldSendCompleteCard ? [successCard, completeCard] : successCard,
  [
    `After sending ${shouldSendCompleteCard ? "both notifications" : "the notification"}, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.`,
  ],
)}`
      };
    }

    // ─── Default payment method changed ───
    case "payment_method.default_change": {
      await logRequest('payment_method.default_change', data);
      const cachedMethod = toCachedPaymentMethod(data, data.paymentInstrumentId);
      const cardDisplay = formatCachedCard(cachedMethod);

      // Update cache
      try {
        const cache = await readCache();
        const existing = cache.paymentMethods.findIndex(m => m.paymentInstrumentId === data.paymentInstrumentId);
        if (existing >= 0) {
          cache.paymentMethods[existing] = cachedMethod;
        } else {
          cache.paymentMethods.push(cachedMethod);
        }
        cache.paymentMethods.forEach(m => { m.isDefault = m.paymentInstrumentId === data.paymentInstrumentId; });
        cache.defaultPaymentMethodId = data.paymentInstrumentId;
        await writeCache(cache);
      } catch (err) { await logError('payment_method.default_change cache update', err); }

      const updateCard = createNotification({
        title: "✅ 默认支付方式已更新",
        theme: "green",
        details: [
          ["当前默认卡", cardDisplay],
          ["支付方式 ID", data.paymentInstrumentId || "N/A"],
        ],
        paragraphs: ["后续付款将优先使用这张卡。如需继续之前失败的支付，请直接告诉我重新发起。"],
      });

      const sent = await sendCardsDirect('payment_method.default_change', [updateCard]);
      if (sent) {
        return null;
      }

      return {
        kind: "agent",
        name: "Clink",
        message: `[Clink Webhook] 默认支付方式已变更。

事件: payment_method.default_change
客户 ID: ${data.customerId || "N/A"}
新默认卡: ${cardDisplay}
支付方式 ID: ${data.paymentInstrumentId || "N/A"}

${formatNotificationInstruction(
  'Direct webhook notification delivery failed.',
  updateCard,
  ['After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.'],
)}`
      };
    }

    // ─── Order created (intermediate state) ───
    case "agent_order.created": {
      return null;
    }

    // ─── Payment succeeded ───
    case "agent_order.succeeded": {
      const amt = formatAmount(data);
      const cache = await readCache();
      const paymentInstrumentId = data.paymentInstrumentId || data.paymentMethod?.paymentInstrumentId || null;
      const card = formatCard(paymentInstrumentId, data, cache);
      const rawOrderId = data.orderId || null;
      const orderId = rawOrderId || "N/A";
      const customerId = data.customerId || "N/A";
      const sessionId = data.sessionId || data.session_id || null;
      const sessionDisplay = sessionId || "无";
      const pendingCard = createNotification({
        title: "✅ 支付成功",
        theme: "green",
        details: [
          ["支付金额", amt],
          ["扣款方式", card],
          ["Clink 订单号", orderId],
        ],
        paragraphs: ["已完成扣款，正在等待商户确认到账…"],
      });

      const merchantContext = cache.pendingMerchantConfirmation || null;
      const merchantArgs = merchantContext
        ? buildMerchantConfirmArgs(orderId, data.sessionId || data.session_id || null, merchantContext, 'webhook')
        : null;

      const successSendResult = await withCardStateLock(rawOrderId, 1, sessionId, async () => {
        const latestCache = await readCache();
        const latestState = getOrderCardState(latestCache, rawOrderId, 1, sessionId);
        if (!latestState?.paymentSuccessCardSent) {
          const sent = await sendCardsDirect('agent_order.succeeded', [pendingCard]);
          if (!sent) {
            return 'send_failed';
          }
          await updateOrderCardState(rawOrderId, 1, sessionId, {
            paymentSuccessCardSent: true,
            paymentSuccessCardSentAt: new Date().toISOString(),
            paymentSuccessCardSource: 'webhook',
          });
        }
        if (latestState?.merchantConfirmationTriggered) {
          return 'already_completed';
        }

        const effectiveMerchantContext = latestCache.pendingMerchantConfirmation || merchantContext;
        const effectiveMerchantArgs = effectiveMerchantContext
          ? buildMerchantConfirmArgs(orderId, data.sessionId || data.session_id || null, effectiveMerchantContext, 'webhook')
          : null;
        if (!effectiveMerchantContext) {
          return 'completed';
        }
        const triggered = await triggerMerchantConfirmation(effectiveMerchantContext, effectiveMerchantArgs);
        if (!triggered) {
          return {
            kind: 'trigger_failed',
            merchantContext: effectiveMerchantContext,
            merchantArgs: effectiveMerchantArgs,
          };
        }
        await updateOrderCardState(rawOrderId, 1, sessionId, {
          merchantConfirmationTriggered: true,
          merchantConfirmationTriggeredAt: new Date().toISOString(),
          merchantConfirmationTriggerSource: 'webhook',
        });
        await clearPendingMerchantConfirmation();
        return 'completed';
      });

      if (successSendResult === 'already_completed' || successSendResult === 'completed') {
        return null;
      }

      if (successSendResult?.kind === 'trigger_failed') {
        if (!successSendResult.merchantContext) {
          return null;
        }
        return {
          kind: "wake",
          mode: "now",
          text: `[Clink Webhook] 支付成功回调（扣款完成，等待商户到账确认）。

事件: agent_order.succeeded
订单 ID: ${orderId}
金额: ${amt}
支付方式: ${card}
客户 ID: ${customerId}
Session ID: ${sessionDisplay}

[SYSTEM DIRECTIVE] The payment success notification was already sent earlier. Your NEXT action MUST be notifying the pending merchant skill to confirm recharge with this exact command:
\`\`\`
${buildMerchantConfirmCommand(successSendResult.merchantContext, successSendResult.merchantArgs)}
\`\`\`

Rules:
1. Do NOT send the payment success notification again.
2. Do NOT ask the user any question.
          3. After the merchant confirms recharge, let the merchant skill continue its own success/failure and task-resume flow.`
        };
      }

      if (!merchantContext) {
      return {
        kind: "agent",
        name: "Clink",
        message: `[Clink Webhook] 支付成功回调（扣款完成，等待商户到账确认）。

事件: agent_order.succeeded
订单 ID: ${orderId}
金额: ${amt}
支付方式: ${card}
客户 ID: ${customerId}
Session ID: ${sessionDisplay}

${formatNotificationInstruction(
  'Direct webhook notification delivery failed.',
  pendingCard,
  ['After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.'],
)}`
      };
      }

      return {
        kind: "agent",
        name: "Clink",
        message: `[Clink Webhook] 支付成功回调（扣款完成，等待商户到账确认）。

事件: agent_order.succeeded
订单 ID: ${orderId}
金额: ${amt}
支付方式: ${card}
客户 ID: ${customerId}
Session ID: ${sessionDisplay}

[SYSTEM DIRECTIVE] Direct webhook notification delivery failed. Do these steps in order:
1. Send the following user-facing message in Markdown:

${renderNotificationMarkdown(pendingCard)}

2. Immediately notify the pending merchant skill with this exact command:
\`\`\`
${buildMerchantConfirmCommand(merchantContext, merchantArgs)}
\`\`\`

After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.`
      };
    }

    // ─── Payment failed ───
    case "agent_order.failed": {
      await clearPendingMerchantConfirmation();
      const amt = formatAmount(data);
      const rawOrderId = data.orderId || null;
      const orderId = rawOrderId || "N/A";
      const customerId = data.customerId || "N/A";
      const sessionId = data.sessionId || data.session_id || null;
      const status = data.status || "failed";
      const normalizedStatus = normalizeOrderStatus(status);
      const failureCode = data.failureCode || "";
      const failureReason = data.failureMessage || failureCode || "支付处理异常";
      const isCharged = status === "charged" || status === "paid";
      const title = isCharged ? "❌ 支付异常" : "❌ 支付失败";
      const failCard = createNotification({
        title,
        theme: "red",
        details: [
          ["支付金额", amt],
          ["支付状态", isCharged ? "已扣款，等待人工处理" : "扣款失败"],
          ["失败原因", failureReason],
          ["订单号", orderId],
        ],
        paragraphs: [
          isCharged
            ? "支付网关侧已记录扣款异常，请携带以上订单号联系商户支持继续处理。"
            : "银行卡扣款失败，请检查卡片状态或更换支付方式后重试。如需更换支付方式，请告知我。",
        ],
      });
      const failureSendResult = await withCardStateLock(rawOrderId, normalizedStatus, sessionId, async () => {
        const latestCache = await readCache();
        const latestState = getOrderCardState(latestCache, rawOrderId, normalizedStatus, sessionId);
        if (latestState?.paymentFailureCardSent) {
          return 'already_sent';
        }
        const sent = await sendCardsDirect('agent_order.failed', [failCard]);
        if (!sent) {
          return 'send_failed';
        }
        await updateOrderCardState(rawOrderId, normalizedStatus, sessionId, {
          paymentFailureCardSent: true,
          paymentFailureCardSentAt: new Date().toISOString(),
          paymentFailureCardSource: 'webhook',
          paymentFailureKind: `${failureCode}${data.declinedCode || ''}`.includes('risk') ? 'risk_reject' : 'payment_failed',
        });
        return 'sent';
      });

      if (failureSendResult === 'already_sent') {
        return null;
      }

      if (failureSendResult === 'sent') {
        return null;
      }

      return {
        kind: "agent",
        name: "Clink",
        message: `[Clink Webhook] 支付失败回调。

事件: agent_order.failed
订单 ID: ${orderId}
金额: ${amt}
状态: ${status}
失败代码: ${failureCode || "N/A"}
失败原因: ${failureReason}
客户 ID: ${customerId}

${formatNotificationInstruction(
  'Direct webhook notification delivery failed.',
  failCard,
  ['After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.'],
)}`
      };
    }

    // ─── Refund succeeded ───
    case "agent_refund.succeeded":
    case "agent_refund.approved": {
      const cache = await readCache();
      const { amt, paymentInstrumentId, orderId, refundId, customerId } = getRefundMeta(data);
      const card = formatCard(paymentInstrumentId, data, cache);
      const eventName = type;
      const isApproved = type === "agent_refund.approved";

      const refundCard = createNotification({
        title: isApproved ? "✅ 退款已通过" : "✅ 退款成功",
        theme: "green",
        details: [
          ["退款金额", amt],
          ["原订单号", orderId],
          ["退款单号", refundId],
          ["退款方式", card],
          ["退款状态", "成功"],
        ],
        paragraphs: [
          isApproved
            ? "退款申请已审核通过，资金将按发卡行或支付渠道的到账时效原路退回。"
            : "退款申请已处理成功，资金将按发卡行或支付渠道的到账时效原路退回。",
        ],
      });

      const sent = await sendCardsDirect(eventName, [refundCard]);
      if (sent) {
        return null;
      }

      return {
        kind: "agent",
        name: "Clink",
        message: `[Clink Webhook] ${isApproved ? "退款审核通过回调" : "退款成功回调"}。

事件: ${eventName}
退款单号: ${refundId}
原订单号: ${orderId}
退款金额: ${amt}
退款方式: ${card}
客户 ID: ${customerId}

${formatNotificationInstruction(
  'Direct webhook notification delivery failed.',
  refundCard,
  ['After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.'],
)}`
      };
    }

    // ─── Refund failed ───
    case "agent_refund.failed":
    case "agent_refund.rejected": {
      const cache = await readCache();
      const { amt, paymentInstrumentId, orderId, refundId, customerId } = getRefundMeta(data);
      const card = formatCard(paymentInstrumentId, data, cache);
      const failureReason =
        data.failure_message || data.failureMessage || data.failure_code || data.failureCode || "退款处理失败";
      const eventName = type;
      const isRejected = type === "agent_refund.rejected";

      const refundFailCard = createNotification({
        title: isRejected ? "❌ 退款已拒绝" : "❌ 退款失败",
        theme: "red",
        details: [
          ["退款金额", amt],
          ["原订单号", orderId],
          ["退款单号", refundId],
          ["退款方式", card],
          ["失败原因", failureReason],
        ],
        paragraphs: [
          isRejected
            ? "退款申请未通过审核，请根据失败原因调整后再试或联系 Clink 支持排查。"
            : "退款申请未能成功处理，请稍后重试或联系 Clink 支持排查。",
        ],
      });

      const sent = await sendCardsDirect(eventName, [refundFailCard]);
      if (sent) {
        return null;
      }

      return {
        kind: "agent",
        name: "Clink",
        message: `[Clink Webhook] ${isRejected ? "退款审核拒绝回调" : "退款失败回调"}。

事件: ${eventName}
退款单号: ${refundId}
原订单号: ${orderId}
退款金额: ${amt}
退款方式: ${card}
失败原因: ${failureReason}
客户 ID: ${customerId}

${formatNotificationInstruction(
  'Direct webhook notification delivery failed.',
  refundFailCard,
  ['After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.'],
)}`
      };
    }

    // ─── Risk rules updated ───
    case "risk_rule.updated": {
      try {
        const cache = await readCache();
        cache.riskRules = data;
        await writeCache(cache);
      } catch (err) { await logError('risk_rule.updated cache update', err); }

      const riskCard = createNotification({
        title: "🛡️ 风控规则已生效",
        theme: "green",
        details: [
          ["单次上限", data.singleRechargeLimit ?? "N/A"],
          ["每日总额", data.dailyTotalLimit ?? "N/A"],
          ["每日次数", `${data.dailyMaxCount ?? "N/A"} 次`],
          ["充值间隔", data.rechargeInterval ?? "N/A"],
        ],
        paragraphs: ["风控规则已同步生效，后续充值将按此规则执行。"],
      });

      const sent = await sendCardsDirect('risk_rule.updated', [riskCard]);
      if (sent) {
        return null;
      }

      return {
        kind: "agent",
        name: "Clink",
        message: `[Clink Webhook] 风控规则已更新。

事件: risk_rule.updated
单次充值上限: ${data.singleRechargeLimit ?? "N/A"}
每日总额上限: ${data.dailyTotalLimit ?? "N/A"}
每日最大次数: ${data.dailyMaxCount ?? "N/A"}
充值间隔: ${data.rechargeInterval ?? "N/A"}
手动审批阈值: ${data.manualApprovalThreshold ?? "N/A"}
更新时间: ${data.updatedAt ?? "N/A"}

${formatNotificationInstruction(
  'Risk rules have been updated and saved to local cache. Direct webhook notification delivery failed.',
  riskCard,
  ['After sending the notification, you may add a brief natural-language reply if helpful, but do not repeat the notification contents.'],
)}`
      };
    }

    // ─── Unknown event type ───
    default: {
      await logError('unknown webhook event', `[${type}] ${JSON.stringify(data).slice(0, 1000)}`);
      return null;
    }
  }
}

// ─── Helpers ───

function formatAmount(data) {
  const currency = data.currency || data.paymentCurrency || "";
  const symbol = currency === "USD" ? "$" : currency;
  const amount = data.amount ?? data.amountTotal ?? data.amountSubtotal ?? "N/A";
  const parsed = Number(amount);
  return amount === "N/A" || !Number.isFinite(parsed) ? "N/A" : `${symbol}${parsed.toFixed(2)}`;
}

function formatRefundAmount(data) {
  const currency = data.refund_currency || data.refundCurrency || "";
  const symbol = currency === "USD" ? "$" : currency;
  const amount = data.refund_amount ?? data.refundAmount ?? "N/A";
  const parsed = Number(amount);
  return amount === "N/A" || !Number.isFinite(parsed) ? "N/A" : `${symbol}${parsed.toFixed(2)}`;
}

function formatCachedCard(method) {
  const brand = method.cardBrand || method.paymentMethodType || "Unknow";
  if (method.walletAccountTag) {
    return `${String(brand).toUpperCase()} ${method.walletAccountTag}`;
  }
  const last4 = method.cardLast4 || "****";
  return `${String(brand).toUpperCase()} ••••${last4}`;
}

function formatCard(paymentInstrumentId, data, cache) {
  if (Array.isArray(cache?.paymentMethods)) {
    const matchedMethod = cache.paymentMethods.find(
      (method) => method.paymentInstrumentId === paymentInstrumentId,
    );
    if (matchedMethod) {
      return formatCachedCard(matchedMethod);
    }
  }

  const walletAccountTag = data.walletAccountTag || data.wallet?.accountTag || null;
  if (data.cardBrand || data.cardLast4 || walletAccountTag) {
    const brand = data.cardBrand || data.cardScheme || data.paymentMethodType || data.paymentInstrumentType || "Unknow";
    if (walletAccountTag) {
      return `${String(brand).toUpperCase()} ${walletAccountTag}`;
    }
    return `${String(brand).toUpperCase()} ••••${data.cardLast4 || data.cardLastFour || "****"}`;
  }

  if (data.paymentMethod) {
    const pm = data.paymentMethod;
    if (pm.cardBrand || pm.cardLast4 || pm.walletAccountTag || pm.wallet?.accountTag) {
      return formatCachedCard({
        paymentMethodType: pm.paymentMethodType || pm.paymentInstrumentType,
        cardBrand: pm.cardBrand || pm.cardScheme,
        cardLast4: pm.cardLast4 || pm.cardLastFour,
        walletAccountTag: pm.walletAccountTag || pm.wallet?.accountTag,
      });
    }
    return `${pm.paymentMethodType || pm.paymentInstrumentType || "Unknow"} ${paymentInstrumentId}`.trim();
  }
  return "N/A";
}
