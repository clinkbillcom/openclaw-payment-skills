---
name: agent-payment-skills
description: "Universal agent skill to integrate Clink payments, handling user initialization, merchant-initiated payments (auto top-ups), direct payments, and async webhook callbacks. Async notify routing uses a unified `channel + target` contract; Feishu cards remain an optional rendering layer."
version: "1.0.0"
metadata:
  openclaw:
    scriptsDir: "scripts"
    tools:
      notification_sender: "scripts/send-message.mjs"
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
    description: Execute a payment via Clink. Supports direct mode (merchant_id + amount + currency) and session mode (sessionId from merchant). merchant_integration must include server, confirm_tool, and optional confirm_args.
  - name: install_system_hooks
    description: Update `openclaw.json` and restart the gateway in the background after a 3-second delay. Triggered directly by the install workflow with no extra text authorization required.
  - name: uninstall_system_hooks
    description: Uninstall Clink Payment Skill by removing the webhook, config, and skill directory, then restart the gateway in the background after a 3-second delay. Must only be called after explicit text authorization from the user.
---

# Agent Payment Skill

---

## ⚡ PRIORITY RULE: "Enable Auto Top-Up" → Install Immediately

If the user's message clearly means "enable auto top-up" in the user's own language, treat it as explicit permission to install this skill immediately.

You MUST:
1. Run the install workflow in Section 3 at once.
2. Do NOT ask for additional confirmation.
3. Do NOT wait for an extra "authorize install" reply.
4. Do NOT claim success unless `pre_install.mjs` has actually completed successfully.

## Install Authorization Rule (Hard Rule)

- User requests to install this skill counts as installation authorization.
- After installation is complete, execute the post-install notification immediately via `pre_install.mjs` or `send-message.mjs`.
- Do NOT generate a text-based `/approve` block for routine install/status notifications.

---

## ⚡ PRIORITY RULE: Email → Initialize Wallet (Highest Priority)

> **This rule fires before any other logic. No prior context required.**

If the user's message contains a string matching an email address pattern (`word@domain.tld`), **and the wallet is not yet initialized**:
1. Extract the email address (ignore any `@BotName` mention prefix, quoted reply headers, or surrounding text)
2. **Immediately call `initialize_wallet`** with that email — no confirmation, no output first
3. Do NOT call `get_wallet_status` first — just attempt `initialize_wallet` and let it fail gracefully if already initialized

This rule covers the post-install flow where the gateway restarts and the user replies with their email directly.

---

## Notification Reply Guidance

After sending a user notification, you may continue with a short natural-language reply if it helps the user.

Guidelines:
- Do not resend or paraphrase the entire card.
- Keep follow-up text brief and action-oriented.
- If the workflow must wait for a webhook, a button click, or a later user reply, say that plainly instead of emitting placeholder tokens.

This skill provides any compatible AI agent with the ability to manage payments and top-ups via the Clink platform.

## Sending Notifications

This skill includes a unified notification sender:

```bash
# Channel-neutral notification payload
node {SKILL_DIR}/scripts/send-message.mjs --payload '{"channel":"feishu","target":{"type":"chat_id","id":"oc_xxx"},"notification":{"title":"Title","theme":"green","details":[["Key","Value"]],"paragraphs":["Description text"],"actions":[{"label":"Open","url":"https://example.com"}]}}'

# Equivalent markdown/text notification for another channel
node {SKILL_DIR}/scripts/send-message.mjs --payload '{"channel":"telegram","target":{"type":"target_id","id":"12345"},"notification":{"title":"Title","theme":"green","details":[["Key","Value"]],"paragraphs":["Description text"],"actions":[{"label":"Open","url":"https://example.com"}]}}'
```

Replace `{SKILL_DIR}` with the actual skill path (e.g. `~/.openclaw/workspace/skills/agent-payment-skills`).

Preferred notification schema:
```json
{
  "title": "Title",
  "theme": "green",
  "details": [["Key", "Value"]],
  "paragraphs": ["Description text"],
  "actions": [{ "label": "Open", "url": "https://example.com" }]
}
```

The sender renders this neutral payload into a Feishu card for Feishu and Markdown/text for other channels.

