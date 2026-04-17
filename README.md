# OpenClaw Payment Skills

English | [简体中文](README-zh.md)

Agent Payment Skills adds wallet setup, payment method binding, direct recharge, refund request, and auto top-up support to OpenClaw agents through Clink.

---

## What You Can Do

After installation, you can ask your agent to:

- Set up a payment wallet
- Bind or switch payment methods
- Check whether your payment setup is ready
- Recharge a merchant balance
- Request a full refund for an existing Clink order
- Query the latest status of an existing refund order
- Use auto top-up when another skill runs out of balance
- Configure recharge risk rules for safer payments

Examples:

- `Install Clink Payment Skills: https://github.com/clinkbillcom/openclaw-payment-skills`
- `Bind my payment method`
- `Check my payment setup`
- `Recharge ModelMax with 10 USD`
- `Refund order ord_xxx`
- `Enable Clink payment auto top-up`
- `Show my risk rules`

---

## Install

### Ask Your Agent to Install It

```text
Install Clink Payment Skills: https://github.com/clinkbillcom/openclaw-payment-skills
```

After installation, the agent will guide you through the remaining setup.

### Installation for OpenClaw

```bash
git clone https://github.com/clinkbillcom/openclaw-payment-skills.git
cd agent-payment-skills
node scripts/pre_install.mjs --channel <CHANNEL> --target-id <TARGET_ID> --target-type <TARGET_TYPE>
```

`npm install` is intentionally skipped here. This skill is installed from the committed `index.bundle.mjs`.

For Feishu, use one of:

```bash
node scripts/pre_install.mjs --channel feishu --target-id <CHAT_ID> --target-type chat_id
node scripts/pre_install.mjs --channel feishu --target-id <OPEN_ID> --target-type open_id
```

`pre_install.mjs` already registers the MCP server, installs the ESM webhook (`my_payment_webhook.mjs`), configures the webhook route, schedules the gateway restart, and sends the install success notification immediately. Do not run a second manual `openclaw gateway restart` after it succeeds.

---

## First-Time Setup

On first use, the agent will guide you through:

1. Adding your notification email
2. Binding a payment method
3. Optionally configuring risk rules

Supported payment method flows may include cards, PayPal, Cash App, and other methods supported by your Clink account.

---

## Main Capabilities

| Capability | Description |
|---|---|
| Wallet setup | Initializes your Clink wallet for agent payments |
| Payment method binding | Adds a new payment method when none is available |
| Payment method management | Lists, switches, or updates existing payment methods |
| Recharge | Pays a merchant order or recharge request |
| Refund request | Submits a full refund request for an existing Clink order |
| Auto top-up | Helps another skill continue after insufficient balance |
| Risk rules | Lets you set recharge limits and frequency controls |

---

## Common Usage

### Set Up Wallet

- `Set up my payment wallet`
- `Use dylan@example.com as my payment email`

### Bind or Manage Payment Methods

- `Bind a new payment method`
- `Show my payment methods`
- `Switch my default card`
- `Delete this payment method`

### Recharge

- `Recharge ModelMax with 10 USD`
- `Pay this pending recharge`

### Refund

- `Refund order ord_xxx`
- `Apply a refund for this Clink order`

### Auto Top-Up

- `Enable Clink payment auto top-up`
- `Use this card for future auto top-ups`

### Risk Rules

- `Show my risk rules`
- `Set a single recharge limit`

---

## How It Works

When a compatible skill runs out of balance, Agent Payment Skills can help complete the payment flow and let the original task continue after payment succeeds.

This is especially useful for recharge-based skills such as media generation services.

---

## Notes

- Payment execution depends on your Clink account status and available payment methods
- Some payments may require extra verification such as 3DS
- Refund requests are currently submitted as full refunds and complete asynchronously through webhook callbacks
- Risk rules can block or limit a recharge based on your safety settings
- If you provide a specific recharge amount, the agent should use that amount

---

## Compatibility

- OpenClaw
- Recommended version: `2026.3.28`

---

## Developer Docs

- [Merchant Skill Integration Guide for Payment Skill (English, v1.0.1)](docs/merchant-skill-payment-integration-v1.0.1-en.md)
- [商户 Skill 集成 Payment Skill 指南（中文，v1.0.1）](docs/merchant-skill-payment-integration-v1.0.1.md)

---

## Related

- [ModelMax Skills](https://github.com/modelmaxio/skills)
- [Clink Docs](https://docs.clinkbill.com)

---

## License

MIT
