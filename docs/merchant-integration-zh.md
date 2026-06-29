# Agent Payment Skills 商户对接文档

当前版本中，Payment Skill 本身不再安装支付 webhook route。支付方式、风控、退款、3DS 后支付结果和 VIC 就绪等异步结果由后台 event pump 通过 `clink-cli events poll` 观测并触发通知/商户确认。商户后端自己的 `customer.verify` webhook 仍按官方文档独立实现。

本文档面向需要接入 Clink 自动充值/代扣能力的**商户 Skill 开发者**，不面向终端用户。

---

## 设计原则

当前设计里，`agent-payment-skills` 只负责**底层支付执行**，不负责发现商户、拉取商户配置、猜测路由，也不维护“支持哪些商户”的中心列表。

如果你的商户 Skill 想接入 Clink 自动充值，请按下面的契约对接。

## 1. 职责边界

- 商户 Skill 负责识别自己的余额不足、402、自动充值等业务场景
- 商户 Skill 负责准备最新的支付输入
- `agent-payment-skills` 只负责调用 `clink_pay` 执行支付，并在支付成功后把结果 handoff 回商户侧确认工具

## 2. 推荐调用顺序

固定流程如下：

1. 调用 `pre_check_account`
2. 在商户侧准备最新支付参数
3. 调用 `clink_pay`
4. 严格按照 `clink_pay` 返回契约继续执行，不要自己补发支付卡片
5. 等待支付层触发商户确认，再由商户 Skill 继续自己的恢复流程

## 3. 支付输入准备

`clink_pay` 支持两种模式：

- **Direct Mode**
  - 由商户 Skill 提供 `merchant_id`、`amount`、`currency`
- **Session Mode**
  - 由商户 Skill 提供最新的 `sessionId`
  - 此模式下金额已经绑定在 `sessionId` 上，**不要再额外传 `amount`**

## 4. 金额选择规则

- 如果用户在当前轮次明确指定了充值金额，必须优先使用用户金额
- 如果是自动触发（如 402 / 余额不足）且用户本轮没有覆盖金额：
  - **Direct Mode** 必须使用商户配置工具返回的精确 `default_amount`
  - **Session Mode** 使用 `sessionId` 已绑定的金额
- 不要凭记忆、经验或习惯擅自替换成 `1`、`5` 等任意金额

## 5. `merchant_integration` 契约

商户 Skill 调用 `clink_pay` 时，必须带上：

```json
{
  "merchant_integration": {
    "server": "<MERCHANT_SERVER>",
    "confirm_tool": "<CONFIRM_TOOL>",
    "confirm_args": {}
  }
}
```

字段说明：

- `server`：商户 MCP server 名称
- `confirm_tool`：商户侧“确认充值是否到账”的工具名
- `confirm_args`：可选，传给确认工具的额外参数对象

## 6. 支付成功 `payment_handoff` 契约

支付层在合适的拥有者路径里，会把结构化的 `payment_handoff` 传给商户确认工具。当前 payload 设计包括：

```json
{
  "order_id": "<CLINK_ORDER_ID>",
  "session_id": "<OPTIONAL_SESSION_ID>",
  "trigger_source": "<sync_charge_response|agent_order.succeeded>",
  "channel": "<CHANNEL>",
  "notify_target": {
    "type": "<chat_id|open_id|target_id>",
    "id": "<TARGET_ID>"
  }
}
```

说明：

- `order_id`：Clink 订单号
- `session_id`：可选，会话模式下回传
- `trigger_source`：表明这次 handoff 来自同步成功路径还是 event pump 成功路径
- `channel` / `notify_target`：当前会话的通知路由信息，供商户侧继续恢复任务时复用

## 7. 返回结果归属规则

商户 Skill 在 `clink_pay` 返回后，只能遵守支付层返回契约：

- 如果结果表示 `DIRECT_SEND`，说明支付层已经发过卡片，**不要重复发**
- 如果结果表示需要执行某个指令，只执行一次
- 如果结果表示等待 event pump 完成，就等待，不要自己提前补做商户确认

## 8. Webhook 与确认归属

商户充值确认必须只由**拥有该事件的支付层成功路径**触发：

- 同步 `status=1` 成功时，支付工具可能已经在同一个幂等路径里：
  - 发送 `✅ Payment Successful`
  - 触发商户确认 handoff
- Pending / 3DS 等异步路径，必须等待后续 webhook（如 `agent_order.succeeded`）

因此：

- 不要在 agent 记忆层或商户 Skill 里“猜测”何时该去确认到账
- 不要在同步成功后再手动调用一次商户侧确认工具
- 不要在 webhook 已接管后再从别的路径重复确认

## 9. Shell 调用示例

```bash
MCPORTER_CONFIG_PATH="${OPENCLAW_HOME:-$HOME}/.openclaw/config/mcporter.json"

# Direct Mode
npx mcporter --config "$MCPORTER_CONFIG_PATH" call agent-payment-skills clink_pay --args '{
  "merchant_id":"<MERCHANT_ID>",
  "amount":10,
  "currency":"USD",
  "merchant_integration":{
    "server":"<MERCHANT_SERVER>",
    "confirm_tool":"<CONFIRM_TOOL>",
    "confirm_args":{}
  }
}'

# Session Mode
npx mcporter --config "$MCPORTER_CONFIG_PATH" call agent-payment-skills clink_pay --args '{
  "sessionId":"<SESSION_ID>",
  "merchant_integration":{
    "server":"<MERCHANT_SERVER>",
    "confirm_tool":"<CONFIRM_TOOL>",
    "confirm_args":{}
  }
}'
```

## 10. 对接时最容易犯的错

- 商户 Skill 没有先做 `pre_check_account`
- Direct Mode 没用商户返回的精确默认金额
- Session Mode 额外又传了 `amount`
- 收到 `DIRECT_SEND` 后又补发了一张支付卡片
- 同步成功后又手动触发一次商户确认
- Pending / 3DS 流程里没有等 webhook，提前继续原任务
- 支付成功后直接由支付层恢复原任务，而不是交给商户确认工具决定后续恢复逻辑
