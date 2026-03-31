# Merchant Skill Integration Guide for Payment Skill

English | [简体中文](merchant-skill-payment-integration-v1.0.0.md)

## Document Version

- Document version: `v1.0.0`
- Supported branch: `main`
- Supported skill: `agent-payment-skills`
- Supported payment integration contract:
  - `clink_pay.merchant_confirm_server`
  - `clink_pay.merchant_confirm_tool`
  - `clink_pay.merchant_confirm_args`
- Last updated: `2026-03-31`

This document is primarily for:

- agent/prompt authors of merchant skills
- tool and integration developers of merchant skills

The goal is not to introduce `agent-payment-skills` as a product. The goal is to define one thing clearly:

> How a merchant skill should integrate `agent-payment-skills` into its own agent orchestration so payment execution, merchant-side confirmation, idempotency, and original-task resume all behave correctly.

This document is written against the current `main` branch contract.

## 1. When This Guide Applies

A merchant skill should integrate `agent-payment-skills` when any of the following happens:

- the user explicitly asks to pay or recharge that merchant
- the merchant task is interrupted by insufficient balance, quota exhaustion, or a `402`
- the merchant wants wallet binding, risk control, and payment execution to be handled by the Clink payment layer

The merchant skill should not implement a separate payment state machine from scratch.

## 2. Responsibilities Across the Three Layers

### Payment Skill

`agent-payment-skills` is responsible for:

- wallet initialization
- payment-method binding and management
- risk-rule related flows
- initiating Clink payments
- handling payment-layer webhooks
- triggering merchant-side confirmation when the payment layer owns the success event

`agent-payment-skills` is not responsible for:

- deciding whether the merchant system has actually been credited
- sending merchant-layer `✅ Recharge Successful` or `❌ Recharge Failed`

### Merchant Skill

The merchant skill is responsible for:

- providing the latest `merchant_id`
- providing the default payment amount and currency
- confirming whether the merchant system was actually credited after payment success
- resuming its own original task after credit is confirmed

### Agent

The agent is responsible for:

- calling the merchant configuration tool before calling the payment skill
- strictly following the payment skill return contract
- resuming the original task after merchant credit is confirmed

The agent must not:

- reuse an old `merchant_id` from memory
- send a second semantically equivalent card after the payment skill already sent one
- declare merchant-side success before merchant credit is actually confirmed

## 3. Minimum Tools the Merchant Skill Must Provide

### 3.1 `get_payment_config`

Purpose:

- return the latest merchant-side payment configuration for the current payment

Recommended output:

```json
{
  "merchant_id": "merchant_xxx",
  "default_amount": 10,
  "currency": "USD"
}
```

Requirements:

- call it fresh before every payment
- never reuse `merchant_id` from memory
- return the latest default amount if the merchant's default policy changes

### 3.2 `check_recharge_status`

Purpose:

- confirm whether the merchant side has actually been credited after the payment skill considers the payment successful

Recommended `main` branch input:

```json
{
  "order_id": "clink_order_xxx"
}
```

Recommended output:

```json
{
  "credited": true,
  "status": "paid"
}
```

or:

```json
{
  "credited": false,
  "status": "pending"
}
```

Requirements:

- it must be idempotent
- it must tolerate repeated calls
- it must distinguish `pending`, `paid`, and `failed`

Recommended strict result type:

```json
{
  "type": "object",
  "properties": {
    "credited": { "type": "boolean" },
    "status": { "type": "string", "enum": ["pending", "paid", "failed"] },
    "merchant_order_id": { "type": "string" },
    "message": { "type": "string" },
    "retryable": { "type": "boolean" }
  },
  "required": ["credited", "status"],
  "additionalProperties": true
}
```

Field constraints:

- `credited`
  - must be a `boolean`
  - `true` means the merchant side has been credited
  - `false` means credit is still pending or the merchant side has confirmed failure
- `status`
  - must be a `string`
  - allowed values are only: `pending`, `paid`, `failed`
- `merchant_order_id`
  - optional
  - recommended for merchant-side tracing and debugging
- `message`
  - optional
  - short explanation for the agent; it must not replace the structured status fields
- `retryable`
  - optional
  - mainly useful when `status=failed` to indicate whether retry may make sense later

Do not return:

- only natural language with no structured fields
- non-contract values like `status: "success"`, `"done"`, or `"ok"`
- a human explanation in `message` while omitting `credited` / `status`

## 4. What Must Be Written into the Merchant Skill Prompt

If these rules are not written into the merchant skill prompt, the model will tend to improvise. That is how you get duplicate cards, duplicate confirmations, or premature success announcements.

At minimum, the prompt should define the following rules.

### 4.1 Payment Entry Rule

The flow must route through `agent-payment-skills` when any of the following happens:

- the user explicitly asks to pay or recharge the current merchant
- a merchant tool returns `402`
- a merchant tool returns insufficient-balance, quota-exhausted, or top-up-required signals

### 4.2 Amount Selection Rule

There are only two valid amount sources:

1. the user-specified amount in the current turn
2. the `default_amount` returned by `get_payment_config`

The agent must not:

- reuse an old amount from prior context
- replace it with `1`, `5`, or another guessed amount

### 4.3 Success Ownership Rule

The prompt must distinguish two different kinds of success:

- Payment success: the Clink payment succeeded
- Merchant credited: the merchant account has actually been credited

Therefore:

- the payment skill can own payment-layer success/failure
- only the merchant skill can own merchant-layer `✅ Recharge Successful` / `❌ Recharge Failed`

Before `check_recharge_status` confirms `credited=true` or `status=paid`, the agent must not announce merchant-side success.

### 4.4 Idempotency Rule

For the same `order_id`:

- do not send a second terminal success
- do not send a second terminal failure
- do not trigger merchant confirmation twice
- do not resume the same original task twice

## 5. Standard Agent Flow

### Scenario A: The User Explicitly Asks to Pay

Examples:

- `Recharge ModelMax with 10 USD`
- `Help me pay this merchant top-up`

The agent should:

1. call `agent-payment-skills.pre_check_account`
2. call the merchant skill's `get_payment_config`
3. choose the payment amount
4. call `agent-payment-skills.clink_pay`
5. follow the return contract
6. let the payment layer trigger merchant confirmation when it owns the success event
7. let merchant `check_recharge_status` confirm credit
8. resume the original task or finish the payment task

### Scenario B: The Merchant Task Returns `402`

Examples include image generation, video generation, or inference quota flows.

The agent should:

1. recognize this as an insufficient-balance or top-up scenario
2. call the merchant skill's `get_payment_config`
3. use the current-turn user amount or the merchant default amount
4. call `agent-payment-skills.pre_check_account`
5. call `agent-payment-skills.clink_pay`
6. if the result is `WAIT_FOR_WEBHOOK`, stop adding actions in the current turn and wait for async handoff
7. automatically resume the interrupted original task after the merchant confirms credit

Key points:

- do not ask for the amount again in auto top-up flows unless the product policy explicitly requires it
- do not stop at "payment completed, should I continue?"
- resume the original task automatically

## 6. How to Call `clink_pay` on `main`

On the current `main` branch, the merchant integration fields for `clink_pay` are:

- `merchant_id`
- `amount`
- `currency`
- `sessionId`
- `merchant_confirm_server`
- `merchant_confirm_tool`
- `merchant_confirm_args`

Typical direct-mode call:

```json
{
  "merchant_id": "merchant_xxx",
  "amount": 10,
  "currency": "USD",
  "merchant_confirm_server": "modelmax-media",
  "merchant_confirm_tool": "check_recharge_status",
  "merchant_confirm_args": {}
}
```

If the merchant side uses session mode:

```json
{
  "sessionId": "session_xxx",
  "merchant_confirm_server": "modelmax-media",
  "merchant_confirm_tool": "check_recharge_status",
  "merchant_confirm_args": {}
}
```

These fields mean:

- `merchant_confirm_server`
  the merchant MCP server to notify after payment success
- `merchant_confirm_tool`
  the merchant confirmation tool to call after payment success
- `merchant_confirm_args`
  optional extra args forwarded to the confirmation tool

## 7. How the Agent Must Handle Payment Skill Results

### `DIRECT_SEND`

Meaning:

- the tool or webhook already sent the card

The agent must:

- not send a duplicate semantically equivalent card
- not repeat the same payment success/failure notification

### `EXEC_REQUIRED`

Meaning:

- the payment skill returned an explicit card execution directive

The agent must:

- execute it exactly once

### `WAIT_FOR_WEBHOOK`

