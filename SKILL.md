---
name: agent-payment-skills
description: "Universal agent skill to integrate Clink payments, handling user initialization, merchant-initiated payments (auto top-ups), direct payments, and async webhook callbacks. Cards are sent via exec using the built-in scripts/send-feishu-card.mjs script (no external skill dependency)."
version: "1.0.0"
metadata:
  openclaw:
    scriptsDir: "scripts"
    tools:
      card_sender: "scripts/send-feishu-card.mjs"
      mcp_server: "index.bundle.mjs"
permissions:
  - network
  - system
tools:
  - name: initialize_wallet
    description: Run once per user. Generates signature key, requests email, calls Clink bootstrap API, and sets up webhook.
  - name: get_wallet_status
    description: Check the local configuration status of the wallet (e.g., if it is initialized).
  - name: get_binding_link
    description: Generates a URL for the user to bind a new payment method and returns currently bound methods. If no methods exist, returns a setup link; if methods exist, returns an informational card with current card details.
  - name: get_risk_rules_link
    description: Generates a URL for the user to configure recharge risk rules (per-charge limit, daily limit, frequency, cooldown, approval threshold).
  - name: get_payment_method_setup_link
    description: Generates a URL for the user to add a new payment method (credit card, PayPal, Cash App, etc.).
  - name: get_payment_method_modify_link
    description: Generates a URL for the user to manage, switch, or modify existing payment methods.
  - name: list_payment_methods
    description: List all payment methods bound to the user's wallet. Requires a valid binding token.
  - name: get_payment_method_detail
    description: Get detailed information about a specific payment method.
  - name: update_payment_method
    description: Update the billing address of a specific payment method.
  - name: delete_payment_method
    description: Delete a specific payment method from the wallet.
  - name: set_default_payment_method
    description: Set a specific payment method as the default for future transactions.
  - name: pre_check_account
    description: Run before clink_pay to verify account readiness (wallet initialized, payment method bound). Displays an account check status card to the user.
  - name: clink_pay
    description: Execute a payment via Clink. Supports two modes — direct mode (merchant_id + amount + currency) and session mode (sessionId from merchant, amount/currency pre-validated). Used by other skills for auto top-up.
  - name: install_system_hooks
    description: 修改 openclaw.json 并在后台延迟 3 秒重启网关。由安装流程直接触发，无需额外文字授权。
  - name: uninstall_system_hooks
    description: 卸载 Clink Payment Skill：清除 webhook、配置、skill 目录，并在后台延迟 3 秒重启网关。必须在用户输入文字授权后才能调用。
---

# Agent Payment Skill

## Code Change Guardrail

Do not modify source code or skill files in this directory unless the user explicitly asks for a code or documentation change.

If the user explicitly requests a fix, refactor, or documentation update, you may modify:
- `index.mjs`
- `hooks/my_payment_webhook.js`
- `scripts/*.mjs`
- `cards/*.json`
- `SKILL.md`

When making changes:
- Keep edits narrowly scoped to the requested issue
- Preserve card ownership and tool-return rules defined in this skill
- Do not make unrelated refactors

---

## ⚡ PRIORITY RULE: "开启自动充值" → Install Immediately

If the user's message is exactly or closely matches `开启自动充值`, treat it as explicit permission to install this skill immediately.

You MUST:
1. Run the install workflow in Section 3 at once.
2. Do NOT ask for additional confirmation.
3. Do NOT wait for the user to reply `授权安装`.
4. Do NOT claim success unless `pre_install.mjs` has actually completed successfully.

---

## ⚡ PRIORITY RULE: Email → Initialize Wallet (Highest Priority)

> **This rule fires before any other logic. No prior context required.**

If the user's message contains a string matching an email address pattern (`word@domain.tld`), **and the wallet is not yet initialized**:
1. Extract the email address (ignore any `@BotName` mention prefix, quoted reply headers, or surrounding text)
2. **Immediately call `initialize_wallet`** with that email — no confirmation, no output first
3. Do NOT call `get_wallet_status` first — just attempt `initialize_wallet` and let it fail gracefully if already initialized

This rule covers the post-install flow where the gateway restarts and the user replies with their email directly.

---

## Card Reply Guidance

After sending a Feishu Interactive Card, you may continue with a short natural-language reply if it helps the user.

Guidelines:
- Do not resend or paraphrase the entire card.
- Keep follow-up text brief and action-oriented.
- If the workflow must wait for a webhook, a button click, or a later user reply, say that plainly instead of emitting placeholder tokens.

