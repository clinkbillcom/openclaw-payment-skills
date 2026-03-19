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
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SKILL_DIR = path.join(os.homedir(), '.openclaw', 'workspace', 'skills', 'agent-payment-skills');
const CACHE_PATH = path.join(SKILL_DIR, 'clink.config.json');
const LOG_PATH = path.join(SKILL_DIR, 'error.log');
const CARD_SENDER = `${SKILL_DIR}/scripts/send-feishu-card.mjs`;

// Read notify target from cache (stored at install time by install.mjs).
// Falls back to {current_feishu_chat_id} placeholder if not found.
let _notifyTarget = null;
let _notifyFlag = '--chat-id';
try {
  const cache = JSON.parse(require('fs').readFileSync(CACHE_PATH, 'utf8'));
  if (cache.notifyTargetId) {
    _notifyTarget = cache.notifyTargetId;
    _notifyFlag = cache.notifyTargetType === 'open_id' ? '--open-id' : '--chat-id';
  }
} catch {}

async function logError(context, error) {
  const line = `[${new Date().toISOString()}] [${context}] ${error instanceof Error ? error.stack || error.message : String(error)}\n`;
  try {
    await fs.appendFile(LOG_PATH, line, 'utf8');
  } catch {}
}

async function readCache() {
  try {
    const content = await fs.readFile(CACHE_PATH, 'utf8');
    const cache = JSON.parse(content);
    if (!Array.isArray(cache.paymentMethods)) cache.paymentMethods = [];
    if (cache.defaultPaymentMethodId === undefined) cache.defaultPaymentMethodId = null;
    return cache;
  } catch (err) {
    await logError('readCache', err);
    return { paymentMethods: [], defaultPaymentMethodId: null, cachedAt: null };
  }
}

