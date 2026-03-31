# Agent Payment Skills

English | [简体中文](README-zh.md)

Agent Payment Skills adds wallet setup, payment method binding, direct recharge, and auto top-up support to OpenClaw agents through Clink.

---

## What You Can Do

After installation, you can ask your agent to:

- Set up a payment wallet
- Bind or switch payment methods
- Check whether your payment setup is ready
- Recharge a merchant balance
- Use auto top-up when another skill runs out of balance
- Configure recharge risk rules for safer payments

Examples:

- `Install Clink Payment Skills: https://github.com/clinkbillcom/agent-payment-skills`
- `Bind my payment method`
- `Check my payment setup`
- `Recharge ModelMax with 10 USD`
- `Enable auto top-up`
- `Show my risk rules`

---

## Install

### Ask Your Agent to Install It

```text
Install Clink Payment Skills: https://github.com/clinkbillcom/agent-payment-skills
```

After installation, the agent will guide you through the remaining setup.

### Manual Install

```bash
git clone https://github.com/clinkbillcom/agent-payment-skills.git
cd agent-payment-skills
npm install
npx mcporter config add agent-payment-skills "node $(pwd)/index.bundle.mjs"
```

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

### Auto Top-Up

- `Enable auto top-up`
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
- Risk rules can block or limit a recharge based on your safety settings
- If you provide a specific recharge amount, the agent should use that amount

---

## Compatibility

- OpenClaw

---

## Developer Docs

- [Merchant Skill Integration Guide for Payment Skill (English, v1.0.0)](docs/merchant-skill-payment-integration-v1.0.0-en.md)
- [商户 Skill 集成 Payment Skill 指南（中文，v1.0.0）](docs/merchant-skill-payment-integration-v1.0.0.md)

---

## Related

- [ModelMax Skills](https://github.com/modelmaxio/skills)
- [Clink Docs](https://docs.clinkbill.com)

---

## License

MIT
