---
name: openclaw-payment-skills
description: "OpenClaw payment skill for Clink wallet setup, payment-method management, merchant-initiated payments, refunds, VIC authorization, and async completion through a clink-cli event-polling event pump. Also triggers for purchase/book/order intents that should route to VIC when the current card is Visa. Async notify routing uses a unified channel + target contract; Feishu uses native cards, Telegram uses rich text/media delivery, and other channels fall back to markdown/text."
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
    description: Run once per user. Requests email, runs the Clink wallet bootstrap via clink-cli, persists credentials, and starts the mailbox event pump.
  - name: get_wallet_status
    description: Check the local configuration status of the wallet (e.g., if it is initialized).
  - name: get_binding_link
    description: Generates a URL for the user to bind a new payment method and returns currently bound methods. If no methods exist, returns a setup link; if methods exist, returns an informational card with current card details. You MUST always provide channel, target_id, and target_type from the current conversation metadata to ensure the notification is delivered to the correct surface.
  - name: get_risk_rules_link
    description: Generates a URL for the user to configure recharge risk rules (per-charge limit, daily limit, frequency, cooldown, approval threshold). You MUST always provide channel, target_id, and target_type from the current conversation metadata to ensure the link is delivered to the correct surface.
  - name: get_payment_method_setup_link
    description: Generates a URL for the user to add a new payment method (credit card, PayPal, Cash App, etc.). You MUST always provide channel, target_id, and target_type from the current conversation metadata to ensure the link is delivered to the correct surface.
  - name: get_payment_method_modify_link
    description: Generates a URL for the user to manage, switch, or modify existing payment methods. You MUST always provide channel, target_id, and target_type from the current conversation metadata to ensure the link is delivered to the correct surface.
  - name: pre_check_account
    description: Run before clink_pay to verify account readiness and resolve the current/default card. For purchase/book/order intents, prefer prepare_visa_purchase_instruction; if this pre-check finds a Visa card, it routes the agent back to that state machine instead of normal charge.
  - name: clink_pay
    description: Execute a non-Visa payment via Clink. Supports direct mode (merchant_id + amount + currency) and session mode (sessionId from merchant). Visa cards are gated into the VIC registration / purchase-instruction flow instead of normal charge. merchant_integration must include server, confirm_tool, and optional confirm_args.
  - name: clink_refund
    description: Apply for a NEW full refund on an existing Clink order. Requires the ORIGINAL `orderId` (starts with `order_`). Do NOT use this tool for checking the status of an existing refund request.
  - name: get_refund_status
    description: Query the latest status of an ALREADY SUBMITTED Clink refund order via `refundOrderId` (starts with `rfd_`). Use this tool when the user asks for the "status" or "progress" of a refund.
  - name: prepare_visa_purchase_instruction
    description: "VIC state machine: primary entrypoint for purchase/book/order intents. Resolves the current/default card; if it is Visa, handles VIC registration or lists ACTIVE instructions filtered by paymentInstrumentId and reuses/creates a draft. Always provide fulfillmentType. Use PHYSICAL_GOODS_REQUIRES_SHIPPING plus a US shippingAddress only for shipped physical goods; use NO_SHIPPING_REQUIRED for hotels, tickets, services, subscriptions, digital goods, bookings, and reservations. Use this instead of manually chaining pre_check_account, list_purchase_instructions, and create_purchase_instruction. After it creates a draft it returns a Passkey authorization URL; the user signs on that page (the skill never calls a backend sign API)."
  - name: list_purchase_instructions
    description: "VIC: list the current customer's purchase instructions, optionally filtered by status and paymentInstrumentId. For a selected Visa card, pass status=ACTIVE and that exact paymentInstrumentId before creating a new draft."
  - name: get_purchase_instruction_manage_link
    description: "VIC: when the user asks to 修改授权 查看授权 取消 instruction 授权, or semantically similar manage/view/edit/cancel authorization requests, return the agent UI origin derived from the configured Clink environment (https://agent.clinkbill.com in production, https://agent.clinkbill.dev in sandbox) as the authorization management link."
  - name: install_system_hooks
    description: Save notify routing, refresh the event pump when usable wallet credentials are available, and restart the gateway in the background after a 3-second delay. MCP registration is performed by `pre_install.mjs`.
  - name: uninstall_system_hooks
    description: Uninstall Clink Payment Skill by stopping the event pump and removing config, cache, and any legacy webhook artifacts, then restart the gateway in the background after a 3-second delay. Must only be called after explicit text authorization from the user.
---

# Agent Payment Skill

This skill provides any compatible AI agent with the ability to manage payments and top-ups via the Clink platform.

---

## 1. Triggering & Routing Rules

Evaluate these rules in order. The first matching rule decides the route.

### 1.1 ⚡ Email → Initialize Wallet (Highest Priority)

> **This rule fires before any other logic. No prior context required.**

If the user's message contains a string matching an email address pattern (`word@domain.tld`), **and the wallet is not yet initialized**:
1. Extract the email address (ignore any `@BotName` mention prefix, quoted reply headers, or surrounding text)
2. **Immediately call `initialize_wallet`** with that email — no confirmation, no output first. Include the current `channel`, `target_id`, and `target_type` when the runtime exposes them; otherwise let the tool use the cached notify destination if present.
3. Do NOT call `get_wallet_status` first — just attempt `initialize_wallet` and let it fail gracefully if already initialized