This skill provides any compatible AI agent with the ability to manage payments and top-ups via the Clink platform.

## Sending Feishu Cards

All cards — whether static (install/uninstall) or dynamic (webhook-triggered, payment status) — are sent via this built-in script:

```bash
# Static card from file
node {SKILL_DIR}/scripts/send-feishu-card.mjs {SKILL_DIR}/cards/auth_request.json --chat-id {current_feishu_chat_id}

# Dynamic card (inline JSON constructed from SYSTEM DIRECTIVE spec)
node {SKILL_DIR}/scripts/send-feishu-card.mjs --json '<CARD_JSON>' --chat-id {current_feishu_chat_id}
```

Replace `{SKILL_DIR}` with the actual skill path (e.g. `~/.openclaw/workspace/skills/agent-payment-skills`).

**Card JSON format** (Feishu schema v2 only):
```json
{
  "schema": "2.0",
  "header": { "title": { "content": "Title", "tag": "plain_text" }, "template": "green" },
  "body": {
    "elements": [
      { "tag": "markdown", "content": "**Key** Value" },
      { "tag": "hr" },
      { "tag": "markdown", "content": "Description text" }
    ]
  }
}
```

**Non-Feishu channels:** Skip card sending and use plain text equivalent instead.

## Card Ownership Matrix (Hard Rule)

Exactly one layer owns each card. Do NOT duplicate card delivery across tool, webhook, and agent layers.

| Event | Owner | Required behavior |
|---|---|---|
| `initialize_wallet` + existing/new binding confirmation | agent/tool result | Send only the returned initialization card(s) |
| `clink_pay` sync `status=1` | payment tool | Payment tool may already send `✅ 支付成功`; agent MUST NOT send another |
| `clink_pay` sync `status=3/4/6` | payment tool | Payment tool may already send `❌ 支付失败` or `🛡️ 风控规则触发`; agent MUST NOT send another |
| `clink_pay` sync `flag3DS=1` | agent | Agent MUST send exactly one `🔐 3DS 验证` card from the returned directive |
| `agent_order.succeeded` webhook | payment webhook | Webhook may send `✅ 支付成功` only if it was not already sent |
| `agent_order.failed` webhook | payment webhook | Webhook may send failure card only if it was not already sent |
| Merchant recharge success/failure | merchant confirmation tool | Payment skill MUST NOT send merchant-layer `✅ 充值成功` or `❌ 充值失败` cards |

## Tool Return Contract (Hard Rule)

- `DIRECT_SEND`
  - Meaning: the tool/webhook has already sent the card itself
  - Agent MUST NOT send a second semantic-equivalent card
- `EXEC_REQUIRED`
  - Meaning: the tool explicitly returned a card exec directive
  - Agent MUST execute it exactly once
- `WAIT_FOR_WEBHOOK`
  - Meaning: do nothing now; wait for async webhook handoff
- `NO_REPLY`
  - Meaning: preserve exactly; do not append text, cards, or retries

## Prohibited Behaviors (Hard Rule)

- Do NOT send the same semantic card twice for the same `order_id`.
- Do NOT send a payment-layer success/failure card after a tool/webhook already direct-sent it.
- Do NOT start merchant recharge confirmation from agent memory alone; follow the current tool/webhook ownership rule.
- Do NOT paraphrase the full card contents in natural language after the card is sent.
- Do NOT infer card ownership from prior turns; follow the ownership matrix only.

## Amount Selection Rule (Hard Rule)

There are only two valid amount sources for `clink_pay`:

1. User override
   - If the user explicitly provides a concrete recharge amount in the current turn, you MUST use that amount.
   - This user-specified amount overrides the merchant default.

2. Merchant default
   - If the user does not explicitly provide a concrete amount in the current turn, you MUST use the exact `default_amount` returned by the merchant's payment-config tool.

You MUST NOT invent a third amount from memory, prior turns, habit, or judgment.
You MUST NOT replace the merchant default with `1`, `5`, or any other arbitrary amount unless the user explicitly asked for that amount in the current turn.

## Supported Merchants

When a user asks to top up / recharge any of the following merchants, you MUST automatically route the payment through this skill (agent-payment-skills). Do NOT ask the user to pay manually.

| Merchant | How to get merchant_id | How to confirm recharge |
|---|---|---|
| **ModelMax** | Call `modelmax-media.get_payment_config` | Call `modelmax-media.check_recharge_status` with order_id |