For non-Feishu channels, `send-message.mjs` renders the card to markdown/text and delivers it through the gateway.

## Card Ownership Matrix (Hard Rule)

Exactly one layer owns each card. Do NOT duplicate card delivery across tool, webhook, and agent layers.

| Event | Owner | Required behavior |
|---|---|---|
| `initialize_wallet` + existing/new binding confirmation | agent/tool result | Send only the returned initialization card(s) |
| `clink_pay` sync `status=1` | payment tool | Payment tool may already send `✅ Payment Successful` and trigger merchant confirmation in the same idempotent success path; agent MUST NOT send another or re-trigger merchant confirm |
| `clink_pay` sync `status=3/4/6` | payment tool | Payment tool may already send `❌ Payment Failed` or `🛡️ Risk Rule Triggered`; agent MUST NOT send another |
| `clink_pay` sync `flag3DS=1` | agent | Agent MUST send exactly one `🔐 3DS Verification Required` card from the returned directive |
| `agent_order.succeeded` webhook | payment webhook | Webhook may send `✅ Payment Successful` only if it was not already sent |
| `agent_order.failed` webhook | payment webhook | Webhook may send failure card only if it was not already sent |
| Merchant recharge success/failure | merchant confirmation tool | Payment skill MUST NOT send merchant-layer `✅ Recharge Successful` or `❌ Recharge Failed` cards |

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

## Merchant Payment Handoff Contract

`agent-payment-skills` must remain merchant-agnostic. It must not maintain a centralized supported-merchant list in this prompt.

Every merchant skill that wants to integrate with Clink auto-pay should drive the payment flow itself and call `clink_pay` with fully prepared payment inputs.

`merchant_integration` should include:
- `server`
- `confirm_tool`
- optional `confirm_args`

The merchant confirmation tool will receive a structured `payment_handoff` object from the payment layer. That payload includes:
- `order_id`
- optional `session_id`
- `trigger_source`
- `channel`
- optional `notify_target`

**Routing rule**: When a merchant skill asks for recharge, auto top-up, or 402 recovery, the merchant skill should:
1. Call `pre_check_account`.
2. Prepare fresh payment inputs on the merchant side:
   - Direct mode: provide `merchant_id`, `default_amount`, and `currency`.
   - Session mode: provide the fresh `sessionId` produced by the merchant flow.
3. Call `clink_pay` with the prepared payment inputs plus `merchant_integration`.
   - If the user explicitly specified an amount, use that amount.
   - If triggered automatically (402 / low-balance) and the user did not override the amount in the current turn, use the exact merchant default.
4. After `clink_pay` returns, follow the tool return contract only:
   - If the result indicates `DIRECT_SEND`, do NOT send a duplicate payment card.
   - If the result indicates `EXEC_REQUIRED`, execute it exactly once.
   - If the result indicates `WAIT_FOR_WEBHOOK`, wait.
5. Merchant recharge confirmation MUST be triggered only by the payment layer handoff that owns that event (sync direct-send success or `agent_order.succeeded` webhook fallback). For sync `status=1`, payment-success card delivery and merchant-confirm handoff belong to the same idempotent success path.
6. After merchant recharge is confirmed by the merchant's declared confirmation tool, automatically resume the interrupted merchant task. Do NOT wait for further user instruction.

`clink_pay` is the low-level payment executor. It should not discover merchant tools, fetch merchant config, guess merchant routing, or own merchant orchestration logic. When it hands success off to the merchant confirmation tool, it sends a structured `payment_handoff` payload instead of ad hoc top-level fields.

## Notify Destination Contract

Async routing metadata is stored in one unified shape:

```json
{
  "notifyDestination": {
    "channel": "feishu",
    "target": {
      "type": "chat_id",
      "id": "oc_xxx"
    }
  }
}
```

`initialize_wallet`, `install_system_hooks`, and `uninstall_system_hooks` may accept an optional notify destination using:
- `channel`
- `target_id`
- `target_type`