This rule covers the post-install flow where the gateway restarts and the user replies with their email directly.

### 1.2 ⚡ Explicit Clink Payment Setup Intent → Install Immediately

If the user's message clearly asks to install this skill, install Clink Payment Skills, set up a Clink payment wallet, bind a payment method for Clink payments, or enable Clink/payment auto top-up for this payment skill, treat it as explicit permission to install this skill immediately.

Do NOT trigger this rule for a generic merchant-level request such as "Enable auto top-up" unless the same message also clearly refers to Clink, payment setup, wallet, card binding, payment method, or this skill by name.

You MUST:
1. Run the install workflow in Section 3.1 at once.
2. Do NOT ask for additional confirmation.
3. Do NOT wait for an extra "authorize install" reply.
4. Do NOT claim success unless `pre_install.mjs` has actually completed successfully.

**Install Authorization Rule (Hard Rule):**
- User requests to install this skill counts as installation authorization.
- After installation is complete, execute the install success notification immediately via `pre_install.mjs` or `send-message.mjs`.
- Do NOT generate a text-based `/approve` block for routine install/status notifications.

### 1.3 ⚡ Current Visa Card + Purchase Intent → VIC Instruction Flow

If the user message contains a purchase intent and the current/selected/default payment method is a Visa card, this skill owns the payment authorization part of the request even when the message does not mention Visa, Clink, wallet, or this skill by name.

If the current payment method is not already known in the conversation, `prepare_visa_purchase_instruction` resolves the selected/default payment method inside the state machine before deciding whether the VIC flow applies.

Purchase intent signals include: `buy`, `purchase`, `order`, `book`, `reserve`, `下单`, `购买`, `预订`, `订酒店`, `买票`, or equivalent wording that asks the agent to acquire goods, services, bookings, tickets, reservations, or merchant value for the user.

When this rule fires:
1. Do not answer only that the merchant booking plugin is missing. Preserve the merchant task as the business intent, but route the payment authorization through VIC first.
2. Call `prepare_visa_purchase_instruction` as the primary entrypoint once the spend scope is complete enough to express a mandate. Do not manually chain `pre_check_account`, `list_purchase_instructions`, and `create_purchase_instruction` for this primary purchase path.
3. The state machine resolves the selected/default/current payment method. If it is not Visa, it returns `state=NON_VISA`; use the normal non-Visa payment route when payment inputs are ready.
4. If the selected/default/current Visa card has `visaRegistrationSucceeded !== true`, the state machine starts VIC registration and waits for the same `paymentInstrumentId` to become VIC-ready.
5. If the selected/default/current Visa card has `visaRegistrationSucceeded=true`, the state machine lists ACTIVE purchase instructions with `status=ACTIVE` and the selected card's exact `paymentInstrumentId`. It reuses a matching ACTIVE instruction when possible; otherwise it creates an instruction draft. The model must not call `create_purchase_instruction` before this state machine list step.
6. If the merchant booking plugin is missing, still complete the VIC authorization preparation first. Do NOT ask the user for a payment link, payment URL, 代付链接, Session ID, or tell them to use the merchant app before this VIC routing step.
7. If the exact spend scope is incomplete, ask only for the missing mandate fields needed to create the instruction draft, such as amount limit, currency, merchant/category, expiry, or purchase constraints. Do not invent mandates, limits, merchant identity, booking details, or prices. If the user already supplied merchant/merchant class, amount limit, currency, and timing constraints, the scope is complete enough to list and then create a draft.
8. Before calling `prepare_visa_purchase_instruction`, classify fulfillment explicitly with `fulfillmentType`.
   - Use `PHYSICAL_GOODS_REQUIRES_SHIPPING` only for shipped physical goods. Collect a US shipping address before draft creation and pass `shippingAddress`; `shippingAddress.countryCode` must be `US`.
   - Use `NO_SHIPPING_REQUIRED` for services, subscriptions, hotels, tickets, bookings, reservations, and digital goods that do not ship a physical item.
   - If it is unclear whether the purchase ships physical goods, use `UNKNOWN` only long enough to ask the user to clarify. The state machine will not list or create an instruction while fulfillment is unknown.
9. Do NOT call clink_pay for Visa. Normal `clink_pay` remains only for non-Visa payment methods or explicitly non-VIC routes.

See Section 3.4 for the full VIC workflow, the instruction matching rule, and payload examples.

### 1.4 Instruction Authorization Management Link

If the user asks to 修改授权, 查看授权, 取消 instruction 授权, manage instruction authorization, view instruction authorization, edit instruction authorization, cancel instruction authorization, or uses semantically similar wording for purchase instruction authorization management, call `get_purchase_instruction_manage_link`.

This returns the agent UI origin derived from the configured Clink environment (`https://agent.clinkbill.com` in production, `https://agent.clinkbill.dev` in sandbox). In Feishu it is delivered as a button through the normal notification renderer; in other channels it is shown as a link. Do not ask the user for `appInstance` or `authResult` for this user-facing management intent — viewing, editing, and cancelling authorization all happen on that agent page.

