<h1 align="center">Agent Payment Skills</h1>

<p align="center">
  <strong>给你的 AI Agent 一键装上支付和自动充值能力</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://docs.clinkbill.com"><img src="https://img.shields.io/badge/Clink-API-green.svg?style=for-the-badge" alt="Clink API"></a>
</p>

<p align="center">
  <a href="#快速上手">快速开始</a> · <a href="#支持的能力">支持的能力</a> · <a href="#工作流程">工作流程</a> · <a href="#配置">配置</a>
</p>

---

## 为什么需要 Agent Payment Skills？

AI Agent 能帮你写代码、改文档、生成图片——但你让它帮你充值或管理支付，它就做不到了：

- 💳 "余额不够了，帮我充值" → **充不了**，没有接入支付系统
- 🔄 "生成图片到一半余额不足" → **卡住了**，不知道怎么自动续费
- 🛡️ "充值要有限额和风控" → **做不到**，没有安全管控能力

**Agent Payment Skills 把这些变成全自动的事。**

本 Skill 基于 [Clink](https://docs.clinkbill.com) 支付平台，为任意 AI Agent 提供通用的支付和充值能力。支持直接充值和商户触发的自动充值，内置 3DS 验证、风控拦截、卡片切换等完整异常处理。

---

## 快速上手

### 安装

在任意 IM 消息通道（飞书、Telegram、Discord 等）中直接告诉 Agent：

```
@Claw 帮我安装 Clink 支付 Skill：https://github.com/clinkbillcom/agent-payment-skills
```

或使用斜杠命令：

```
/skill install https://github.com/clinkbillcom/agent-payment-skills
```

CLI 环境（Claude Code、Cursor 等）同样支持上述命令。

安装后，Agent 会自动引导你完成：
1. 输入通知邮箱
2. 绑定支付方式（信用卡、PayPal、Cash App 等）
3. 设置风控规则（单笔限额、每日上限等）

装好之后，直接用自然语言告诉 Agent：

- *"帮我向 ModelMax 充值 $50"*
- *"查看我绑定的支付方式"*
- *"换一张卡"*

**不需要记 API 参数。** Agent 自动完成账户检测、支付执行、结果确认的全流程。

---

## 支持的能力

| 能力 | 工具 | 说明 |
|------|------|------|
| 🔧 **钱包初始化** | `initialize_wallet` | 生成签名密钥，调用 Clink Bootstrap API |
| 📋 **状态查询** | `get_wallet_status` | 检查钱包是否已初始化 |
| ✅ **账户预检** | `pre_check_account` | 充值前验证钱包、支付方式、风控状态 |
| 💳 **绑卡检测** | `get_binding_link` | 检测已绑定的支付方式，未绑则引导绑卡 |
| 🛡️ **风控设置** | `get_risk_rules_link` | 引导用户配置充值安全规则 |
| ➕ **添加支付方式** | `get_payment_method_setup_link` | 生成绑卡页面链接 |
| ⚙️ **管理支付方式** | `get_payment_method_modify_link` | 切换默认卡、管理已绑定方式 |
| 📄 **支付方式列表** | `list_payment_methods` | 列出所有已绑定的支付方式 |
| 🔍 **支付方式详情** | `get_payment_method_detail` | 查看单个支付方式的详细信息 |
| ✏️ **更新支付方式** | `update_payment_method` | 更新账单地址 |
| 🗑️ **删除支付方式** | `delete_payment_method` | 移除已绑定的支付方式 |
| ⭐ **设置默认卡** | `set_default_payment_method` | 指定默认扣款方式 |
| 💰 **执行支付** | `clink_pay` | 发起充值，支持直接模式和 Session 模式 |

---

## 工作流程

### 1. 初始化（首次使用）

```
用户输入邮箱 → initialize_wallet → get_binding_link
  ├─ 未绑卡 → 引导绑卡 → payment_method.added webhook 确认
  └─ 已绑卡 → 跳过
→ get_risk_rules_link → 用户设置规则（可选）
→ 🎉 初始化完成
```

### 2. 执行充值

```
pre_check_account（账户预检）
→ clink_pay（发起支付）
→ 商户确认到账轮询（同一轮立即开始）
  ├─ 3DS 触发 → 用户完成验证 → webhook 确认
  ├─ 卡被拒 → 引导换卡 → 自动重试
  ├─ 风控触发 → 用户选择（继续/改规则/暂停）
  └─ 邮箱不匹配 → 安全拦截，不重试
→ agent_order.succeeded webhook（兜底唤起）
→ ✅ 充值成功
```

### 3. 自动充值（其他 Skill 触发）

当商户 Skill（如 ModelMax）返回 HTTP 402 余额不足时：

```
商户 Skill 返回 402（含 session_id）
→ agent-payment-skills.pre_check_account
→ agent-payment-skills.clink_pay（Session 模式）
→ 商户 Skill 立即确认到账轮询
→ order.succeeded webhook（兜底）
→ 自动重试原任务
```

**用户全程无感知，任务不中断。**

---

## 支付模式

### 直接模式（Direct Mode）

用户主动发起充值，指定商户和金额：

```
clink_pay(merchant_id="m_001", amount=50, currency="USD")
```

### Session 模式（Session Mode）

商户 Skill 返回 402 时附带 `session_id`，金额和币种由 Session 预设：

```
clink_pay(sessionId="sess_xxx")
```

金额和币种由 Clink Session 预设，调用时不需要传 `merchant_id` 或 `amount`。

---

## 异常处理

| 场景 | 处理方式 |
|------|----------|
| 🔐 **3DS 验证** | 暂停任务，发送验证链接，等待 webhook 确认 |
| ❌ **卡被拒绝** | 引导用户更换支付方式，自动重试 |
| 🛡️ **风控触发** | 提供三选一：继续充值 / 修改规则 / 暂停任务 |
| 🚫 **邮箱不匹配** | 安全拦截，不允许重试 |
| ⚠️ **支付成功但充值失败** | 区分已扣款/未扣款，提供订单号联系商户支持 |
| ⏳ **重复订单** | 提示等待上一笔完成 |
| 🔑 **认证失败** | 提示重新初始化钱包 |

---

## Webhook 回调

本 Skill 通过 OpenClaw Webhook 系统接收 Clink 的异步回调。安装时会自动配置。

| 事件 | 说明 |
|------|------|
| `payment_method.added` | 用户绑卡成功 |
| `payment_method.defaultChange` | 用户更换了默认支付方式 |
| `agent_order.created` | 充值订单已创建（中间状态） |
| `agent_order.succeeded` | 支付成功，等待商户确认到账 |
| `agent_order.failed` | 支付或充值失败 |
| `risk_rule.updated` | 用户更新了风控规则 |

---

## 配置

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CLINK_API_BASE_URL` | Clink API 地址 | `https://uat-api.clinkbill.com` |
| `OPENCLAW_CONFIG_PATH` | OpenClaw 配置文件路径 | `~/.openclaw/openclaw.json` |

### 自动持久化的配置

初始化过程中，以下信息会自动写入 `openclaw.json`：

| 配置项 | 说明 |
|--------|------|
| `CLINK_USER_EMAIL` | 用户通知邮箱 |
| `CLINK_WEBHOOK_SIGNKEY` | Webhook 签名密钥 |
| `CLINK_CUSTOMER_ID` | Clink 客户 ID |
| `CLINK_CUSTOMER_API_KEY` | Clink 客户 API Key |

存储路径：`skills.entries["agent-payment-skills"].env.*`

---

## 项目结构

```
agent-payment-skills/
├── README.md                         # 本文件
├── SKILL.md                          # Skill 定义与 Agent 指引文档
├── index.mjs                         # 核心实现（15 个工具）
├── scripts/
│   └── send-feishu-card.mjs          # 飞书卡片发送脚本（无外部依赖）
└── hooks/
    └── my_payment_webhook.js         # Webhook 回调处理（6 种事件）
```

---

## 依赖

飞书卡片通过内置的 `scripts/send-feishu-card.mjs` 脚本发送，无需安装额外 Skill。

## 谁在用

- [ModelMax Skills](https://github.com/modelmaxio/skills) — 图片/视频生成，余额不足时自动调用本 Skill 充值

## 兼容性

| Agent 平台 | 支持 |
|------------|------|
| OpenClaw | ✅ |
| Claude Code | ✅ |
| Cursor | ✅ |
| Windsurf | ✅ |

## API 文档

- Clink API：https://docs.clinkbill.com/

## License

MIT
