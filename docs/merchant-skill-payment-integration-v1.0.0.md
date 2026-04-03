# 商户 Skill 集成 Payment Skill 指南

[English Version](merchant-skill-payment-integration-v1.0.0-en.md) | 简体中文

## 文档版本

- 文档版本：`v1.0.0`
- 适用分支：`main`
- 适用 skill：`agent-payment-skills`
- 对应支付对接 contract：
  - `clink_pay.merchant_confirm_server`
  - `clink_pay.merchant_confirm_tool`
  - `clink_pay.merchant_confirm_args`
- 最后更新：`2026-03-31`

本文主要给商户 Skill 的 Agent 作者和工具开发者看。

目的不是介绍 `agent-payment-skills` 本身，而是明确一件事：

> 商户 Skill 应该如何在自己的 Agent 编排里接入 `agent-payment-skills`，并正确处理支付、到账确认、幂等和原任务恢复。

本文适用于 `main` 分支对应的 payment integration contract。

## 1. 适用场景

当商户 Skill 出现以下任一情况时，应接入 `agent-payment-skills`：

- 用户主动要求给该商户支付或充值
- 商户主任务因余额不足、中断、`402` 等原因需要补款
- 商户希望把绑卡、风控、支付执行统一交给 Clink payment layer

商户 Skill 不应该自己再实现一套独立的支付状态机。

## 2. 三层职责

### Payment Skill

`agent-payment-skills` 负责：

- 钱包初始化
- 支付方式绑定和管理
- 风控规则相关流程
- 发起 Clink 支付
- 处理支付层 webhook
- 在拥有成功事件时触发商户到账确认

`agent-payment-skills` 不负责：

- 判定商户系统是否已经到账
- 发送商户层语义的 `✅ 充值成功` / `❌ 充值失败`

### 商户 Skill

商户 Skill 负责：

- 提供最新的 `merchant_id`
- 提供默认支付金额和币种
- 在支付成功后确认商户系统是否真正到账
- 到账后恢复自己的原任务

### Agent

Agent 负责：

- 先调用商户配置工具，再调用 payment skill
- 严格遵守 payment skill 的返回契约
- 在商户确认到账后继续原任务

Agent 不负责：

- 用记忆复用旧的 `merchant_id`
- 在 payment skill 已经发卡后再补一张等价卡片
- 在商户确认到账前擅自宣布商户侧成功

## 3. 商户 Skill 需要提供的工具

### 3.1 `get_payment_config`

作用：

- 返回本次支付应使用的最新商户配置

输出：

```json
{
  "merchant_id": "merchant_xxx",
  "default_amount": 10,
  "currency": "USD"
}
```

要求：

- 每次支付前重新调用
- `merchant_id` 不得从记忆复用
- 默认支付金额变化时必须返回最新值

### 3.2 `check_recharge_status`

作用：

- 在 payment skill 认为支付成功后，由商户侧确认是否真正到账

输入：

```json
{
  "order_id": "clink_order_xxx"
}
```

输出：

```json
{
  "credited": true,
  "status": "paid"
}
```

或：

```json
{
  "credited": false,
  "status": "pending"
}
```

要求：

- 必须幂等
- 必须能处理重复调用
- 必须区分 `pending`、`paid`、`failed`

严格结果类型：

```json
{
  "type": "object",
  "properties": {
    "credited": { "type": "boolean" },
    "status": { "type": "string", "enum": ["pending", "paid", "failed"] }
  },
  "required": ["credited", "status"],
  "additionalProperties": false
}
```

字段约束：

- `credited`
  - 类型必须是 `boolean`
  - `true` 表示商户侧已经到账
  - `false` 表示尚未到账或已确认失败
- `status`
  - 类型必须是 `string`
  - 只允许：`pending`、`paid`、`failed`

禁止返回：

- 只有自然语言，没有结构化字段
- `status: "success"`、`"done"`、`"ok"` 这类非约定值
- `credited`、`status` 之外的额外字段

## 4. 商户 Skill 的 Agent 提示词必须写清楚什么

如果这些规则不写进商户 Skill 的提示词，模型很容易自己补逻辑，最后就会重复发卡、重复确认、或者提前宣布成功。

建议至少写清楚下面几条。

### 4.1 支付入口规则

当出现以下任一情况时，必须走 `agent-payment-skills`：

- 用户明确要求给当前商户支付或充值
- 商户工具返回 `402`
- 商户工具返回余额不足、额度不足、需要补款等错误

### 4.2 金额选择规则

只有两个合法来源：

1. 用户本轮明确指定的金额
2. `get_payment_config` 返回的 `default_amount`

禁止：

- 用历史上下文里的旧金额
- 自行替换成 `1`、`5` 或其他经验值

### 4.3 成功归属规则

必须区分两种成功：

- Payment success：Clink 支付成功
- Merchant credited：商户账户已经到账

因此：

- payment skill 可以拥有支付层成功/失败通知
- 商户 Skill 才能拥有商户层 `✅ 充值成功` / `❌ 充值失败`

在 `check_recharge_status` 确认 `credited=true` 或 `status=paid` 之前，不得宣布商户侧成功。

### 4.4 幂等规则

对同一 `order_id`：

- 不得发送第二次终态成功
- 不得发送第二次终态失败
- 不得重复触发到账确认
- 不得重复恢复同一个原任务

## 5. Agent 的标准调用流程

### 场景 A：用户主动要求支付

例如：

- `给 ModelMax 充值 10 美元`
- `帮我支付这笔商户补款`

Agent 应执行：