### 1.5 Routing Boundary Rule (Hard Rule)

Route generic auto-top-up language by product ownership, not by keyword alone.

- Merchant-skill context wins for generic phrases such as "Enable auto top-up", "开启自动充值", or equivalent wording in the user's language.
- `agent-payment-skills` owns the request only when the same turn clearly refers to Clink, payment setup, wallet initialization, card binding, payment method management, payment confirmation, or this skill by name.
- Do NOT hijack a merchant-owned request just because it contains a generic auto-top-up phrase.
- If a merchant skill installs `agent-payment-skills` as a dependency, complete the payment-skill setup work, then let the merchant skill resume and own the original merchant intent.

---

## 2. Hard Rules

### 2.1 Card Ownership Matrix

Exactly one layer owns each card. Do NOT duplicate card delivery across tool, event pump, and agent layers.

| Event | Owner | Required behavior |
|---|---|---|
| `initialize_wallet` + existing/new binding confirmation | agent/tool result | Send only the returned initialization card(s) |
| `clink_pay` sync `status=1` | payment tool | Payment tool may already send `✅ Payment Successful` and trigger merchant confirmation in the same idempotent success path; agent MUST NOT send another or re-trigger merchant confirm |
| `clink_pay` sync `status=3/4/6` | payment tool | Payment tool may already send `❌ Payment Failed` or `🛡️ Risk Rule Triggered`; agent MUST NOT send another |
| `clink_pay` sync `flag3DS=1` | agent | Agent MUST send exactly one `🔐 3DS Verification Required` card from the returned directive |
| `clink_refund` submission success | payment tool | Payment tool may already send `⏳ Refund Request Submitted`; agent MUST NOT send a duplicate submission card |
| `agent_refund.succeeded/approved` event | event pump | The event pump owns the final success notification for the refund lifecycle |
| `agent_refund.failed/rejected` event | event pump | The event pump owns the final failure notification for the refund lifecycle |
| `agent_order.succeeded` event | event pump | The event pump may send `✅ Payment Successful` only if it was not already sent, then trigger merchant confirmation |
| `agent_order.failed` event | event pump | The event pump may send the failure card only if it was not already sent |
| Merchant recharge success/failure | merchant confirmation tool | Payment skill MUST NOT send merchant-layer `✅ Recharge Successful` or `❌ Recharge Failed` cards |

### 2.2 Tool Return Contract

- `DIRECT_SEND`
  - Meaning: the tool has already sent the card itself
  - Agent MUST NOT send a second semantic-equivalent card
- `EXEC_REQUIRED`
  - Meaning: the tool explicitly returned a card exec directive
  - Agent MUST execute it exactly once
- `DATA_ONLY`
  - Meaning: the tool returned data only; no notification was sent
  - Agent may use the data to construct the next required response

Tool output may also include a `[PAYMENT_FSM] state=<STATE> action=<ACTION> reason=<REASON>` marker. The FSM action refines the directive above:

| FSM action | Required behavior |
|---|---|
| `WAIT_EVENT_PUMP` | Payment was submitted but is not terminal. Do not block, re-poll, retry, or claim completion; tell the user the final result will arrive through the event pump. |
| `SEND_3DS_AND_WAIT_EVENT` | Execute the returned 3DS notification exactly once, then wait for `agent_order.succeeded/failed` from the event pump. |
| `NOTIFY_SUCCESS_AND_CONFIRM_MERCHANT` | Treat the payment tool as the owner of the success card and merchant confirmation handoff. Do not re-send or re-confirm. |
| `NOTIFY_FAILURE_STOP` | Treat the payment tool as the owner of the failure/risk card. Stop the payment path unless the user explicitly chooses a recovery action. |
| `VERIFY_BEFORE_RETRY` | Payment state is unknown. Do not retry from memory; verify through an idempotent status path, event-pump result, or merchant-provided recovery contract first. |
| `ASK_WALLET_SETUP` | Wallet/config setup is missing. Ask for the required setup; do not run `clink_pay`. |
| `SURFACE_ERROR` | Surface the tool error briefly and stop. Do not synthesize success, failure, or retry semantics. |

### 2.3 Control Loop / FSM Contract

Every payment workflow follows this loop:

`Observe → Classify → Act → Verify → Persist`

1. **Observe:** Read only the current tool result, event-pump event, or local cache. Do not infer state from prior chat memory alone.
2. **Classify:** Use `[PAYMENT_FSM]` for payment tool output and the event-pump `event_fsm` classification for mailbox events.
3. **Act:** Perform exactly one owner-approved action from the card ownership matrix and FSM action table.
4. **Verify:** A workflow becomes complete only after a terminal sync result (`status=1` or terminal failure) or the matching event-pump event. A user returning from an external page is not proof.
5. **Persist:** Event hooks update `clink.config.json` before dependent local state is used for follow-up decisions. Never advance to the next state from memory if cache/event evidence is missing.

### 2.4 Async Completion Model

Operations that complete asynchronously (payment-method binding/change, risk-rule update, order payment, refund lifecycle, VIC registration, purchase-instruction activation) are NOT polled by the agent. A single background process — the mailbox event pump (`scripts/event-pump.mjs`) — long-polls the Clink agent mailbox via `clink-cli events poll`, delivers the completion notification, and updates the local cache.

