# Agent Payment Skills

[English](README.md) | 简体中文

Agent Payment Skills 可以通过 Clink 为 OpenClaw Agent 增加钱包初始化、支付方式绑定、直接充值和自动充值能力。

---

## 能做什么

安装后，你可以直接让 Agent：

- 初始化支付钱包
- 绑定或切换支付方式
- 检查当前支付配置是否可用
- 给商户余额充值
- 在其他 Skill 余额不足时自动充值
- 配置风控规则，提升充值安全性

示例：

- `帮我安装 Clink Payment Skills：https://github.com/clinkbillcom/agent-payment-skills`
- `帮我绑定支付方式`
- `检查一下我的支付配置`
- `给 ModelMax 充值 10 美元`
- `开启自动充值`
- `查看我的风控规则`

---

## 安装

### 让 Agent 自动安装

```text
帮我安装 Clink Payment Skills：https://github.com/clinkbillcom/agent-payment-skills
```

安装完成后，Agent 会继续引导你完成后续配置。

### 手动安装

```bash
git clone https://github.com/clinkbillcom/agent-payment-skills.git
cd agent-payment-skills
npm install
npx mcporter --config "${OPENCLAW_HOME:-$HOME}/.openclaw/config/mcporter.json" config add agent-payment-skills "node $(pwd)/index.bundle.mjs"
```

---

## 首次配置

首次使用时，Agent 会引导你完成：

1. 填写通知邮箱
2. 绑定支付方式
3. 按需配置风控规则

支持的支付方式取决于你的 Clink 账户能力，可能包括信用卡、PayPal、Cash App 等。

---

## 主要能力

| 能力 | 说明 |
|---|---|
| 钱包初始化 | 初始化用于 Agent 支付的 Clink 钱包 |
| 支付方式绑定 | 没有可用支付方式时，引导新增支付方式 |
| 支付方式管理 | 查看、切换或更新已绑定的支付方式 |
| 充值支付 | 支付商户充值订单或待支付请求 |
| 自动充值 | 在其他 Skill 余额不足时协助续费并继续任务 |
| 风控规则 | 设置充值金额和频率限制 |

---

## 常见用法

### 初始化钱包

- `帮我初始化支付钱包`
- `支付通知邮箱用 dylan@example.com`

### 绑定或管理支付方式

- `帮我绑定新的支付方式`
- `看看我绑定了哪些支付方式`
- `切换默认卡`
- `删除这个支付方式`

### 充值

- `给 ModelMax 充值 10 美元`
- `支付这笔待充值订单`

### 自动充值

- `开启自动充值`
- `以后自动充值都用这张卡`

### 风控规则

- `查看我的风控规则`
- `设置单次充值上限`

---

## 工作方式

当兼容的 Skill 余额不足时，Agent Payment Skills 可以协助完成支付流程，并在支付成功后让原任务继续执行。

这类能力尤其适合图片、视频生成等需要余额续费的场景。

---

## 说明

- 实际支付是否成功取决于你的 Clink 账户状态和可用支付方式
- 部分支付可能需要额外验证，例如 3DS
- 风控规则可能会拦截或限制充值
- 如果你明确指定了充值金额，Agent 应优先使用你的金额

---

## 兼容环境

- OpenClaw

---

## 相关项目

- [ModelMax Skills](https://github.com/modelmaxio/skills)
- [Clink Docs](https://docs.clinkbill.com)

---

## License

MIT
