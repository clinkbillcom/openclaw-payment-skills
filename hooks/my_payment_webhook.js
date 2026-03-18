// my_payment_webhook.js
// OpenClaw webhook transform for Clink payment callbacks.
// Placed in ~/.openclaw/hooks/transforms/ at install time.
//
// Handles:
//   1. payment_method.added        — user finished binding a card on Clink hosted page
//   2. payment_method.defaultChange — user changed their default payment method
//   3. agent_order.created  — charge order created (intermediate)
//   4. agent_order.succeeded — payment succeeded
//   5. agent_order.failed   — payment or recharge failed
//   6. risk_rule.updated — risk rules changed

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
  if (cache.notify_target_id) {
    _notifyTarget = cache.notify_target_id;
    _notifyFlag = cache.notify_target_type === 'open_id' ? '--open-id' : '--chat-id';
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
    const parsed = JSON.parse(content);
    // Ensure payment_methods array always exists (initialize_wallet writes cache without it)
    if (!Array.isArray(parsed.payment_methods)) parsed.payment_methods = [];
    if (parsed.default_payment_method_id === undefined) parsed.default_payment_method_id = null;
    return parsed;
  } catch (err) {
    await logError('readCache', err);
    return { payment_methods: [], default_payment_method_id: null, cached_at: null };
  }
}