This means:

- After a tool returns `DIRECT_SEND` (e.g. a binding/setup/modify link or a refund submission), the agent informs the user that the action is pending and does NOT block, re-poll, or fabricate a completion. The event pump delivers the result when it arrives.
- The agent MUST NOT claim an async flow is complete until the corresponding event-pump notification has been delivered.
- Order payment via `clink_pay` is synchronous in the tool response for the immediate `status`/`flag3DS` outcome; the agent follows the returned directive exactly. The final `agent_order.succeeded/failed` (including after 3DS) is delivered by the event pump.
- Backend acknowledgement of consumed mailbox events is owned by `clink-cli events poll`. The payment skill does not call an ack API directly; it keeps local idempotency with processed event sequence tracking.

### 2.5 Event Hook → Local Cache Update Matrix

When the event pump receives one of these event types, it must treat the event handler as the hook for local-state mutation and notification ownership. If a row updates `clink.config.json`, update the local state before notifying or before using that state for the next workflow decision, except for explicit send-state locks that are written immediately after a successful send.

| Event type | Local state update | Notification / next action owner |
|---|---|---|
| `payment_method.added` | Upsert `paymentMethods`, mark wallet initialized, update default/payment-method fields when present | Event pump sends `payment.method.bound_success`; on first card it may also send `wallet.initialized_complete` |
| `payment_method.updated` / `payment_method.update` | Upsert the payment method in `clink.config.json`; detect Visa registration-ready transition | Cache-only unless it completes Visa readiness, then event pump sends `payment.vic_registration_complete` |
| `payment_method.default_change` | Set `defaultPaymentMethodId` and mark only that method as default | Event pump sends `payment.method.default_changed_webhook` |
| `risk_rule.updated` | Replace cached `riskRules` | Event pump sends `risk_rule.updated` |
| `purchase_instruction.activated` | Mark the target Visa/payment-instrument flow as VIC-ready in `paymentFlowStates` | Event pump sends `payment.vic_registration_complete` |
| `vic_device.binding_succeeded` | Mark the target Visa/payment-instrument flow as VIC-ready in `paymentFlowStates` | Event pump sends `payment.vic_registration_complete` |
| `agent_order.succeeded` | Use local order-card state to de-duplicate payment success and merchant confirmation | Event pump sends payment success only if needed, then triggers merchant confirmation exactly once |
| `agent_order.failed` | Clear pending merchant confirmation and record payment-failure send state | Event pump sends the payment-layer failure notification |
| `agent_refund.succeeded` / `agent_refund.approved` | Read cached card/notify context; no merchant confirmation | Event pump sends final refund success/approved notification |
| `agent_refund.failed` / `agent_refund.rejected` | Read cached card/notify context; no merchant confirmation | Event pump sends final refund failed/rejected notification |

Unknown events are log-only. Do not invent a new workflow from an unknown event type until the FSM and this matrix are updated.

### 2.6 Amount Selection Rule

There are only two valid amount sources for `clink_pay`:

1. User override
   - If the user explicitly provides a concrete recharge amount in the current turn, you MUST use that amount.
   - This user-specified amount overrides the merchant default.

2. Merchant default (Direct Mode)
   - In Direct Mode, if the user does not explicitly provide a concrete amount in the current turn, you MUST use the exact `default_amount` returned by the merchant's payment-config tool.
   - In Session Mode, the amount is already bound to the `sessionId`. You MUST NOT provide an `amount` parameter.

You MUST NOT invent a third amount from memory, prior turns, habit, or judgment.
You MUST NOT replace the merchant default with `1`, `5`, or any other arbitrary amount unless the user explicitly asked for that amount in the current turn.

### 2.7 Prohibited Behaviors

- Do NOT send the same semantic card twice for the same `order_id`.
- Do NOT send a payment-layer success/failure card after a tool or the event pump already direct-sent it.
- Do NOT treat a refund submission card as a final refund result.
- Do NOT start merchant recharge confirmation from agent memory alone; follow the current tool/event-pump ownership rule.
- Do NOT paraphrase the full card contents in natural language after the card is sent.
- Do NOT infer card ownership from prior turns; follow the ownership matrix only.

---

## 3. Workflows

Shell examples below assume:

```bash
MCPORTER_CONFIG_PATH="${OPENCLAW_HOME:-$HOME}/.openclaw/config/mcporter.json"
```

### 3.1 Install (Strict Single-Step Workflow)

The skill is pre-bundled. Do NOT run `npm install`.

When the user asks to install this skill, follow `README.md` / `README-zh.md` only:

- Use the documented install command there. In an OpenClaw runtime that can execute local scripts, this means running `node scripts/pre_install.mjs --channel <CHANNEL> --target-id <TARGET_ID> --target-type <TARGET_TYPE>` with the current notify destination. If the runtime cannot execute shell commands, show the exact manual command instead of claiming installation succeeded.
- Do not substitute a partial MCP-only setup for the documented install flow.
- Do not reintroduce `npm install`; installation must use the committed `index.bundle.mjs`.
- `pre_install.mjs` registers the MCP server, saves notify routing, schedules the gateway restart, and sends the install success notification immediately.
- `pre_install.mjs` does not install a payment webhook transform or `/hooks/clink/payment` route.
- The event pump starts idempotently when usable wallet credentials are available (after wallet initialization or an existing credential cache); do not promise async completion before that point.
- Do not trigger a second manual restart after `pre_install.mjs` succeeds.
- Installation success is notified immediately; do not wait for or promise a later restart-success card.