async function writeCache(cache) {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  cache.cachedAt = new Date().toISOString();
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

// Build an exec directive that sends a v2 Feishu card via send-feishu-card.mjs.
// Uses the stored notify_target_id (resolved at install time) so the exec command
// contains the actual chat/open ID — no unresolvable {placeholder} at runtime.
// Note: JSON.stringify produces double-quoted strings, so no single-quote collision
// with the outer shell wrapping. HTML attributes must use double quotes (color="green")
// not single quotes to avoid breaking the shell command.
function cardExec(cardObj) {
  const json = JSON.stringify(cardObj);
  const target = _notifyTarget
    ? `${_notifyFlag} ${_notifyTarget}`
    : `--chat-id {current_feishu_chat_id}`;
  return `exec: node ${CARD_SENDER} --json '${json}' ${target}`;
}

function formatExecError(error) {
  if (!(error instanceof Error)) return String(error);
  const details = [];
  if (typeof error.message === 'string' && error.message) details.push(error.message);
  if (typeof error.stdout === 'string' && error.stdout.trim()) details.push(`stdout: ${error.stdout.trim()}`);
  if (typeof error.stderr === 'string' && error.stderr.trim()) details.push(`stderr: ${error.stderr.trim()}`);
  return details.join('\n') || error.message;
}

function sendCardDirect(cardObj) {
  if (!_notifyTarget) {
    throw new Error('notify_target_id is missing; cannot send card directly');
  }

  execFileSync(
    process.execPath,
    [CARD_SENDER, '--json', JSON.stringify(cardObj), _notifyFlag, _notifyTarget],
    {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 15000,
    },
  );
}

async function sendCardsDirect(context, cards) {
  try {
    for (const card of cards) {
      sendCardDirect(card);
    }
    return true;
  } catch (err) {
    await logError(`${context} direct card send`, formatExecError(err));
    return false;
  }
}

function buildRechargeStatusArgs(orderId, sessionId) {
  const args = { order_id: orderId };
  if (typeof sessionId === 'string' && sessionId.trim()) {
    args.session_id = sessionId.trim();
  }
  if (_notifyTarget) {
    if (_notifyFlag === '--open-id') {
      args.open_id = _notifyTarget;
    } else {
      args.chat_id = _notifyTarget;
    }
  }
  return JSON.stringify(args);
}

function toCachedPaymentMethod(data, paymentInstrumentId) {
  return {
    paymentInstrumentId,
    paymentMethodType: data.paymentMethodType,
    cardScheme: data.cardBrand,
    cardLastFour: data.cardLast4,
    issuerBank: data.issuerBank || null,
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
      const cardDisplay = `${(data.cardBrand || "CARD").toUpperCase()} ••••${data.cardLast4 || "????"}`;
      const email = data.customerEmail || "N/A";
      const cachedMethod = toCachedPaymentMethod(data, data.paymentInstrumentId);

      // Update cache
      try {
        const cache = await readCache();
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

      const successCard = {
        schema: "2.0",
        header: { title: { content: "✅ 支付方式绑定成功", tag: "plain_text" }, template: "green" },
        body: { elements: [
          { tag: "markdown", content: `**绑定支付方式**　<font color="green">${cardDisplay}</font>\n**邮箱**　　　　　${email}` }
        ]}
      };

      const completeCard = {
        schema: "2.0",
        header: { title: { content: "🎉 Clink 初始化完成！", tag: "plain_text" }, template: "green" },
        body: { elements: [
          { tag: "markdown", content: `**绑定支付方式**　<font color="green">${cardDisplay} ✓</font>\n**规则状态**　　　<font color="green">已生效</font>` },
          { tag: "hr" },
          { tag: "markdown", content: "你现在可以部署自动充值任务。风控规则可选，可随时通过「查看风控规则」配置。如需修改支付方式，请告知我。" }
        ]}
      };

      const sent = await sendCardsDirect('payment_method.added', [successCard, completeCard]);
      if (sent) {
        return null;
      }

      const exec1 = cardExec(successCard);
      const exec2 = cardExec(completeCard);

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

[SYSTEM DIRECTIVE] The user has successfully bound a new payment method. Initialization is now complete.
YOU MUST send TWO Feishu Interactive Cards in order:

Card 1:
${exec1}

Card 2:
${exec2}

After sending both cards, reply NO_REPLY and nothing else.`
      };
    }

    // ─── Default payment method changed ───
    case "payment_method.default_change": {
      const cardDisplay = `${(data.cardBrand || "CARD").toUpperCase()} ••••${data.cardLast4 || "????"}`;
      const cachedMethod = toCachedPaymentMethod(data, data.paymentInstrumentId);

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

      const updateCard = {
        schema: "2.0",
        header: { title: { content: "✅ 默认支付方式已更新", tag: "plain_text" }, template: "green" },
        body: { elements: [
          { tag: "markdown", content: `**当前默认卡**　<font color="green">${cardDisplay}</font>\n**支付方式 ID**　${data.paymentInstrumentId || "N/A"}` },
          { tag: "hr" },
          { tag: "markdown", content: "后续付款将优先使用这张卡。如需继续之前失败的支付，请直接告诉我重新发起。" }
        ]}
      };

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

[SYSTEM DIRECTIVE] Direct webhook card delivery failed. YOU MUST immediately send this Feishu Interactive Card:
${cardExec(updateCard)}

After sending the card, reply NO_REPLY and nothing else.`
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
      const orderId = data.orderId || "N/A";
      const customerId = data.customerId || "N/A";
      const sessionId = data.sessionId || "无";

      const pendingCard = {
        schema: "2.0",
        header: { title: { content: "✅ 支付成功", tag: "plain_text" }, template: "green" },
        body: { elements: [
          { tag: "markdown", content: `**支付金额**　${amt}\n**扣款方式**　${card}` },
          { tag: "hr" },
          { tag: "markdown", content: "已完成扣款，正在等待商户确认到账…" }
        ]}
      };

      const sent = await sendCardsDirect('agent_order.succeeded', [pendingCard]);
      const step1 = sent
        ? `Step 1: The webhook already sent the "✅ 支付成功" Feishu card directly to the user. Do NOT send it again.`
        : `Step 1: Direct webhook card delivery failed. Send this Feishu Interactive Card to the user:\n${cardExec(pendingCard)}`;
      const rechargeStatusArgs = buildRechargeStatusArgs(orderId, data.sessionId || data.session_id || null);

      return {
        kind: "wake",
        mode: "now",
        text: `[Clink Webhook] 支付成功回调（扣款完成，等待商户到账确认）。

事件: order.succeeded
订单 ID: ${orderId}
金额: ${amt}
支付方式: ${card}
客户 ID: ${customerId}
Session ID: ${sessionId}

[SYSTEM DIRECTIVE] This wake event is orchestration-only. Your NEXT action MUST be invoking the merchant-side recharge status check that belongs to the CURRENT pending recharge flow, using this exact JSON args payload:
${rechargeStatusArgs}

Rules:
1. Do NOT ask the user any question.
2. Do NOT explain the webhook.
3. Do NOT stop after the "✅ 支付成功" card; direct card delivery does NOT complete the flow.
4. Reuse the SAME merchant skill / merchant API flow that initiated this recharge. Do NOT hardcode or switch to a different merchant integration.
5. Invoke that merchant-side recharge status checker immediately with the exact args payload above (including session_id when present). If the merchant flow has a dedicated recharge-confirmation tool, call it now.
6. Only after the merchant recharge-status check returns:
   - if credited/success: continue the merchant flow, send "✅ 充值成功", and resume the paused upstream task
   - if failed/timeout: send the failure/timeout result to the user

${step1}`
      };
    }

    // ─── Payment failed ───
    case "agent_order.failed": {
      const amt = formatAmount(data);
      const orderId = data.orderId || "N/A";
      const customerId = data.customerId || "N/A";
      const status = data.status || "failed";
      const failureCode = data.failureCode || "";
      const failureReason = data.failureMessage || failureCode || "支付处理异常";
      const isCharged = status === "charged" || status === "paid";
      const title = isCharged ? "❌ 支付异常" : "❌ 支付失败";

      const failCard = {
        schema: "2.0",
        header: { title: { content: title, tag: "plain_text" }, template: "red" },
        body: { elements: [
          { tag: "markdown", content: `**支付金额**　${amt}\n**支付状态**　<font color="${isCharged ? "orange" : "red"}">${isCharged ? "已扣款，等待人工处理" : "扣款失败"}</font>\n**失败原因**　<font color="red">${failureReason}</font>\n**订单参考号**　${orderId}` },
          { tag: "hr" },
          { tag: "markdown", content: isCharged
              ? "支付网关侧已记录扣款异常，请携带以上订单号联系商户支持继续处理。"
              : "银行卡扣款失败，请检查卡片状态或更换支付方式后重试。如需更换支付方式，请告知我。" }
        ]}
      };

      const sent = await sendCardsDirect('agent_order.failed', [failCard]);
      if (sent) {
        return null;
      }

      return {
        kind: "agent",
        name: "Clink",
        message: `[Clink Webhook] 支付失败回调。

事件: order.failed
订单 ID: ${orderId}
金额: ${amt}
状态: ${status}
失败代码: ${failureCode || "N/A"}
失败原因: ${failureReason}
客户 ID: ${customerId}

[SYSTEM DIRECTIVE] Direct webhook card delivery failed. YOU MUST immediately send this Feishu Interactive Card:
${cardExec(failCard)}

After sending the card, reply NO_REPLY and nothing else.`
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

      const refundCard = {
        schema: "2.0",
        header: { title: { content: isApproved ? "✅ 退款已通过" : "✅ 退款成功", tag: "plain_text" }, template: "green" },
        body: { elements: [
          { tag: "markdown", content: `**退款金额**　${amt}\n**原订单号**　${orderId}\n**退款单号**　${refundId}\n**退款方式**　${card}\n**退款状态**　<font color="green">成功</font>` },
          { tag: "hr" },
          { tag: "markdown", content: isApproved ? "退款申请已审核通过，资金将按发卡行或支付渠道的到账时效原路退回。" : "退款申请已处理成功，资金将按发卡行或支付渠道的到账时效原路退回。" }
        ]}
      };

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

[SYSTEM DIRECTIVE] Direct webhook card delivery failed. YOU MUST immediately send this Feishu Interactive Card:
${cardExec(refundCard)}

After sending the card, reply NO_REPLY and nothing else.`
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

      const refundFailCard = {
        schema: "2.0",
        header: { title: { content: isRejected ? "❌ 退款已拒绝" : "❌ 退款失败", tag: "plain_text" }, template: "red" },
        body: { elements: [
          { tag: "markdown", content: `**退款金额**　${amt}\n**原订单号**　${orderId}\n**退款单号**　${refundId}\n**退款方式**　${card}\n**失败原因**　<font color="red">${failureReason}</font>` },
          { tag: "hr" },
          { tag: "markdown", content: isRejected ? "退款申请未通过审核，请根据失败原因调整后再试或联系 Clink 支持排查。" : "退款申请未能成功处理，请稍后重试或联系 Clink 支持排查。" }
        ]}
      };

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

[SYSTEM DIRECTIVE] Direct webhook card delivery failed. YOU MUST immediately send this Feishu Interactive Card:
${cardExec(refundFailCard)}

After sending the card, reply NO_REPLY and nothing else.`
      };
    }

    // ─── Risk rules updated ───
    case "risk_rule.updated": {
      try {
        const cache = await readCache();
        cache.riskRules = data;
        await writeCache(cache);
      } catch (err) { await logError('risk_rule.updated cache update', err); }

      const riskCard = {
        schema: "2.0",
        header: { title: { content: "🛡️ 风控规则已生效", tag: "plain_text" }, template: "green" },
        body: { elements: [
          { tag: "markdown", content: `**单次上限**　${data.singleRechargeLimit ?? "N/A"}\n**每日总额**　${data.dailyTotalLimit ?? "N/A"}\n**每日次数**　${data.dailyMaxCount ?? "N/A"} 次\n**充值间隔**　${data.rechargeInterval ?? "N/A"}` },
          { tag: "hr" },
          { tag: "markdown", content: "风控规则已同步生效，后续充值将按此规则执行。" }
        ]}
      };

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

[SYSTEM DIRECTIVE] Risk rules have been updated and saved to local cache.
Direct webhook card delivery failed. YOU MUST immediately send this Feishu Interactive Card:
${cardExec(riskCard)}

After sending the card, reply NO_REPLY and nothing else.`
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
  return amount === "N/A" ? "N/A" : `${symbol}${amount}`;
}

function formatRefundAmount(data) {
  const currency = data.refund_currency || data.refundCurrency || "";
  const symbol = currency === "USD" ? "$" : currency;
  const amount = data.refund_amount ?? data.refundAmount ?? "N/A";
  return amount === "N/A" ? "N/A" : `${symbol}${amount}`;
}

function formatCachedCard(method) {
  const brand = method.cardScheme || "CARD";
  const last4 = method.cardLastFour || "????";
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

  if (data.cardBrand || data.cardLast4) {
    return `${(data.cardBrand || "CARD").toUpperCase()} ••••${data.cardLast4 || "????"}`;
  }

  if (data.paymentMethod) {
    const pm = data.paymentMethod;
    if (pm.cardBrand || pm.cardLastFour) {
      const brand = pm.cardBrand || "CARD";
      const last4 = pm.cardLastFour || "????";
      return `${brand.toUpperCase()} ••••${last4}`;
    }
    return `${pm.paymentMethodType || "CARD"} ${paymentInstrumentId}`.trim();
  }
  return "N/A";
}
