// my_payment_webhook.js
// OpenClaw webhook transform for Clink payment callbacks.
// Placed in ~/.openclaw/hooks/transforms/ at install time.
//
// Handles four callback types:
//   1. payment_method.added        — user finished binding a card on Clink hosted page
//   2. payment_method.defaultChange — user changed their default payment method
//   3. order.created     — charge order created (intermediate)
//   4. order.succeeded   — payment + recharge succeeded
//   5. order.failed      — payment or recharge failed

const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const CACHE_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'skills', 'agent-payment-skills', 'clink.config.json');

async function readCache() {
  try {
    const content = await fs.readFile(CACHE_PATH, 'utf8');
    return JSON.parse(content);
  } catch {
    return { payment_methods: [], default_payment_method_id: null, cached_at: null };
  }
}

async function writeCache(cache) {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  cache.cached_at = new Date().toISOString();
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

module.exports = async function(payload) {
  const { type, data } = payload || {};

  if (!type || !data) {
    return { action: "wake", text: "[Clink Webhook] Received unknown payload with no type or data." };
  }

  switch (type) {

    // ─── Card binding completed ───
    case "payment_method.added": {
      const card = `${(data.card_brand || "CARD").toUpperCase()} ••••${data.card_last4 || "????"}`;
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
        await writeCache(cache);
      } catch {}

      return {
        action: "agent",
        name: "Clink",
        message: `[Clink Webhook] 绑卡成功回调。

事件: payment_method.added
客户邮箱: ${email}
客户 ID: ${data.customer_id || "N/A"}
支付方式 ID: ${data.payment_method_id || "N/A"}
卡片: ${card}
状态: ${data.status || "active"}

[SYSTEM DIRECTIVE] The user has successfully bound a new payment method. Initialization is now complete.
YOU MUST send TWO Feishu Interactive Cards in order:

Card 1:
- Template / Style: "✅ 支付方式绑定成功" (Green theme, header h-ok)
- Key-Value Rows:
  - 绑定支付方式: "${card}" (Green)
  - 邮箱: "${email}"

Card 2 (initialization complete):
- Template / Style: "🎉 Clink 初始化完成！" (Green theme, header h-ok)
- Key-Value Rows:
  - 绑定支付方式: "${card} ✓" (Green)
  - 规则状态: "已生效" (Green)
- Description: "你现在可以部署自动充值任务。风控规则可选，可随时通过「查看风控规则」配置。"
- No action buttons needed.`
      };
    }

    // ─── Default payment method changed ───
    case "payment_method.defaultChange": {
      const card = `${(data.card_brand || "CARD").toUpperCase()} ••••${data.card_last4 || "????"}`;

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
      } catch {}

      return {
        action: "agent",
        name: "Clink",
        message: `[Clink Webhook] 默认支付方式已变更。

事件: payment_method.defaultChange
客户 ID: ${data.customer_id || "N/A"}
新默认卡: ${card}
支付方式 ID: ${data.payment_method_id || "N/A"}

[SYSTEM DIRECTIVE] The user's default payment method has changed. Update any displayed card info accordingly.`
      };
    }

    // ─── Order created (intermediate state) ───
    case "order.created": {
      const amt = formatAmount(data);
      return {
        action: "agent",
        name: "Clink",
        message: `[Clink Webhook] 充值订单已创建。

事件: order.created
订单 ID: ${data.orderId || "N/A"}
金额: ${amt}
状态: ${data.status || "pending"}
客户 ID: ${data.customerId || "N/A"}
Session ID: ${data.sessionId || "无"}

[SYSTEM DIRECTIVE] A charge order has been created and is processing.
DO NOT send a final success/failure card yet. Wait for order.succeeded or order.failed webhook.`
      };
    }

    // ─── Payment succeeded (card charged, recharge not yet confirmed) ───
    case "order.succeeded": {
      const amt = formatAmount(data);
      const card = formatCard(data);

      return {
        action: "agent",
        name: "Clink",
        message: `[Clink Webhook] 支付成功回调（扣款完成，等待商户到账确认）。

事件: order.succeeded
订单 ID: ${data.orderId || "N/A"}
金额: ${amt}
支付方式: ${card}
客户 ID: ${data.customerId || "N/A"}
Session ID: ${data.sessionId || "无"}

[SYSTEM DIRECTIVE] Payment (card charge) succeeded, but merchant recharge is NOT yet confirmed.
YOU MUST do the following in order:

Step 1: Send a Feishu Interactive Card to the user:
- Template / Style: "✅ 支付成功" (Green theme, header h-ok)
- Key-Value Rows:
  - 支付金额: "${amt}"
  - 扣款方式: "${card}"
- Description: "已完成扣款，正在等待商户确认到账…"

Step 2: Use the merchant's own skill or API to confirm whether the recharge has been credited to the user's merchant account. Pass the order_id="${data.orderId || ""}" to the merchant's recharge status check.

Step 3: Based on the merchant confirmation result:
  - If credited/success: send "✅ 充值成功" card with the recharge details and resume any paused upstream task.
  - If failed or timeout: send "❌ 充值失败" card with order reference number "${data.orderId || ""}" for user to contact merchant support.

DO NOT send a "充值成功" card until the merchant confirms the recharge is credited.`
      };
    }

    // ─── Payment or recharge failed ───
    case "order.failed": {
      const amt = formatAmount(data);
      const card = formatCard(data);
      const status = data.status || "failed";
      const failureReason = data.failureReason || data.failure_reason || data.declineReason || data.decline_reason || "支付处理异常";
      const isCharged = status === "charged" || status === "paid" || data.chargeStatus === "succeeded";

      return {
        action: "agent",
        name: "Clink",
        message: `[Clink Webhook] 充值失败回调。

事件: order.failed
订单 ID: ${data.orderId || "N/A"}
金额: ${amt}
支付方式: ${card}
状态: ${status}
失败原因: ${failureReason}
客户 ID: ${data.customerId || "N/A"}
Session ID: ${data.sessionId || "无"}

[SYSTEM DIRECTIVE] Payment or recharge failed.
YOU MUST immediately send a Feishu Interactive Card to the user:
- Template / Style: "❌ 充值失败：建议联系商户支持" (Red theme, header h-danger)
- Key-Value Rows:
  - 支付状态: "${isCharged ? `已扣款 ${amt}` : '扣款失败'}" (${isCharged ? 'Green' : 'Red'})
  - 充值状态: "失败" (Red)
  - 失败原因: "${failureReason}" (Red)
  - 订单参考号: "${data.orderId || 'N/A'}"
- Description: "${isCharged ? '您的银行卡已成功扣款，但商户账户未收到充值。请携带以上订单号联系商户客服处理。' : '银行卡扣款失败，请检查卡片状态或更换支付方式后重试。'}"
- Button 1 (red, ${isCharged ? 'non-interactive label' : 'action: call get_payment_method_modify_link to open payment method switch page'}): "${isCharged ? '联系商户支持' : '更换支付方式'}"
- Button 2 (ghost): "查看充值记录"`
      };
    }

    // ─── Risk rules updated ───
    case "risk_rule.updated": {
      try {
        const cache = await readCache();
        cache.risk_rules = data;
        await writeCache(cache);
      } catch {}

      return {
        action: "agent",
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
YOU MUST immediately send a Feishu Interactive Card to the user:
- Template / Style: "🛡️ 风控规则已生效" (Green theme, header h-ok)
- Key-Value Rows:
  - 单次上限: "${data.singleRechargeLimit ?? 'N/A'}"
  - 每日总额: "${data.dailyTotalLimit ?? 'N/A'}"
  - 每日次数: "${data.dailyMaxCount ?? 'N/A'} 次"
  - 充值间隔: "${data.rechargeInterval ?? 'N/A'}"
- Description: "风控规则已同步生效，后续充值将按此规则执行。"
- No action buttons needed.`
      };
    }

    // ─── Unknown event type ───
    default: {
      return {
        action: "agent",
        name: "Clink",
        message: `[Clink Webhook] 收到未知事件类型: ${type}\n\nPayload: ${JSON.stringify(data).slice(0, 500)}\n\n[SYSTEM DIRECTIVE] Unknown Clink webhook event. Log this for debugging but do not send a card to the user.`
      };
    }
  }
}

// ─── Helpers ───

function formatAmount(data) {
  const symbol = data.paymentCurrency === "USD" ? "$" : (data.paymentCurrency || "");
  const amount = data.amountTotal ?? data.amountSubtotal ?? "N/A";
  return `${symbol}${amount}`;
}

function formatCard(data) {
  // Try top-level card_brand/card_last4 first (same format as card.added)
  if (data.card_brand || data.card_last4) {
    return `${(data.card_brand || "CARD").toUpperCase()} ••••${data.card_last4 || "????"}`;
  }
  // Fall back to nested paymentMethod object
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