async function writeCache(cache) {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  cache.cached_at = new Date().toISOString();
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

module.exports = async function(ctx) {
  const { type, data } = ctx.payload || {};

  if (!type || !data) {
    return { kind: "wake", text: "[Clink Webhook] Received unknown payload with no type or data." };
  }

  switch (type) {

    // ─── Card binding completed ───
    case "payment_method.added": {
      const cardDisplay = `${(data.card_brand || "CARD").toUpperCase()} ••••${data.card_last4 || "????"}`;
      const email = data.customer_email || "N/A";

      // Update cache
      try {
        const cache = await readCache();
        const existing = cache.payment_methods.findIndex(m => m.payment_method_id === data.payment_method_id);
        if (existing >= 0) {
          cache.payment_methods[existing] = data;
        } else {
          cache.payment_methods.push(data);
        }
        if (data.is_default) {
          cache.payment_methods.forEach(m => { m.is_default = m.payment_method_id === data.payment_method_id; });
          cache.default_payment_method_id = data.payment_method_id;
        }
        if (!cache.initialized) cache.initialized = true;
        if (data.customer_email && !cache.email) cache.email = data.customer_email;
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
客户 ID: ${data.customer_id || "N/A"}
支付方式 ID: ${data.payment_method_id || "N/A"}
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
      const cardDisplay = `${(data.card_brand || "CARD").toUpperCase()} ••••${data.card_last4 || "????"}`;

      // Update cache
      try {
        const cache = await readCache();
        const existing = cache.payment_methods.findIndex(m => m.payment_method_id === data.payment_method_id);
        if (existing >= 0) {
          cache.payment_methods[existing] = data;
        } else {
          cache.payment_methods.push(data);
        }
        cache.payment_methods.forEach(m => { m.is_default = m.payment_method_id === data.payment_method_id; });
        cache.default_payment_method_id = data.payment_method_id;
        await writeCache(cache);
      } catch (err) { await logError('payment_method.defaultChange cache update', err); }

      const updateCard = {
        schema: "2.0",
        header: { title: { content: "✅ 默认支付方式已更新", tag: "plain_text" }, template: "green" },
        body: { elements: [
          { tag: "markdown", content: `**当前默认卡**　<font color="green">${cardDisplay}</font>\n**支付方式 ID**　${data.payment_method_id || "N/A"}` },
          { tag: "hr" },
          { tag: "markdown", content: "后续付款将优先使用这张卡。如需继续之前失败的支付，请直接告诉我重新发起。" }
        ]}
      };

      const sent = await sendCardsDirect('payment_method.defaultChange', [updateCard]);
      if (sent) {
        return null;
      }

      return {
        kind: "agent",
        name: "Clink",
        message: `[Clink Webhook] 默认支付方式已变更。

事件: payment_method.defaultChange
客户 ID: ${data.customer_id || "N/A"}
新默认卡: ${cardDisplay}
支付方式 ID: ${data.payment_method_id || "N/A"}

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
      const card = formatCard(data);
      const orderId = data.order_id || data.orderId || "N/A";
      const customerId = data.customer_id || data.customerId || "N/A";
      const sessionId = data.session_id || data.sessionId || "无";

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

      return {
        kind: "agent",
        name: "Clink",
        message: `[Clink Webhook] 支付成功回调（扣款完成，等待商户到账确认）。

事件: order.succeeded
订单 ID: ${orderId}
金额: ${amt}
支付方式: ${card}
客户 ID: ${customerId}
Session ID: ${sessionId}

[SYSTEM DIRECTIVE] Payment (card charge) succeeded, but merchant recharge is NOT yet confirmed.
YOU MUST do the following in order:

${step1}

Step 2: Use the merchant's own skill or API to confirm whether the recharge has been credited to the user's merchant account. Pass the order_id="${orderId}" to the merchant's recharge status check.
If calling via shell (do NOT omit --args):
\`\`\`
npx mcporter call modelmax-media check_recharge_status --args '{"order_id":"${orderId}"}'
\`\`\`

Step 3: Based on the merchant confirmation result:
  - If credited/success: send "✅ 充值成功" card with the recharge details and resume any paused upstream task.
  - If failed or timeout: send "❌ 充值失败" card with order reference number "${orderId}" for user to contact merchant support.

DO NOT send a "充值成功" card until the merchant confirms the recharge is credited.`
      };
    }

    // ─── Payment or recharge failed ───
    case "agent_order.failed": {
      const amt = formatAmount(data);
      const orderId = data.order_id || "N/A";
      const customerId = data.customer_id || "N/A";
      const status = data.status || "failed";
      const failureCode = data.failure_code || "";
      const failureReason = data.failure_message || failureCode || "支付处理异常";
      const isCharged = status === "charged" || status === "paid";

      const failCard = {
        schema: "2.0",
        header: { title: { content: "❌ 充值失败：建议联系商户支持", tag: "plain_text" }, template: "red" },
        body: { elements: [
          { tag: "markdown", content: `**支付状态**　<font color="${isCharged ? "green" : "red"}">${isCharged ? `已扣款 ${amt}` : "扣款失败"}</font>\n**充值状态**　<font color="red">失败</font>\n**失败原因**　<font color="red">${failureReason}</font>\n**订单参考号**　${orderId}` },
          { tag: "hr" },
          { tag: "markdown", content: isCharged
              ? "您的银行卡已成功扣款，但商户账户未收到充值。请携带以上订单号联系商户客服处理。"
              : "银行卡扣款失败，请检查卡片状态或更换支付方式后重试。如需更换支付方式，请告知我。" },
          { tag: "button", text: { content: "联系支持", tag: "plain_text" }, type: "primary", url: "https://www.modelmax.io" }
        ]}
      };

      const sent = await sendCardsDirect('agent_order.failed', [failCard]);
      if (sent) {
        return null;
      }

      return {
        kind: "agent",
        name: "Clink",
        message: `[Clink Webhook] 充值失败回调。

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

    // ─── Risk rules updated ───
    case "risk_rule.updated": {
      try {
        const cache = await readCache();
        cache.risk_rules = data;
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
  // Support both snake_case and camelCase field names
  const currency = data.currency || data.paymentCurrency || "";
  const symbol = currency === "USD" ? "$" : currency;
  const amount = data.amount ?? data.amountTotal ?? data.amountSubtotal ?? "N/A";
  return amount === "N/A" ? "N/A" : `${symbol}${amount}`;
}

function formatCard(data) {
  // Top-level snake_case (payment_method.added style)
  if (data.card_brand || data.card_last4) {
    return `${(data.card_brand || "CARD").toUpperCase()} ••••${data.card_last4 || "????"}`;
  }
  // Nested paymentMethod object (legacy)
  if (data.paymentMethod) {
    const pm = data.paymentMethod;
    if (pm.card_brand || pm.card_last4 || pm.cardBrand || pm.cardLastFour) {
      const brand = pm.card_brand || pm.cardBrand || "CARD";
      const last4 = pm.card_last4 || pm.cardLastFour || "????";
      return `${brand.toUpperCase()} ••••${last4}`;
    }
    return `${pm.paymentMethodType || "CARD"} ${pm.paymentInstrumentId || ""}`.trim();
  }
  return "N/A";
}