**Truthfulness guardrail**
   The agent MUST NOT say any of the following unless `pre_install.mjs` has actually succeeded in the current session:
   - `MCP server is registered`
   - `Installation completed`
   - `Wallet initialization can begin`
   - `A later restart-success card is definitely configured successfully`

   A delayed card or notify log entry alone is NOT sufficient proof that installation completed correctly.

### 3.2 Initialization (Runs once per user)

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
   - If none → the user gets a card with a link to bind one. The mailbox event pump delivers `payment_method.added` when binding completes; tell the user it is pending and do not block or re-poll.
   - If exists and notify routing is available → `get_binding_link` will directly send both the "Payment Method Already Bound" card and the optional risk-rules follow-up card in the same flow. Do NOT call `get_risk_rules_link` again in that turn.
   - If exists but direct notify routing is unavailable → send the returned notifications in order, then skip to step 5.
4. **View Risk Rules (Optional):** Call `get_risk_rules_link` to let the user view and optionally configure risk rules. This step is NOT required — initialization is complete once a payment method is bound. Risk rules can be configured at any time.
   If calling via shell:
   ```
   npx mcporter --config "$MCPORTER_CONFIG_PATH" call agent-payment-skills get_risk_rules_link --args '{}'
   ```
   This step is mainly for standalone "modify/view risk rules" requests or for fallback paths where `get_binding_link` could not deliver the optional risk-rules follow-up directly. The mailbox event pump delivers `risk_rule.updated` when the user changes rules on the page.
5. **Complete only after verified binding:** Once payment method is confirmed (either already existed in the current `get_binding_link` result or the `payment_method.added` event was delivered), the setup is complete. If the event pump already sent `wallet.initialized_complete`, do NOT send another setup-complete card; keep any chat follow-up brief. Do NOT wait for risk rules.

### 3.3 Execute Payment (Direct or Auto Top-Up)

When the user requests a recharge or another skill triggers an auto top-up:
1. **Pre-Check:** Call `pre_check_account` to verify the account is ready. Do NOT send any "🔍 Clink Account Check Passed" card when this check passes.
   If calling via shell (do NOT omit --args):
   ```
   npx mcporter --config "$MCPORTER_CONFIG_PATH" call agent-payment-skills pre_check_account --args '{}'
   ```
   - If pre-check fails (no card bound, wallet not initialized), follow the prompts to fix the issue before proceeding.
2. **Route by selected payment method:**
   - Non-Visa payment methods continue through `clink_pay` with fully prepared payment inputs plus `merchant_integration`.
   - Visa payment methods never use the normal charge path directly.
   - If the selected Visa payment method has `visaRegistrationSucceeded !== true`, the payment skill sends a VIC registration link once for that pending state and waits for the same `paymentInstrumentId` to appear with `visaRegistrationSucceeded=true`.
   - The VIC registration link path is `/passkey-auth/{paymentInstrumentId}?type=visa`.
   - The updated payment method list may arrive through agent refresh (`get_binding_link` or a later payment call) or through the mailbox event pump (`payment_method.added` / `payment_method.updated`, or `purchase_instruction.activated` / `vic_device.binding_succeeded` for VIC). Tell the user it is pending and do not block or re-poll.
   - Once the selected Visa payment method has `visaRegistrationSucceeded=true`, continue the VIC purchase instruction flow (Section 3.4). Do NOT call `clink_pay` for that Visa card.
3. **Execute non-Visa payment:** For non-Visa cards, call `clink_pay` directly.
   If calling via shell (do NOT omit --args, replace placeholders):
   ```
   # Direct mode:
   npx mcporter --config "$MCPORTER_CONFIG_PATH" call agent-payment-skills clink_pay --args '{"merchant_id":"<MERCHANT_ID>","amount":<AMOUNT>,"currency":"USD","merchant_integration":{"server":"<MERCHANT_SERVER>","confirm_tool":"<CONFIRM_TOOL>","confirm_args":{}}}'
   # Session mode:
   npx mcporter --config "$MCPORTER_CONFIG_PATH" call agent-payment-skills clink_pay --args '{"sessionId":"<SESSION_ID>","merchant_integration":{"server":"<MERCHANT_SERVER>","confirm_tool":"<CONFIRM_TOOL>","confirm_args":{}}}'
   ```
4. **After `clink_pay` returns:** Follow the tool return contract only. Do NOT synthesize extra payment cards.
5. **Async completion ownership (event pump):** The mailbox event pump owns async payment outcomes; the sync `status=1` success path should already hand off merchant confirmation inside the payment tool:
   - `agent_order.succeeded` → the event pump may send `✅ Payment Successful` if needed, then hand off merchant confirmation only when the sync path did not already complete that handoff
   - `agent_order.failed` → the event pump may send payment-layer failure feedback if needed
   - `flag3DS=1` (synchronous) → Agent sends exactly one `🔐 3DS Verification Required` card; the event pump delivers `agent_order.succeeded/failed` after the user completes 3DS