1. 调用 `agent-payment-skills.pre_check_account`
2. 调用商户 Skill 的 `get_payment_config`
3. 选择支付金额
4. 调用 `agent-payment-skills.clink_pay`
5. 按返回契约处理
6. 由 payment layer 在成功事件拥有权下触发商户确认
7. 商户 `check_recharge_status` 确认到账
8. 恢复原任务或结束本次支付任务

### 场景 B：商户主任务返回 `402`

例如图片生成、视频生成、推理额度等场景。

Agent 应执行：

1. 识别余额不足或补款场景
2. 调用商户 Skill 的 `get_payment_config`
3. 使用用户本轮金额或商户默认支付金额
4. 调用 `agent-payment-skills.pre_check_account`
5. 调用 `agent-payment-skills.clink_pay`
6. 若返回 `WAIT_FOR_WEBHOOK`，当前轮不再补动作，等待异步 handoff
7. 商户确认到账后，自动恢复被中断的原任务

关键点：

- 自动补款场景不要再次追问金额，除非产品策略明确要求
- 自动补款成功后不要停在“还要不要继续”
- 应自动恢复原任务

## 6. `main` 分支上如何调用 `clink_pay`

当前 `main` 分支 `clink_pay` 的商户对接字段是：

- `merchant_id`
- `amount`
- `currency`
- `sessionId`
- `merchant_confirm_server`
- `merchant_confirm_tool`
- `merchant_confirm_args`

典型 direct mode 调用：

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

如果商户侧采用 session 模式，也可以：

```json
{
  "sessionId": "session_xxx",
  "merchant_confirm_server": "modelmax-media",
  "merchant_confirm_tool": "check_recharge_status",
  "merchant_confirm_args": {}
}
```

这些字段的职责是：

- `merchant_confirm_server`
  表示支付成功后应通知哪个商户 MCP server
- `merchant_confirm_tool`
  表示支付成功后应调用哪个商户确认工具
- `merchant_confirm_args`
  表示支付成功后透传给确认工具的额外参数

## 7. Payment Skill 返回后，Agent 必须如何处理

### `DIRECT_SEND`

含义：

- tool 或 webhook 已经把卡片发出去了

Agent 必须：

- 不再补发语义等价卡片
- 不再重复发送同一支付事件的成功/失败

### `EXEC_REQUIRED`

含义：

- payment skill 返回了明确的卡片执行指令

Agent 必须：

- 执行一次，而且只能执行一次

### `WAIT_FOR_WEBHOOK`

含义：

- 当前支付链路要等待异步 webhook 接管

Agent 必须：

- 当前轮不要补发成功或失败
- 不要自己再次触发商户确认
- 等 webhook 或 payment layer 后续 handoff

### `NO_REPLY`

含义：

- 当前轮不要补额外文本或卡片

Agent 必须：

- 原样遵守

## 8. 为什么这些规则必须写在商户 Skill 里

问题通常不是 payment skill 不会支付，而是商户 Skill 的 Agent 没有被约束。

如果商户 Skill 的提示词没写清楚，模型很容易：

- 复用旧的 `merchant_id`
- 跳过 `get_payment_config`
- 在 payment success 后直接宣布“充值成功”
- 在 webhook 之后又补发一次成功消息
- 又手动调一次 `check_recharge_status`
- 充值后停住，不恢复原任务

所以这份文档的重点不是解释产品，而是约束商户 Skill 的 Agent 行为。

## 9. 可直接放进商户 Skill 的提示词模板

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

## 10. 一个完整示例

以 `modelmax-media` 为例。

### 第一步：商户取支付配置

```text
modelmax-media.get_payment_config
```

返回：

```json
{
  "merchant_id": "modelmax_merchant_001",
  "default_amount": 10,
  "currency": "USD"
}
```

### 第二步：Agent 调 payment skill

```text
agent-payment-skills.clink_pay
```

参数：

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

### 第三步：payment skill 成功后 handoff

payment layer 在自己拥有成功事件时，调用：

```text
modelmax-media.check_recharge_status
```

输入至少应能识别本次订单，例如：

```json
{
  "order_id": "clink_order_123"
}
```

### 第四步：商户确认到账

如果商户返回：

```json
{
  "credited": true,
  "status": "paid"
}
```

这时商户 Skill 才可以：

- 宣布商户侧支付/充值成功
- 恢复原先被中断的主任务

如果商户返回：

```json
{
  "credited": false,
  "status": "pending"
}
```

则 Agent 必须把它当作“尚未到账”，而不是失败或成功。

## 11. 接入检查清单

- 商户 Skill 是否提供 `get_payment_config`
- 商户 Skill 是否提供 `check_recharge_status`
- `get_payment_config` 是否每次都返回最新 `merchant_id`
- `check_recharge_status` 是否幂等
- `check_recharge_status` 是否能返回 `credited` / `status`
- Agent 是否在支付前调用 `pre_check_account`
- Agent 是否把 `merchant_confirm_server` / `merchant_confirm_tool` / `merchant_confirm_args` 传给 `clink_pay`
- Agent 是否正确处理 `DIRECT_SEND` / `EXEC_REQUIRED` / `WAIT_FOR_WEBHOOK`
- Agent 是否避免重复发送终态成功/失败
- 商户确认到账后是否自动恢复原任务

## 12. 一句话原则

商户 Skill 自己决定“给谁付、默认付多少、是否到账、任务如何恢复”。

`agent-payment-skills` 负责“把支付做掉，并在合适的时候把成功事件交回商户 Skill”。
