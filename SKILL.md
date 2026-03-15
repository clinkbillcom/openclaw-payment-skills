---
name: agent-payment-skills
description: "Universal agent skill to integrate Clink payments, handling user initialization, merchant-initiated payments (auto top-ups), direct payments, and async webhook callbacks. SILENT REPLY MANDATE: Whenever you send a Feishu Interactive Card, your ONLY output after the card MUST be the single token NO_REPLY. DO NOT output any other text, markdown, or explanation."
version: "1.0.0"
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
    description: 修改 openclaw.json 并在后台延迟 3 秒重启网关。必须在用户输入文字授权后才能调用。
  - name: uninstall_system_hooks
    description: 卸载 Clink Payment Skill：清除 webhook、配置、skill 目录，并在后台延迟 3 秒重启网关。必须在用户输入文字授权后才能调用。
---

# Agent Payment Skill

## ⚠️ SILENT REPLY MANDATE — SYSTEM-LEVEL HARD CONSTRAINT

> **This rule overrides your conversational instincts. It cannot be softened, summarized around, or prefaced.**

Whenever you send a Feishu Interactive Card — whether triggered by a tool SYSTEM DIRECTIVE or by your own card spec — your turn MUST end with **exactly and ONLY** the single token:

```
NO_REPLY
```

**DO NOT** output any markdown text, summaries, confirmations, or follow-up sentences after the card. Not even one word. The OpenClaw gateway will suppress `NO_REPLY`; the user sees only the card. Any text you add besides `NO_REPLY` destroys the clean UX.

This rule applies to **every** card sent by this skill: balance cards, payment status cards, initialization cards, install/uninstall confirmation cards, and webhook-triggered cards.

This skill provides any compatible AI agent with the ability to manage payments and top-ups via the Clink platform.

## Instructions & Workflows

### 1. Initialization (Runs once per user)
When a user installs or uses this skill for the first time:
1. **Request Email:** Prompt the user to input their email address.
2. **Initialize Wallet:** Call `initialize_wallet` with the user's email. This only bootstraps the Clink account — it does NOT complete initialization.
3. **Check Payment Method:** Call `get_binding_link` to check if a payment method exists.
   - If none → the user gets a card with a link to bind one. **Wait for the `payment_method.added` webhook callback** before proceeding.
   - If exists → skip to step 4.
4. **View Risk Rules (Optional):** Call `get_risk_rules_link` to let the user view and optionally configure risk rules. This step is NOT required — initialization is complete once a payment method is bound. Risk rules can be configured at any time.
5. **Send Initialization Complete Card:** Once payment method is confirmed (either already existed or `payment_method.added` webhook received), send the "🎉 Clink 初始化完成！" card. Do NOT wait for risk rules.

### 2. Execute Payment (Direct or Auto Top-Up)
When the user requests a recharge or another skill triggers an auto top-up:
1. **Pre-Check:** Call `pre_check_account` to verify the account is ready. This displays a "🔍 Clink 账户检测通过" card to the user showing payment method ✓, risk rules ✓, email ✓.
   - If pre-check fails (no card bound, wallet not initialized), follow the prompts to fix the issue before proceeding.
2. **Execute Payment:** Call `clink_pay` with `merchant_id` + `amount` (direct mode) or `sessionId` (session mode).
3. **Wait for Result:** The payment result comes asynchronously via webhook:
   - `order.succeeded` → Send "✅ 支付成功" card, then use the merchant's skill/API to confirm recharge is credited.
   - `order.failed` → Send "❌ 充值失败" card with order reference for support.
   - `flag3DS=1` (synchronous) → Send "🔐 3DS 验证" card with link, wait for webhook.
4. **Handle Failures:**
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

### 3. Post-Installation Setup (Text-Based Workflow)

When the user asks to install this skill, the agent MUST follow this strict workflow:

1. **Send Authorization Card**:
   Call the `feishu-interactive-cards` skill to send `cards/auth_request.json`. Do NOT execute system modifications yet. After sending the card, reply `NO_REPLY` and nothing else — do NOT add any explanatory text.

2. **Wait for Text Approval**:
   Pause execution. **Wait for the user to explicitly reply with "授权安装" or similar approval in the chat.**

3. **Execute High-Risk Operations**:
   ONLY AFTER receiving the text approval, call the `install_system_hooks` tool (or execute manually). The sequence MUST be:
   - Run `npm install` inside the skill directory (`~/.openclaw/workspace/skills/agent-payment-skills`) to install required dependencies like zod and langchain.
   - Copy `hooks/my_payment_webhook.js` into `~/.openclaw/hooks/transforms/`.
   - Inject `{"match": {"path": "hooks/clink/payment"}, "transform": {"module": "my_payment_webhook.js"}}` into `openclaw.json` under `hooks.mappings`.
   - Call `install_system_hooks` with `target_id` set to the current chat's open_id (group chat ID or user ID). The tool will schedule a three-stage background script: sleep 3s → restart gateway → sleep 10s → send notification to `target_id` once the gateway is back up.

4. **Final Confirmation before Restart**:
   The `install_system_hooks` tool will return a SYSTEM DIRECTIVE. You MUST follow its instructions to send the green Feishu Interactive Card ("✅ 依赖与路由注入成功") asking for the user's email. After sending it, reply `NO_REPLY` to end your turn. The gateway will restart automatically.

5. **Post-Restart Initialization**:
   When the gateway comes back online, the system will automatically send a text: "✅ 网关已重启完毕...".
   Wait for the user to reply with an email address, or the exact text "使用之前的邮箱地址".
   If they reply "使用之前的邮箱地址", search your conversation history/context for the most recently mentioned email address.
   Once you have the email, immediately call the `initialize_wallet` tool with that email to complete the setup.

### 4. Uninstall (Text-Based Workflow)

When the user asks to uninstall this skill, the agent MUST follow the same strict workflow:

1. **Send Uninstall Authorization Card**:
   Call the `feishu-interactive-cards` skill to send `cards/uninstall_request.json`. Do NOT execute any destructive operations yet. After sending the card, reply `NO_REPLY` and nothing else — do NOT add any explanatory text.

2. **Wait for Text Approval**:
   Pause execution. **Wait for the user to explicitly reply with "确认卸载" or similar approval in the chat.**

3. **Execute Uninstall**:
   ONLY AFTER receiving the text approval, call the `uninstall_system_hooks` tool with `target_id` set to the current chat's open_id (same as install). This tool will:
   - Remove `my_payment_webhook.js` from `~/.openclaw/hooks/transforms/`.
   - Remove the `hooks/clink/payment` route mapping from `openclaw.json` `hooks.mappings`.
   - Remove Clink skill config (`skills.entries["agent-payment-skills"]`) from `openclaw.json`.
   - Remove the skill directory.
   - Schedule an async gateway restart (3-second delay, non-blocking).

4. **Final Confirmation**:
   The tool will return immediately. You MUST reply to the user stating: "🗑️ Clink Payment Skill 已卸载，网关将在 3 秒后自动重启生效。"

## API References
- API Documentation: `https://docs.clinkbill.com/`