6. **Handle Failures:**
   - Card declined → Send switch payment method card. After the event pump delivers `payment_method.default_change`, inform the user the new card is active and **ask if they want to retry the payment**. Do NOT retry automatically.
   - Email mismatch → Show the security block card. Do NOT retry.
   - Risk rule triggered → Show options (override / modify rules / pause).

### 3.4 VIC Agentic Authorization (Purchase Instruction)

Use this for every selected Visa card before payment execution. Non-Visa cards use the normal `clink_pay` flow instead.

1. **Prepare through the state machine:** call `prepare_visa_purchase_instruction` with the user-authorized spend scope. Do not call `list_purchase_instructions` or `create_purchase_instruction` manually on this primary path.
   ```
   npx mcporter --config "$MCPORTER_CONFIG_PATH" call agent-payment-skills prepare_visa_purchase_instruction --args '{"title":"<TITLE>","fulfillmentType":"NO_SHIPPING_REQUIRED","effectiveUntilTime":"1782345600","mandates":[{"title":"Hotel","description":"Hotel","amountLimit":1000.00,"currencyCode":"USD","merchantCategoryCode":"7011","effectiveUntilTime":"1782345600"}]}'
   ```
2. **State machine outcomes:**
   - `state=NON_VISA` means the selected/default method is not Visa; continue through the normal non-Visa payment route when payment inputs are ready.
   - `state=MISSING_FULFILLMENT_TYPE` means the agent must determine whether the purchase is shipped physical goods before listing or creating instructions.
   - `state=vic_registration_required` or `state=vic_registration_pending` means the user must finish `/passkey-auth/{paymentInstrumentId}?type=visa`; wait until the refreshed payment method list shows the same `paymentInstrumentId` with `visaRegistrationSucceeded=true`.
   - `state=REUSED_ACTIVE_INSTRUCTION` means an ACTIVE instruction already matches the exact Visa card and spend scope; keep that `instructionId` in task state.
   - `state=CREATED_DRAFT` means the backend returned a CREATED draft and the tool sent a Passkey authorization card. The authorization URL must be `/passkey-auth/{paymentInstrumentId}?type=visa&instructionId={instructionId}`. The draft is not yet usable until this Passkey authorization completes.
3. **Authorize (Passkey, page-driven):** the user opens the Passkey URL `/passkey-auth/{paymentInstrumentId}?type=visa&instructionId={instructionId}` that was returned with the CREATED draft; the page completes the Passkey signature and activates the instruction. The skill does NOT call any backend sign API and never fabricates `appInstance`/`authResult`. When the user returns or asks how it is going, the mailbox event pump delivers `purchase_instruction.activated`; the instruction must be `ACTIVE` before any payment.
4. **Payment execution:** do not pass an instruction field to `clink_pay` yet. The VIC payment entry and request field are pending backend confirmation. Until that contract is confirmed, keep the `ACTIVE` instruction in task state and use the normal payment path only for non-Visa routes.

**VIC hard rules:** never create a draft without explicit user authorization; never invent mandates; signing happens on the Passkey page (never via a backend API) and the skill never fabricates `appInstance`/`authResult`; modify/cancel authorization happens on the agent management page via `get_purchase_instruction_manage_link`; an instruction must be `ACTIVE` before VIC payment execution; never send `clientReferenceId` / `channelTokenId` / `consumerId` (server-derived); the local instruction authorization reference is not payment proof.

#### Current Visa Card Purchase Matching Rule

For a scoped purchase intent where the selected/default/current payment method is a Visa card, `prepare_visa_purchase_instruction` must be the next tool call after the mandate scope is complete. Inside that state machine, the ACTIVE instruction list call uses `status=ACTIVE` and the selected card's exact `paymentInstrumentId`, for example `clink-cli instruction list --status ACTIVE --payment-instrument-id pi_123456`. Do NOT call `create_purchase_instruction` before the state machine list step, and do not ask the user for extra confirmation merely because a merchant booking plugin is unavailable.

Evaluate existing ACTIVE instructions by semantic match, not exact string equality only. A reusable instruction must satisfy:
- Same `paymentInstrumentId` as the selected Visa card. If an instruction is for another paymentInstrumentId, or its paymentInstrumentId is missing and cannot be proven to be the selected card, do not reuse it.
- An ACTIVE/non-expired mandate whose `amountLimit` is greater than or equal to the requested spend cap.
- Same `currencyCode`.
- Matching merchant/category constraints, such as hotel/lodging `merchantCategoryCode` `7011`, or title/description/preferredMerchantName that semantically covers the requested merchant and service.
- `effectiveUntilTime` covers the requested service/booking window when an expiry is present.

If no ACTIVE instruction semantically matches, the state machine creates a draft mandate based on the user-supplied scope.

For physical goods that require delivery, call `prepare_visa_purchase_instruction` with `fulfillmentType=PHYSICAL_GOODS_REQUIRES_SHIPPING` and include the user-provided US `shippingAddress`. The address shape is:

```json
{
  "fulfillmentType": "PHYSICAL_GOODS_REQUIRES_SHIPPING",
  "shippingAddress": {
    "addressId": "addr_001",
    "name": "Jim",
    "line1": "123 Market St",
    "line2": "Apt 201",
    "line3": "",
    "city": "San Francisco",
    "state": "CA",
    "zip": "94105",
    "countryCode": "US",
    "deliveryContactDetails": {}
  }
}
```

#### Worked Example

For example, if the current/default card is Visa, this request is already sufficiently scoped and must not ask for a payment link or more mandate data: `帮我下单 全季酒店 明天入住的 离 上海迪士尼最近 交通最方便的，500 元上限 CNY`.

For this exact request, when the current/default card is Visa, call `prepare_visa_purchase_instruction` with the selected scope. The state machine then resolves the card, lists ACTIVE instructions with `status=ACTIVE` and the selected Visa `paymentInstrumentId`, and creates a draft if no semantic match is returned.

For that request, after the state machine finds no semantic match, it creates a draft like:

```json
{
  "paymentInstrumentId": "<selected Visa paymentInstrumentId>",
  "title": "全季酒店住宿预订",
  "fulfillmentType": "NO_SHIPPING_REQUIRED",
  "mandates": [
    {
      "title": "Hotel Booking",
      "description": "全季酒店住宿预订，靠近上海迪士尼，交通方便，按用户要求明天入住",
      "amountLimit": 500.00,
      "currencyCode": "CNY",
      "merchantCategoryCode": "7011",
      "preferredMerchantName": "全季酒店",
      "effectiveUntilTime": "<Unix epoch seconds covering the requested stay window, e.g. 1782345600>"
    }
  ]
}
```

### 3.5 Payment Method Management

When the user asks to view or manage their payment methods:
1. **Show Current Status:** Call `get_binding_link` to display current payment method and email as an informational card.
2. **Open Management Page:** Call `get_payment_method_modify_link` to generate the management URL. If the tool direct-sent the management card, do not send a duplicate; otherwise send the returned link through the normal notification contract.
3. **Wait for evidence, not page-return:** Do NOT treat the user's return from the external page as proof that anything changed. A real update is proven only by a relevant event-pump event (`payment_method.updated`, `payment_method.update`, or `payment_method.default_change`) or by a fresh `get_binding_link` result that shows the changed method/default state.
4. **Confirm only verified changes:** If an event or refresh proves the payment method changed, briefly confirm the observed change. If no event or refreshed change is available, say the management action is still pending and the event pump will update local state when Clink emits the event.
5. **Do not claim unrelated state:** Do not say risk rules are unchanged, email is confirmed, or setup is complete unless those facts were observed in the current tool result, event, or local cache.

### 3.6 Request Refund

When the user asks to refund an existing Clink order:
1. **Require Order Context:** Collect or confirm the target `orderId`. Do NOT guess it from memory.
2. **Call `clink_refund`:** Submit the refund request with the `orderId`.
   If calling via shell (do NOT omit --args):
   ```
   npx mcporter --config "$MCPORTER_CONFIG_PATH" call agent-payment-skills clink_refund --args '{"orderId":"<ORDER_ID>"}'
   ```
   You may also include optional notify routing fields `channel`, `target_id`, and `target_type` so the later event-pump notifications can route back to the current conversation.
3. **Interpret Scope Correctly:** `clink_refund` currently applies for a full refund only. Do NOT claim partial-refund support unless the tool schema or backend API is updated.
4. **Wait For Final Result:** A successful submission only means the refund request was accepted for processing. The final refund outcome is delivered asynchronously by the mailbox event pump.
5. **Follow Event-Pump Ownership:** Final states are owned by the event pump:
   - `agent_refund.succeeded`
   - `agent_refund.approved`
   - `agent_refund.failed`
   - `agent_refund.rejected`
   Do NOT send a second semantic-equivalent card after the event-pump notification arrives.

### 3.7 Query Refund Status

When the user asks to check an existing refund:
1. **Require Refund Context:** Collect or confirm the target `refundOrderId`. Do NOT guess it from memory.
2. **Call `get_refund_status`:** Query the current refund state with the `refundOrderId` only when the user explicitly asks about refund progress/status.
   If calling via shell (do NOT omit --args):
   ```
   npx mcporter --config "$MCPORTER_CONFIG_PATH" call agent-payment-skills get_refund_status --args '{"refundOrderId":"<REFUND_ORDER_ID>"}'
   ```
3. **Return The Status Card:** The tool returns a status card for current states such as `pending_review`, `refunding`, `success`, `failed`, or `review_rejected`.
4. **Handle Missing Refunds Carefully:** If the backend returns `71160007`, tell the user the refund order was not found and ask them to confirm the refund order ID.

### 3.8 Uninstall (Text-Based Workflow)

When the user asks to uninstall this skill, the agent MUST follow the same strict workflow:

1. **Send Uninstall Authorization Card**:
   - Send exactly one uninstall authorization notification appropriate for the current channel.
   - All channels should use the unified notification payload via `send-message.mjs`, for example: `{"message_key":"uninstall.in_progress","vars":{"results":["Event pump: pending stop","Configuration: pending removal","Skill cache: pending removal","Gateway restart: pending"]}}`
   - If direct delivery is unavailable, send the equivalent markdown/text rendered from the same `message_key`; do not construct a legacy raw card payload.
   - Do NOT execute any destructive operations yet. After sending the notification, you may add a short natural-language reminder that uninstall is waiting for text confirmation.