Meaning:

- the payment flow must now wait for an async webhook

The agent must:

- not add success or failure in the current turn
- not trigger merchant confirmation again by itself
- wait for the webhook or the payment-layer handoff

### `NO_REPLY`

Meaning:

- do not add extra text or cards in the current turn

The agent must:

- preserve that behavior exactly

## 8. Why These Rules Must Live in the Merchant Skill

The main problem is usually not whether the payment skill can execute payment. The main problem is that the merchant skill agent is under-specified.

If the merchant skill prompt is vague, the model will often:

- reuse an old `merchant_id`
- skip `get_payment_config`
- announce recharge success immediately after payment success
- send another success message after the webhook
- call `check_recharge_status` again on its own
- stop after payment instead of resuming the original task

That is why this document exists. It is a behavior contract for the merchant skill agent.

## 9. Prompt Template You Can Reuse in a Merchant Skill

```text
When the user asks to pay or recharge this merchant, or when any merchant tool returns a 402 / insufficient-balance signal, you MUST route the flow through agent-payment-skills.

Before calling clink_pay:
1. Call this merchant skill's get_payment_config tool and fetch a fresh merchant_id.
2. Use the user-specified amount from the current turn if provided.
3. Otherwise use the exact default_amount returned by get_payment_config.
4. Call agent-payment-skills.pre_check_account.
5. Call agent-payment-skills.clink_pay with the prepared payment inputs.
6. Pass merchant_confirm_server, merchant_confirm_tool, and merchant_confirm_args so the payment layer can hand success back to this merchant.

After clink_pay returns:
- If the result indicates DIRECT_SEND, do not send a duplicate card.
- If the result indicates EXEC_REQUIRED, execute it exactly once.
- If the result indicates WAIT_FOR_WEBHOOK, wait.
- Do not declare merchant recharge success until this merchant's check_recharge_status confirms credited=true or status=paid.
- Do not send a second terminal success or failure for the same order_id.
- After merchant recharge is confirmed, automatically resume the interrupted original task.
```

## 10. Full Example

Using `modelmax-media` as the example.

### Step 1: Fetch Merchant Payment Config

```text
modelmax-media.get_payment_config
```

Returns:

```json
{
  "merchant_id": "modelmax_merchant_001",
  "default_amount": 10,
  "currency": "USD"
}
```

### Step 2: Call the Payment Skill

```text
agent-payment-skills.clink_pay
```

Args:

```json
{
  "merchant_id": "modelmax_merchant_001",
  "amount": 10,
  "currency": "USD",
  "merchant_confirm_server": "modelmax-media",
  "merchant_confirm_tool": "check_recharge_status",
  "merchant_confirm_args": {}
}
```

### Step 3: Payment Layer Hands Off Success

When the payment layer owns the success event, it calls:

```text
modelmax-media.check_recharge_status
```

The input should at least let the merchant identify the order, for example:

```json
{
  "order_id": "clink_order_123"
}
```

### Step 4: Merchant Confirms Credit

If the merchant returns:

```json
{
  "credited": true,
  "status": "paid"
}
```

Only then can the merchant skill:

- declare merchant-side payment/recharge success
- resume the interrupted original task

If the merchant returns:

```json
{
  "credited": false,
  "status": "pending",
  "message": "Merchant ledger not updated yet"
}
```

the agent must treat it as "not credited yet", not as success or terminal failure.

## 11. Integration Checklist

- does the merchant skill provide `get_payment_config`
- does the merchant skill provide `check_recharge_status`
- does `get_payment_config` return a fresh `merchant_id` every time
- is `check_recharge_status` idempotent
- can `check_recharge_status` return `credited` / `status`
- does the agent call `pre_check_account` before payment
- does the agent pass `merchant_confirm_server` / `merchant_confirm_tool` / `merchant_confirm_args` to `clink_pay`
- does the agent correctly handle `DIRECT_SEND` / `EXEC_REQUIRED` / `WAIT_FOR_WEBHOOK`
- does the agent avoid duplicate terminal success/failure
- does the agent automatically resume the original task after merchant credit is confirmed

## 12. One-Sentence Principle

The merchant skill decides who to pay, how much to pay by default, whether the merchant has been credited, and how to resume the business task.

`agent-payment-skills` is responsible for executing payment and handing the success event back to the merchant skill at the right time.