**Routing rule**: Any user request like "给 ModelMax 充值", "recharge ModelMax", "top up my ModelMax account", or a 402 response from any supported merchant skill, MUST trigger the following flow:
1. Call `pre_check_account`
2. **Always call** the merchant's tool to obtain `merchant_id` (see table above). Do NOT use a merchant_id from memory, context, or previous conversation turns — always fetch it fresh via the tool.
3. Call `clink_pay` with the merchant_id and amount:
   - If the user explicitly specified an amount, use that amount.
   - **If triggered automatically (402 / low-balance): use the exact `default_amount` and `currency` returned by the merchant's `get_payment_config` tool. Do NOT ask the user. Do NOT pause. Call clink_pay immediately.**
   - Do NOT substitute another amount unless the user explicitly provided a different amount in the current turn.
4. After `clink_pay` returns, follow the tool return contract only:
   - If the result indicates `DIRECT_SEND`, do NOT send a duplicate payment card
   - If the result indicates `EXEC_REQUIRED`, execute it exactly once
   - If the result indicates `WAIT_FOR_WEBHOOK`, wait
5. Merchant recharge confirmation MUST be triggered only by the payment layer handoff that owns that event (sync direct-send success or `agent_order.succeeded` webhook). Do NOT invent a second merchant-confirm step from agent memory.
6. After merchant recharge is confirmed (via the merchant confirmation tool, such as `check_recharge_status` for ModelMax): **automatically resume the original task** that was interrupted by the insufficient-balance event. Do NOT wait for further user instruction.

## Instructions & Workflows

### 1. Initialization (Runs once per user)
When a user installs or uses this skill for the first time:
1. **Request Email:** Prompt the user to input their email address.
2. **Initialize Wallet:** Call `initialize_wallet` with the user's email. This only bootstraps the Clink account — it does NOT complete initialization.
   If calling via shell (do NOT omit --args):
   ```
   npx mcporter call agent-payment-skills initialize_wallet --args '{"email":"<USER_EMAIL>"}'
   ```
3. **Check Payment Method:** Call `get_binding_link` to check if a payment method exists.
   If calling via shell:
   ```
   npx mcporter call agent-payment-skills get_binding_link --args '{}'
   ```
   - If none → the user gets a card with a link to bind one. **Wait for the `payment_method.added` webhook callback** before proceeding.
   - If exists → skip to step 4.
4. **View Risk Rules (Optional):** Call `get_risk_rules_link` to let the user view and optionally configure risk rules. This step is NOT required — initialization is complete once a payment method is bound. Risk rules can be configured at any time.
   If calling via shell:
   ```
   npx mcporter call agent-payment-skills get_risk_rules_link --args '{}'
   ```
5. **Send Initialization Complete Card:** Once payment method is confirmed (either already existed or `payment_method.added` webhook received), send the "🎉 Clink 初始化完成！" card. Do NOT wait for risk rules.

### 2. Execute Payment (Direct or Auto Top-Up)
When the user requests a recharge or another skill triggers an auto top-up:
1. **Pre-Check:** Call `pre_check_account` to verify the account is ready. Do NOT send any "🔍 Clink 账户检测通过" card when this check passes.
   If calling via shell (do NOT omit --args):
   ```
   npx mcporter call agent-payment-skills pre_check_account --args '{}'
   ```
   - If pre-check fails (no card bound, wallet not initialized), follow the prompts to fix the issue before proceeding.
2. **Execute Payment:** Call `clink_pay` with `merchant_id` + `amount` (direct mode) or `sessionId` (session mode).
   If calling via shell (do NOT omit --args, replace placeholders):
   ```
   # Direct mode:
   npx mcporter call agent-payment-skills clink_pay --args '{"merchant_id":"<MERCHANT_ID>","amount":<AMOUNT>,"currency":"USD"}'
   # Session mode:
   npx mcporter call agent-payment-skills clink_pay --args '{"sessionId":"<SESSION_ID>"}'
   ```
3. **After `clink_pay` returns:** Follow the tool return contract only. Do NOT synthesize extra payment cards.
4. **Webhook ownership rule:** Async webhook is the only fallback confirmation trigger for pending/3DS flows:
   - `agent_order.succeeded` → Payment webhook may send `✅ 支付成功` if needed, then hand off merchant confirmation
   - `agent_order.failed` → Payment webhook may send payment-layer failure feedback if needed
   - `flag3DS=1` (synchronous) → Agent sends exactly one `🔐 3DS 验证` card, then waits for webhook
