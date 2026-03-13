---
name: agent-payment-skills
description: Universal agent skill to integrate Clink payments, handling user initialization, merchant-initiated payments (auto top-ups), direct payments, and async webhook callbacks (3DS, Risk, Success/Fail).
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
---

# Agent Payment Skill

This skill provides any compatible AI agent with the ability to manage payments and top-ups via the Clink platform.

## Instructions & Workflows

### 1. Initialization (Runs once per user)
When a user installs or uses this skill for the first time:
1. **Request Email:** Prompt the user to input their email address.
2. **Initialize Wallet:** Call `initialize_wallet` with the user's email. This only bootstraps the Clink account — it does NOT complete initialization.
3. **Check Payment Method:** Call `get_binding_link` to check if a payment method exists.
   - If none → the user gets a card with a link to bind one. **Wait for the `card.added` webhook callback** before proceeding.
   - If exists → skip to step 4.
4. **Configure Risk Rules:** Call `get_risk_rules_link` to prompt the user to set risk rules. Since the risk rules page does NOT send a webhook callback, ask the user to confirm when they are done.
5. **Send Initialization Complete Card:** Only after BOTH payment method and risk rules are confirmed, send the final "🎉 Clink 初始化完成！" card showing:
   - Bound payment method ✓
   - Risk rule settings
   - Status: 已生效

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
   - Card declined → Send switch payment method card. After user switches, **automatically retry** `clink_pay`.
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

### 3. Post-Installation Setup (Agent Must Execute)

When the user asks to install this skill and the repository has been cloned successfully, the primary agent **must proactively help the user** finish the webhook setup and install required dependencies. Follow these steps exactly inside the sandbox:

1. **Install Required Dependency Skill**:

   This skill relies on interactive cards to communicate payment statuses and links. You MUST ask the user to install the Feishu Interactive Cards skill:
   "To display payment links and receipts as interactive cards, we need to install a helper skill. Can I install it for you now?"

   If approved, execute: `/skill install https://github.com/openclaw/skills/tree/main/skills/leecyang/feishu-interactive-cards`

2. **Copy the webhook transform automatically**:

   Use the `exec` tool to copy `hooks/my_payment_webhook.js` from this skill directory into `~/.openclaw/hooks/transforms/`.

   Reference command: `cp {baseDir}/hooks/my_payment_webhook.js ~/.openclaw/hooks/transforms/`

3. **Request approval to modify global config**:

   Send the user this confirmation message:
   "I have prepared the payment callback script. The next step is to write the callback route into the system `openclaw.json`. Do you allow me to make that change?"

4. **Apply the config change**:

   Once the user approves, use the system `/config set` command or `jq` to safely merge the following JSON node into the `hooks.mappings` array:

   `{"match": {"path": "my_payment"}, "transform": {"module": "my_payment_webhook.js"}}`

5. **Request restart approval and finish deployment**:

   Explain this to the user:
   "The webhook route has been written into the configuration successfully. Because this changes infrastructure-level network routing, OpenClaw Gateway must be restarted before it takes effect. The restart will briefly interrupt the current chat for about 3 seconds. Do you want me to restart it now?"

   If the user agrees, use `exec` to run `openclaw gateway restart` and complete the deployment.

## API References
- API Documentation: `https://docs.clinkbill.com/`