Current scope:
- `payment_handoff.channel` should mirror the active notify destination channel when one is available.
- `payment_handoff.notify_target` uses the same `{type,id}` shape across channels. For Feishu, `type` is `chat_id` or `open_id`; for other channels it is usually `target_id`.
- `initialize_wallet`, `install_system_hooks`, and `uninstall_system_hooks` accept the unified notify destination contract.

## Instructions & Workflows

Shell examples below assume:

```bash
MCPORTER_CONFIG_PATH="${OPENCLAW_HOME:-$HOME}/.openclaw/config/mcporter.json"
```

### 1. Initialization (Runs once per user)
When a user installs or uses this skill for the first time:
1. **Request Email:** Prompt the user to input their email address.
2. **Initialize Wallet:** Call `initialize_wallet` with the user's email. This only bootstraps the Clink account — it does NOT complete initialization.
   If calling via shell (do NOT omit --args):
   ```
   npx mcporter --config "$MCPORTER_CONFIG_PATH" call agent-payment-skills initialize_wallet --args '{"email":"<USER_EMAIL>"}'
   ```
   You may also include optional notify routing fields `channel`, `target_id`, and `target_type` so later async events can route back to the current conversation.
3. **Check Payment Method:** Call `get_binding_link` to check if a payment method exists.
   If calling via shell:
   ```
   npx mcporter --config "$MCPORTER_CONFIG_PATH" call agent-payment-skills get_binding_link --args '{}'
   ```
   - If none → the user gets a card with a link to bind one. **Wait for the `payment_method.added` webhook callback** before proceeding.
   - If exists → skip to step 4.
4. **View Risk Rules (Optional):** Call `get_risk_rules_link` to let the user view and optionally configure risk rules. This step is NOT required — initialization is complete once a payment method is bound. Risk rules can be configured at any time.
   If calling via shell:
   ```
   npx mcporter --config "$MCPORTER_CONFIG_PATH" call agent-payment-skills get_risk_rules_link --args '{}'
   ```
5. **Send Initialization Complete Card:** Once payment method is confirmed (either already existed or `payment_method.added` webhook received), send the "🎉 Clink Setup Complete!" card. Do NOT wait for risk rules.

### 2. Execute Payment (Direct or Auto Top-Up)
When the user requests a recharge or another skill triggers an auto top-up:
1. **Pre-Check:** Call `pre_check_account` to verify the account is ready. Do NOT send any "🔍 Clink Account Check Passed" card when this check passes.
   If calling via shell (do NOT omit --args):
   ```
   npx mcporter --config "$MCPORTER_CONFIG_PATH" call agent-payment-skills pre_check_account --args '{}'
   ```
   - If pre-check fails (no card bound, wallet not initialized), follow the prompts to fix the issue before proceeding.
2. **Execute Payment:** The merchant skill must call `clink_pay` directly with fully prepared payment inputs plus `merchant_integration`.
   If calling via shell (do NOT omit --args, replace placeholders):
   ```
   # Direct mode:
   npx mcporter --config "$MCPORTER_CONFIG_PATH" call agent-payment-skills clink_pay --args '{"merchant_id":"<MERCHANT_ID>","amount":<AMOUNT>,"currency":"USD","merchant_integration":{"server":"<MERCHANT_SERVER>","confirm_tool":"<CONFIRM_TOOL>","confirm_args":{}}}'
   # Session mode:
   npx mcporter --config "$MCPORTER_CONFIG_PATH" call agent-payment-skills clink_pay --args '{"sessionId":"<SESSION_ID>","merchant_integration":{"server":"<MERCHANT_SERVER>","confirm_tool":"<CONFIRM_TOOL>","confirm_args":{}}}'
   ```
3. **After `clink_pay` returns:** Follow the tool return contract only. Do NOT synthesize extra payment cards.
4. **Webhook ownership rule:** Pending / 3DS flows wait for async webhook fallback; sync `status=1` success should already hand off merchant confirmation inside the payment tool success path:
   - `agent_order.succeeded` → Payment webhook may send `✅ Payment Successful` if needed, then hand off merchant confirmation only when the sync path did not already complete that handoff
   - `agent_order.failed` → Payment webhook may send payment-layer failure feedback if needed
   - `flag3DS=1` (synchronous) → Agent sends exactly one `🔐 3DS Verification Required` card, then waits for webhook
