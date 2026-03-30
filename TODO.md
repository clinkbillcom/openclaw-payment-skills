# Agent Payment Skills TODO

## Merchant-Driven Integration

The payment skill should not maintain a centralized supported-merchant list in `SKILL.md`. Each merchant skill should drive its own payment flow and treat `agent-payment-skills` as a low-level executor.

### 1. Keep the Payment Contract Minimal
- **Action**: Keep `clink_pay` as the only merchant-facing payment entry.
- **Action**: Keep `merchant_integration` minimal:
  - `server`
  - `confirm_tool`
  - optional `confirm_args`

### 2. Standardize Merchant Handoff Payloads
- **Action**: Keep merchant confirmation tools consuming a single `payment_handoff` object.
- **Action**: Keep the `payment_handoff` payload stable with:
  - `order_id`
  - optional `session_id`
  - `trigger_source`
  - `channel`
  - optional `notify_target`

## Telegram & Multi-Channel Support

The current skill is heavily coupled with Feishu (Lark) Interactive Cards. To support Telegram and other channels, the following refactoring is required:

### 1. Abstract Channel Identification
- Done: `initialize_wallet`, `install_system_hooks`, and `uninstall_system_hooks` use the unified notify routing fields (`channel`, `target_id`, `target_type`).
- Done: Local cache now stores a unified `notifyDestination` object so async webhooks and merchant handoff can route with `channel + target`.
- Done: install/post-restart notifications now route through the unified sender instead of Feishu-only branches.

### 2. Unify Message Sending
- Done: `send-message.mjs` is now the single business-level sender.
- Feishu card/media adapters remain implementation details behind the unified sender.
- `/hooks/agent` is no longer used as the outbound notification transport for this skill.

### 3. Decouple Card Data Structures
- Done: Hardcoded Feishu JSON structures were replaced by neutral notification objects.
- Done: Channel-specific renderers now fan out from the unified sender:
  - Feishu -> structured card rendering
  - Telegram / other channels -> Markdown/text rendering

### 4. Update Agent Prompts (System Directives)
- Done: Hardcoded "send this exact Feishu Interactive Card JSON" instructions were removed from `index.mjs` and webhook fallbacks.
- Done: Tool/webhook fallbacks now provide channel-agnostic Markdown notification content and direct action links.

## Current Next Step

The remaining work is ordinary feature evolution. Transport compatibility and prompt/card neutralization are complete.