2. **Wait for Text Approval**:
   Pause execution. **Wait for the user to explicitly reply with "Confirm uninstall" or similar approval in the chat.**

3. **Execute Uninstall**:
   ONLY AFTER receiving the text approval, call the `uninstall_system_hooks` tool with the current notify destination if available (`channel`, `target_id`, `target_type`). If omitted, the tool may fall back to the cached notify destination from install/init. Do NOT manually run `mcporter config remove`, edit `openclaw.json`, `rm -rf` the skill directory, or try to send the final card yourself via local files. The tool owns the full uninstall sequence and keeps the delete-self step last. This tool will:
   - Clear the event pump lock (`locks/event-pump.lock`); removing the cache also leaves the pump without credentials so it self-exits.
   - Remove any legacy `my_payment_webhook.mjs` from `~/.openclaw/hooks/transforms/` and any legacy `hooks/clink/payment` route mapping from `openclaw.json` `hooks.mappings`.
   - Remove Clink skill config (`skills.entries["agent-payment-skills"]`) from `openclaw.json`.
   - Unregister the MCP server from `mcporter --config "$MCPORTER_CONFIG_PATH"`.
   - Remove the skill directory.
   - Schedule an async gateway restart (3-second delay, non-blocking).

4. **Final Confirmation**:
   The tool will return immediately. You MUST send a "🗑️ Clink Payment Skill Uninstall In Progress" notification to the user stating that uninstall is in progress and the gateway will automatically restart after the uninstall completes.

---

## 4. Integration Contracts

### 4.1 Merchant Payment Handoff Contract

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
   - For pending / 3DS outcomes, the mailbox event pump delivers the final `agent_order.succeeded/failed`; tell the user it is pending and do not block or re-poll.
5. Merchant recharge confirmation MUST be triggered only by the payment layer handoff that owns that event (sync direct-send success or the event pump's `agent_order.succeeded` delivery). For sync `status=1`, payment-success card delivery and merchant-confirm handoff belong to the same idempotent success path.
6. After merchant recharge is confirmed by the merchant's declared confirmation tool, let the merchant skill continue its own success/failure and task-resume flow. Do NOT manually attempt to resume the task unless the merchant tool explicitly instructs you to.

`clink_pay` is the low-level payment executor. It should not discover merchant tools, fetch merchant config, guess merchant routing, or own merchant orchestration logic. When it hands success off to the merchant confirmation tool, it sends a structured `payment_handoff` payload instead of ad hoc top-level fields.

### 4.2 Notify Destination Contract

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

---

## 5. Notifications

### 5.1 Sending Notifications

This skill includes a unified notification sender:

```bash
# Message-key payload for Feishu
node {SKILL_DIR}/scripts/send-message.mjs --payload '{"channel":"feishu","target":{"type":"chat_id","id":"oc_xxx","locale":"zh-CN"},"message_key":"payment.method.setup_link","vars":{"email":"user@example.com","setupUrl":"https://example.com/setup"}}'

# Same message delivered to another channel with locale auto-resolution
node {SKILL_DIR}/scripts/send-message.mjs --payload '{"channel":"telegram","target":{"type":"target_id","id":"12345","locale":"en-US"},"message_key":"payment.method.setup_link","vars":{"email":"user@example.com","setupUrl":"https://example.com/setup"}}'
```

Replace `{SKILL_DIR}` with the actual skill path (e.g. `~/.openclaw/workspace/skills/agent-payment-skills`).

Preferred message schema:
```json
{
  "message_key": "payment.method.setup_link",
  "locale": "auto",
  "vars": {
    "email": "user@example.com",
    "setupUrl": "https://example.com/setup"
  },
  "delivery_policy": {
    "prefer_rich": true,
    "allow_fallback": true
  }
}
```

The sender resolves locale, compiles the message catalog entry into a neutral content model, then renders it into a Feishu card for Feishu, rich Telegram text/media for Telegram, and Markdown/text for other channels.

For channels without rich-card support, `send-message.mjs` renders Markdown/text and delivers it through the gateway.

### 5.2 Notification Reply Guidance

After sending a user notification, you may continue with a short natural-language reply if it helps the user.

Guidelines:
- Do not resend or paraphrase the entire card.
- Keep follow-up text brief and action-oriented.
- If the workflow must wait for a background event, a button click, or a later user reply, say that plainly instead of emitting placeholder tokens.

---

## 6. Code Change Guardrail

Do not modify source code or skill files in this directory unless the user explicitly asks for a code or documentation change.

If the user explicitly requests a fix, refactor, or documentation update, you may modify:
- `index.mjs`
- `scripts/*.mjs`
- `cards/*.json`
- `SKILL.md`

When making changes:
- Keep edits narrowly scoped to the requested issue
- Preserve card ownership and tool-return rules defined in this skill
- Do not make unrelated refactors

## 7. API References
- API Documentation: `https://docs.clinkbill.com/`