5. **Handle Failures:**
   - Card declined → Send switch payment method card. After receiving `payment_method.defaultChange` webhook, inform the user the new card is active and **ask if they want to retry the payment**. Do NOT retry automatically.
   - Email mismatch → Show the security block card. Do NOT retry.
   - Risk rule triggered → Show options (override / modify rules / pause).

### 2.5 Payment Method Management
When the user asks to view or manage their payment methods:
1. **Show Current Status:** Call `get_binding_link` to display current payment method and email as an informational card.
2. **Open Management Page:** Call `get_payment_method_modify_link` to generate the management URL. Send a "⚙️ Payment Method Management" card with the link.
3. **Confirm Update:** After the user returns from the external page, send a "✅ Payment Method Updated" card showing:
   - Current payment method: updated ✓
   - Notification email: confirmed ✓
   - Risk rules: unchanged ✓

### 3. Post-Installation Setup (Strict Single-Step Workflow)

When the user asks to install this skill, the agent MUST follow this exact workflow:

1. **Run pre-install immediately**
   Registers MCP, writes config, verifies the route write, spawns the post-restart notify process, and sends the status notification in one command:
   - **Feishu group chat:** `node {SKILL_DIR}/scripts/pre_install.mjs --channel feishu --target-id {current_feishu_chat_id} --target-type chat_id`
   - **Feishu direct message:** `node {SKILL_DIR}/scripts/pre_install.mjs --channel feishu --target-id {current_feishu_open_id} --target-type open_id`
   - **Other channels:** `node {SKILL_DIR}/scripts/pre_install.mjs --channel <CHANNEL> --target-id <TARGET_ID> --target-type <TARGET_TYPE>`

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
   - `Webhook route is ready`
   - `Installation completed`
   - `Wallet initialization can begin`
   - `The post-restart notification is definitely configured successfully`

   A delayed card or notify log entry alone is NOT sufficient proof that installation completed correctly.

### 4. Uninstall (Text-Based Workflow)

When the user asks to uninstall this skill, the agent MUST follow the same strict workflow:

1. **Send Uninstall Authorization Card**:
   - Send exactly one uninstall authorization notification appropriate for the current channel.
   - Feishu may use the existing uninstall card payload. Other channels should receive equivalent markdown/text: "⚠️ Uninstall will perform the following irreversible actions: remove the webhook interceptor, clear configuration, delete the skill directory, and restart the gateway.\n\nReply with \"Confirm uninstall\" to proceed."
   - Do NOT execute any destructive operations yet. After sending the notification, you may add a short natural-language reminder that uninstall is waiting for text confirmation.

2. **Wait for Text Approval**:
   Pause execution. **Wait for the user to explicitly reply with "Confirm uninstall" or similar approval in the chat.**

3. **Execute Uninstall**:
   ONLY AFTER receiving the text approval, call the `uninstall_system_hooks` tool with the current notify destination if available (`channel`, `target_id`, `target_type`). If omitted, the tool may fall back to the cached notify destination from install/init. Do NOT manually run `mcporter config remove`, edit `openclaw.json`, `rm -rf` the skill directory, or try to send the final card yourself via local files. The tool owns the full uninstall sequence and keeps the delete-self step last. This tool will:
   - Remove `my_payment_webhook.js` from `~/.openclaw/hooks/transforms/`.
   - Remove the `hooks/clink/payment` route mapping from `openclaw.json` `hooks.mappings`.
   - Remove Clink skill config (`skills.entries["agent-payment-skills"]`) from `openclaw.json`.
   - Unregister the MCP server from `mcporter --config "$MCPORTER_CONFIG_PATH"`.
   - Remove the skill directory.
   - Schedule an async gateway restart (3-second delay, non-blocking).

4. **Final Confirmation**:
   The tool will return immediately. You MUST send a "🗑️ Clink Payment Skill Uninstall In Progress" notification to the user stating that uninstall is in progress and the gateway will automatically restart after the uninstall completes.

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

## API References
- API Documentation: `https://docs.clinkbill.com/`