5. **Handle Failures:**
   - Card declined → Send switch payment method card. After receiving `payment_method.defaultChange` webhook, inform the user the new card is active and **ask if they want to retry the payment**. Do NOT retry automatically.
   - Email mismatch → Show the security block card. Do NOT retry.
   - Risk rule triggered → Show options (override / modify rules / pause).

### 2.5 Payment Method Management
When the user asks to view or manage their payment methods:
1. **Show Current Status:** Call `get_binding_link` to display current payment method and email as an informational card.
2. **Open Management Page:** Call `get_payment_method_modify_link` to generate the management URL. Send a "⚙️ 支付方式管理" card with the link.
3. **Confirm Update:** After the user returns from the external page, send a "✅ 支付方式已更新" card showing:
   - 当前支付方式: updated ✓
   - 通知邮箱: confirmed ✓
   - 风控规则: 保持不变 ✓

### 3. Post-Installation Setup (Strict Single-Step Workflow)

When the user asks to install this skill, the agent MUST follow this exact workflow:

1. **Run pre-install immediately**
   Registers MCP, writes config, verifies the route write, spawns the post-restart notify process, and sends the status card in one command:
   - **Feishu group chat:** `node {SKILL_DIR}/scripts/pre_install.mjs --chat-id {current_feishu_chat_id}`
   - **Feishu direct message:** `node {SKILL_DIR}/scripts/pre_install.mjs --open-id {current_feishu_open_id}`

   This step is mandatory and must not be skipped.

2. **If pre-install fails**
   - Stop immediately.
   - Report the error to the user.
   - Do NOT restart the gateway.
   - Do NOT claim the webhook route is configured.
   - Do NOT claim installation succeeded.

3. **Restart the gateway immediately after successful pre-install**
   ```
   openclaw gateway restart
   ```
   Run this immediately after `pre_install.mjs` exits successfully. The notify process may send the post-restart initialization card after the gateway is back up.

4. **Truthfulness guardrail**
   The agent MUST NOT say any of the following unless `pre_install.mjs` has actually succeeded in the current session:
   - `Webhook 路由已就绪`
   - `安装完成`
   - `可以进入钱包初始化`
   - `重启后通知一定已经配置成功`

   A delayed card or notify log entry alone is NOT sufficient proof that installation completed correctly.

### 4. Uninstall (Text-Based Workflow)

When the user asks to uninstall this skill, the agent MUST follow the same strict workflow:

1. **Send Uninstall Authorization Card**:
   - **Feishu channel:** Run: `node {SKILL_DIR}/scripts/send-feishu-card.mjs {SKILL_DIR}/cards/uninstall_request.json --chat-id {current_feishu_chat_id}`
   - **Non-Feishu channel:** Send plain text: "⚠️ 卸载将执行以下不可逆操作：删除 Webhook 拦截器、清除配置、删除目录、重启网关。\n\n请回复 \"确认卸载\" 以确认。"
   - Do NOT execute any destructive operations yet. After sending the card, you may add a short natural-language reminder that uninstall is waiting for text confirmation.

2. **Wait for Text Approval**:
   Pause execution. **Wait for the user to explicitly reply with "确认卸载" or similar approval in the chat.**

3. **Execute Uninstall**:
   ONLY AFTER receiving the text approval, call the `uninstall_system_hooks` tool with `target_id` set to the current chat's open_id (same as install). Do NOT manually run `openclaw mcp remove`, edit `openclaw.json`, `rm -rf` the skill directory, or try to send the final card yourself via local files. The tool owns the full uninstall sequence and keeps the delete-self step last. This tool will:
   - Remove `my_payment_webhook.js` from `~/.openclaw/hooks/transforms/`.
   - Remove the `hooks/clink/payment` route mapping from `openclaw.json` `hooks.mappings`.
   - Remove Clink skill config (`skills.entries["agent-payment-skills"]`) from `openclaw.json`.
   - Unregister the MCP server: `openclaw mcp remove agent-payment-skills`.
   - Remove the skill directory.
   - Schedule an async gateway restart (3-second delay, non-blocking).

4. **Final Confirmation**:
   The tool will return immediately. You MUST send an "🗑️ Clink Payment Skill 卸载执行中" card to the user stating that uninstall is in progress and the gateway will automatically restart after the uninstall completes.

## API References
- API Documentation: `https://docs.clinkbill.com/`
