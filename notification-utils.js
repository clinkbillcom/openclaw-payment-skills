export const DEFAULT_LOCALE = 'zh-CN';
export const DEFAULT_FALLBACK_LOCALE = 'en-US';

const DEFAULT_DELIVERY_POLICY = Object.freeze({
  prefer_rich: true,
  allow_fallback: true,
});

const LOCALE_ALIASES = Object.freeze({
  zh: 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-hans': 'zh-CN',
  'zh-hans-cn': 'zh-CN',
  'zh-sg': 'zh-CN',
  'zh-hk': 'zh-HK',
  'zh-tw': 'zh-TW',
  en: 'en-US',
  'en-us': 'en-US',
  'en-gb': 'en-GB',
});

function coerceString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function normalizeLocaleTag(locale) {
  const raw = coerceString(locale).replace(/_/g, '-');
  if (!raw) return '';
  const alias = LOCALE_ALIASES[raw.toLowerCase()];
  if (alias) return alias;
  const [languagePart, ...rest] = raw.split('-').filter(Boolean);
  if (!languagePart) return '';
  const language = languagePart.toLowerCase();
  if (rest.length === 0) {
    return language === 'zh' ? 'zh-CN' : `${language}`;
  }
  const region = rest[0].length <= 3 ? rest[0].toUpperCase() : rest[0];
  return `${language}-${region}`;
}

function resolveLocaleChain(locale) {
  const normalized = normalizeLocaleTag(locale);
  if (!normalized || normalized === 'auto') {
    return [DEFAULT_LOCALE, DEFAULT_FALLBACK_LOCALE];
  }
  const chain = [normalized];
  if (normalized.startsWith('zh-HK') || normalized.startsWith('zh-TW')) {
    chain.push('zh-CN');
  } else if (normalized.startsWith('zh-')) {
    chain.push('zh-CN');
  } else if (normalized.startsWith('en-') && normalized !== 'en-US') {
    chain.push('en-US');
  }
  if (!chain.includes(DEFAULT_LOCALE)) chain.push(DEFAULT_LOCALE);
  if (!chain.includes(DEFAULT_FALLBACK_LOCALE)) chain.push(DEFAULT_FALLBACK_LOCALE);
  return chain;
}

function normalizeFact(entry) {
  if (!entry) return null;
  if (Array.isArray(entry) && entry.length >= 2) {
    const label = coerceString(entry[0]);
    const value = coerceString(entry[1]);
    if (!label && !value) return null;
    return { label, value };
  }
  if (typeof entry === 'object') {
    const label = coerceString(entry.label);
    const value = coerceString(entry.value);
    if (!label && !value) return null;
    return { label, value };
  }
  return null;
}

function normalizeSection(section) {
  if (!section) return null;
  if (typeof section === 'string') {
    const text = coerceString(section);
    if (!text) return null;
    return { type: 'markdown', text };
  }
  if (typeof section === 'object') {
    const type = coerceString(section.type) || 'markdown';
    const text = coerceString(section.text);
    if (!text) return null;
    return { type, text };
  }
  return null;
}

function normalizeAction(action) {
  if (!action || typeof action !== 'object') return null;
  const label = coerceString(action.label);
  const url = coerceString(action.url);
  const type = coerceString(action.type) || (url ? 'url' : 'note');
  if (!label) return null;
  return { type, label, url };
}

function normalizeDeliveryPolicy(policy) {
  const normalized = policy && typeof policy === 'object' && !Array.isArray(policy)
    ? policy
    : {};
  return {
    prefer_rich: normalized.prefer_rich !== false,
    allow_fallback: normalized.allow_fallback !== false,
  };
}

function interpolate(template, vars = {}) {
  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

function buildTextLines(model, { markdown = false } = {}) {
  const sections = [];
  if (model.title) {
    sections.push(markdown ? `**${model.title}**` : model.title);
  }
  if (model.summary) {
    sections.push(model.summary);
  }
  if (model.facts.length > 0) {
    sections.push(
      model.facts
        .map((fact) => {
          if (markdown) return `**${fact.label}** ${fact.value}`.trim();
          return `${fact.label}: ${fact.value}`.trim();
        })
        .join('\n'),
    );
  }
  if (model.sections.length > 0) {
    sections.push(model.sections.map((section) => section.text).join('\n\n'));
  }
  if (model.actions.length > 0) {
    sections.push(
      model.actions
        .map((action) => {
          if (action.type === 'url' && action.url) {
            return markdown ? `- [${action.label}](${action.url})` : `${action.label}: ${action.url}`;
          }
          return `- ${action.label}`;
        })
        .join('\n'),
    );
  }
  if (model.footer) {
    sections.push(model.footer);
  }
  return sections.filter(Boolean).join('\n\n').trim();
}

function buildTelegramHeaderLines(model) {
  const sections = [];
  if (model.title) {
    sections.push(`**${model.title}**`);
  }
  if (model.summary) {
    sections.push(model.summary);
  }
  return sections.filter(Boolean);
}

function isTelegramChineseLocale(locale) {
  return coerceString(locale).toLowerCase().startsWith('zh');
}

function getTelegramSectionLabels(locale) {
  return isTelegramChineseLocale(locale)
    ? {
      facts: '📌 关键信息',
      details: '📝 说明',
      actions: '👉 下一步',
      footer: 'ℹ️ 补充信息',
    }
    : {
      facts: '📌 Highlights',
      details: '📝 Details',
      actions: '👉 Next Steps',
      footer: 'ℹ️ More Info',
    };
}

function buildTelegramSection(title, content) {
  const text = coerceString(content);
  if (!text) return '';
  return `**${title}**\n${text}`;
}

function buildTelegramBodySections(model) {
  const labels = getTelegramSectionLabels(model.locale);
  const sections = [];
  if (model.facts.length > 0) {
    sections.push(buildTelegramSection(
      labels.facts,
      model.facts
        .map((fact) => `• **${fact.label}** ${fact.value}`.trim())
        .join('\n'),
    ));
  }
  if (model.sections.length > 0) {
    sections.push(buildTelegramSection(
      labels.details,
      model.sections.map((section) => section.text).join('\n\n'),
    ));
  }
  if (model.actions.length > 0) {
    sections.push(buildTelegramSection(
      labels.actions,
      model.actions
        .map((action) => (
          action.type === 'url' && action.url
            ? `• [${action.label}](${action.url})`
            : `• ${action.label}`
        ))
        .join('\n'),
    ));
  }
  if (model.footer) {
    sections.push(buildTelegramSection(labels.footer, model.footer));
  }
  return sections.filter(Boolean);
}

function buildTelegramTextLines(model) {
  const header = buildTelegramHeaderLines(model);
  const body = buildTelegramBodySections(model);
  if (header.length > 0 && body.length > 0) {
    return `${header.join('\n\n')}\n\n━━━━━━━━━━\n\n${body.join('\n\n')}`.trim();
  }
  if (header.length > 0) {
    return header.join('\n\n').trim();
  }
  return body.join('\n\n').trim();
}

function buildMessageModel({
  key,
  locale,
  title,
  theme = 'blue',
  summary = '',
  facts = [],
  sections = [],
  actions = [],
  footer = '',
  media = null,
}) {
  const model = {
    key,
    locale,
    title: coerceString(title),
    theme: coerceString(theme) || 'blue',
    summary: coerceString(summary),
    facts: facts.map(normalizeFact).filter(Boolean),
    sections: sections.map(normalizeSection).filter(Boolean),
    actions: actions.map(normalizeAction).filter(Boolean),
    footer: coerceString(footer),
    media,
  };
  model.fallback_text = buildTextLines(model, { markdown: false });
  return model;
}

function defineCatalogEntry(builders) {
  return builders;
}

function createPassiveActions(labels = []) {
  return labels.map((label) => ({ type: 'note', label }));
}

const MESSAGE_CATALOG = Object.freeze({
  'payment.success': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.success',
      locale: 'zh-CN',
      title: '✅ 支付成功',
      theme: 'green',
      facts: [
        ['支付金额', vars.amountDisplay],
        ['扣款方式', vars.cardDisplay],
        ['Clink 订单号', vars.orderId || 'N/A'],
      ],
      sections: ['已完成扣款，正在等待商户确认到账…'],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.success',
      locale: 'en-US',
      title: '✅ Payment Successful',
      theme: 'green',
      facts: [
        ['Amount', vars.amountDisplay],
        ['Payment Method', vars.cardDisplay],
        ['Clink Order ID', vars.orderId || 'N/A'],
      ],
      sections: ['The charge is complete and Clink is waiting for merchant confirmation.'],
    }),
  }),
  'payment.risk_reject': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.risk_reject',
      locale: 'zh-CN',
      title: '🛡️ 风控规则触发：充值被拦截',
      theme: 'red',
      facts: [
        ['充值金额', vars.amountDisplay],
        ['风控状态', '已拦截'],
        ['触发原因', vars.message || '风控规则触发'],
        ['订单号', vars.orderId || 'N/A'],
      ],
      sections: [vars.message || '当前充值请求触发了风控限制，请调整规则后重试。'],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.risk_reject',
      locale: 'en-US',
      title: '🛡️ Risk Rule Triggered',
      theme: 'red',
      facts: [
        ['Amount', vars.amountDisplay],
        ['Risk Status', 'Blocked'],
        ['Reason', vars.message || 'Risk rule triggered'],
        ['Order ID', vars.orderId || 'N/A'],
      ],
      sections: [vars.message || 'This recharge request was blocked by the active risk rules.'],
    }),
  }),
  'payment.failure': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.failure',
      locale: 'zh-CN',
      title: '❌ 支付失败',
      theme: 'red',
      facts: [
        ['支付金额', vars.amountDisplay],
        ['支付状态', '扣款失败'],
        ['失败原因', vars.failureReason || '支付处理异常'],
        ['订单号', vars.orderId || 'N/A'],
      ],
      sections: ['支付未完成，请检查支付方式或稍后重试。'],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.failure',
      locale: 'en-US',
      title: '❌ Payment Failed',
      theme: 'red',
      facts: [
        ['Amount', vars.amountDisplay],
        ['Status', 'Charge failed'],
        ['Reason', vars.failureReason || 'Payment processing error'],
        ['Order ID', vars.orderId || 'N/A'],
      ],
      sections: ['The payment did not complete. Check the payment method and try again later.'],
    }),
  }),
  'risk.rules_link': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'risk.rules_link',
      locale: 'zh-CN',
      title: '🛡️ 查看风控规则',
      theme: 'blue',
      sections: ['风控规则可限制自动充值的金额和频率，建议配置以保障资金安全。此步骤可选，可随时配置。'],
      actions: [{ type: 'url', label: '点击这里配置风控规则', url: vars.riskUrl }],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'risk.rules_link',
      locale: 'en-US',
      title: '🛡️ Review Risk Rules',
      theme: 'blue',
      sections: ['Risk rules limit auto-recharge amount and frequency. Configuring them is optional but strongly recommended.'],
      actions: [{ type: 'url', label: 'Configure Risk Rules', url: vars.riskUrl }],
    }),
  }),
  'payment.method.binding_required': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.method.binding_required',
      locale: 'zh-CN',
      title: '💳 需要绑定支付方式',
      theme: 'blue',
      facts: [
        ['Clink 账户', vars.email || 'N/A'],
        ['支付方式', '未绑定'],
      ],
      sections: ['完成绑定后 Claw 才能通过 Clink 执行充值。'],
      actions: [{ type: 'url', label: '立即绑定支付方式', url: vars.setupUrl }],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.method.binding_required',
      locale: 'en-US',
      title: '💳 Payment Method Required',
      theme: 'blue',
      facts: [
        ['Clink Account', vars.email || 'N/A'],
        ['Payment Method', 'Not bound'],
      ],
      sections: ['Bind a payment method before Claw can recharge through Clink.'],
      actions: [{ type: 'url', label: 'Bind Payment Method', url: vars.setupUrl }],
    }),
  }),
  'payment.method.bound_detected': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.method.bound_detected',
      locale: 'zh-CN',
      title: '💳 检测到已绑定的支付方式',
      theme: 'green',
      facts: [
        ['支付方式', `${vars.cardDisplay} ✓`],
        ['邮箱', `${vars.email || 'N/A'} ✓`],
        ['绑定状态', '已绑定 ✓'],
      ],
      sections: ['已有有效支付方式，无需重新绑卡。继续检测风控规则…'],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.method.bound_detected',
      locale: 'en-US',
      title: '💳 Payment Method Found',
      theme: 'green',
      facts: [
        ['Payment Method', `${vars.cardDisplay} ✓`],
        ['Email', `${vars.email || 'N/A'} ✓`],
        ['Binding Status', 'Bound ✓'],
      ],
      sections: ['A valid payment method is already bound, so no rebinding is needed.'],
    }),
  }),
  'payment.method.setup_link': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.method.setup_link',
      locale: 'zh-CN',
      title: '💳 添加支付方式',
      theme: 'blue',
      facts: [['Clink 账户', vars.email || 'N/A']],
      sections: ['绑定支付方式后，Clink 将代您自动完成 Token 充值。'],
      actions: [{ type: 'url', label: '前往添加支付方式', url: vars.setupUrl }],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.method.setup_link',
      locale: 'en-US',
      title: '💳 Add a Payment Method',
      theme: 'blue',
      facts: [['Clink Account', vars.email || 'N/A']],
      sections: ['After binding a payment method, Clink can complete future token top-ups automatically.'],
      actions: [{ type: 'url', label: 'Add Payment Method', url: vars.setupUrl }],
    }),
  }),
  'payment.method.manage_link': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.method.manage_link',
      locale: 'zh-CN',
      title: '⚙️ 管理支付方式',
      theme: 'blue',
      facts: [
        ['当前支付方式', vars.defaultCardDisplay || '未设置'],
        ['已绑定数量', `${vars.methodCount} 种`],
      ],
      sections: ['查看已绑定的支付方式，切换默认卡，或添加新的支付方式。'],
      actions: [{ type: 'url', label: '前往管理支付方式', url: vars.manageUrl }],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.method.manage_link',
      locale: 'en-US',
      title: '⚙️ Manage Payment Methods',
      theme: 'blue',
      facts: [
        ['Current Method', vars.defaultCardDisplay || 'Not set'],
        ['Bound Methods', `${vars.methodCount}`],
      ],
      sections: ['Review existing payment methods, switch the default card, or add a new one.'],
      actions: [{ type: 'url', label: 'Manage Payment Methods', url: vars.manageUrl }],
    }),
  }),
  'payment.method.detail': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.method.detail',
      locale: 'zh-CN',
      title: '💳 检测到已绑定的支付方式',
      theme: 'green',
      facts: [
        ['Card', vars.cardDisplay],
        ['Billing Region', vars.billingRegion || 'N/A'],
      ],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.method.detail',
      locale: 'en-US',
      title: '💳 Payment Method Detail',
      theme: 'green',
      facts: [
        ['Card', vars.cardDisplay],
        ['Billing Region', vars.billingRegion || 'N/A'],
      ],
    }),
  }),
  'payment.method.default_updated': defineCatalogEntry({
    'zh-CN': () => buildMessageModel({
      key: 'payment.method.default_updated',
      locale: 'zh-CN',
      title: '✅ 支付方式已更新',
      theme: 'green',
      facts: [['Status', '已更新 ✓']],
      sections: ['新的支付方式将用于后续自动充值。'],
    }),
    'en-US': () => buildMessageModel({
      key: 'payment.method.default_updated',
      locale: 'en-US',
      title: '✅ Default Payment Method Updated',
      theme: 'green',
      facts: [['Status', 'Updated ✓']],
      sections: ['The new payment method will be used for future auto top-ups.'],
    }),
  }),
  'payment.3ds_required': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.3ds_required',
      locale: 'zh-CN',
      title: '🔐 充值触发 3DS 验证',
      theme: 'orange',
      facts: [
        ['充值金额', vars.amountDisplay],
        ['商户', vars.merchantName],
        ['银行', `${vars.cardDisplay} 发卡行`],
        ['3DS 状态', '等待验证'],
        ['订单号', vars.orderId || 'N/A'],
      ],
      sections: ['银行要求对此次充值进行二次身份确认（3DS），任务已暂停等待您完成验证。'],
      actions: vars.redirectUrl ? [{ type: 'url', label: '前往完成 3DS 验证', url: vars.redirectUrl }] : [],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.3ds_required',
      locale: 'en-US',
      title: '🔐 3DS Verification Required',
      theme: 'orange',
      facts: [
        ['Amount', vars.amountDisplay],
        ['Merchant', vars.merchantName],
        ['Issuing Bank', vars.cardDisplay],
        ['3DS Status', 'Pending verification'],
        ['Order ID', vars.orderId || 'N/A'],
      ],
      sections: ['Your bank requires 3DS verification for this recharge. The task is paused until verification completes.'],
      actions: vars.redirectUrl ? [{ type: 'url', label: 'Complete 3DS Verification', url: vars.redirectUrl }] : [],
    }),
  }),
  'payment.blocked.customer_email_missing': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.blocked.customer_email_missing',
      locale: 'zh-CN',
      title: '🚫 充值被拦截：邮箱未设置',
      theme: 'red',
      facts: [
        ['Clink 账户', vars.email || 'N/A'],
        ['验证结果', '邮箱未找到'],
        ['拦截原因', 'Clink 账户邮箱不存在，无法完成身份校验'],
      ],
      sections: ['请确认 Clink 账户邮箱设置正确后重新发起充值。'],
      actions: createPassiveActions(['联系支持']),
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.blocked.customer_email_missing',
      locale: 'en-US',
      title: '🚫 Recharge Blocked: Email Missing',
      theme: 'red',
      facts: [
        ['Clink Account', vars.email || 'N/A'],
        ['Verification Result', 'Email not found'],
        ['Reason', 'The Clink account email is missing, so identity verification cannot complete'],
      ],
      sections: ['Confirm the Clink account email before retrying the recharge.'],
      actions: createPassiveActions(['Contact Support']),
    }),
  }),
  'payment.blocked.email_mismatch': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.blocked.email_mismatch',
      locale: 'zh-CN',
      title: '🚫 充值被拦截：邮箱不一致',
      theme: 'red',
      facts: [
        ['Clink 绑定邮箱', vars.email || 'N/A'],
        ['验证结果', '不一致'],
        ['拦截原因', '邮箱不匹配，存在账户归属风险'],
      ],
      sections: ['为保障资金安全，充值账户邮箱必须与商户账户邮箱完全一致。请前往商户控制台确认账户邮箱后重新发起充值。'],
      actions: createPassiveActions(['联系支持']),
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.blocked.email_mismatch',
      locale: 'en-US',
      title: '🚫 Recharge Blocked: Email Mismatch',
      theme: 'red',
      facts: [
        ['Clink Email', vars.email || 'N/A'],
        ['Verification Result', 'Mismatch'],
        ['Reason', 'The email does not match the merchant account email'],
      ],
      sections: ['For safety, the recharge account email must exactly match the merchant account email before retrying.'],
      actions: createPassiveActions(['Contact Support']),
    }),
  }),
  'payment.failed.merchant_not_found': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.failed.merchant_not_found',
      locale: 'zh-CN',
      title: '❌ 充值失败：商户不存在',
      theme: 'red',
      facts: [
        ['商户 ID', vars.merchantId],
        ['失败原因', '商户不存在'],
      ],
      sections: ['请检查商户 ID 是否正确。如果持续出现此问题，请联系 Clink 支持。'],
      actions: createPassiveActions(['联系支持']),
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.failed.merchant_not_found',
      locale: 'en-US',
      title: '❌ Recharge Failed: Merchant Not Found',
      theme: 'red',
      facts: [
        ['Merchant ID', vars.merchantId],
        ['Reason', 'Merchant not found'],
      ],
      sections: ['Verify the merchant ID and contact Clink support if the issue persists.'],
      actions: createPassiveActions(['Contact Support']),
    }),
  }),
  'payment.blocked.order_processing': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.blocked.order_processing',
      locale: 'zh-CN',
      title: '⏳ 充值请求被拦截：订单处理中',
      theme: 'orange',
      facts: [
        ['充值金额', vars.amountDisplay],
        ['拦截原因', '已有订单处理中'],
        ['状态', '⏸ 等待上一笔完成'],
      ],
      sections: ['当前有一笔充值订单正在处理中，请等待完成后再发起新的充值请求。'],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.blocked.order_processing',
      locale: 'en-US',
      title: '⏳ Recharge Blocked: Order Processing',
      theme: 'orange',
      facts: [
        ['Amount', vars.amountDisplay],
        ['Reason', 'Another order is still processing'],
        ['Status', '⏸ Waiting for previous order'],
      ],
      sections: ['Another recharge order is still in progress. Wait for it to finish before submitting a new one.'],
    }),
  }),
  'payment.failed.invalid_amount_or_currency': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.failed.invalid_amount_or_currency',
      locale: 'zh-CN',
      title: '❌ 充值失败：金额或币种错误',
      theme: 'red',
      facts: [
        ['请求金额', vars.amountDisplay],
        ['失败原因', '金额或币种不正确'],
      ],
      sections: ['请检查充值金额和币种是否正确后重试。'],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.failed.invalid_amount_or_currency',
      locale: 'en-US',
      title: '❌ Recharge Failed: Invalid Amount or Currency',
      theme: 'red',
      facts: [
        ['Requested Amount', vars.amountDisplay],
        ['Reason', 'Invalid amount or currency'],
      ],
      sections: ['Check the recharge amount and currency, then try again.'],
    }),
  }),
  'payment.failed.session_expired': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.failed.session_expired',
      locale: 'zh-CN',
      title: '⏳ 充值会话已过期',
      theme: 'orange',
      facts: [
        ['充值金额', vars.amountDisplay],
        ['失败原因', '充值会话已过期或不存在'],
      ],
      sections: ['请重新发起充值请求。'],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.failed.session_expired',
      locale: 'en-US',
      title: '⏳ Recharge Session Expired',
      theme: 'orange',
      facts: [
        ['Amount', vars.amountDisplay],
        ['Reason', 'The charge session is expired or missing'],
      ],
      sections: ['Create a new recharge request and try again.'],
    }),
  }),
  'payment.failed.session_merchant_mismatch': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.failed.session_merchant_mismatch',
      locale: 'zh-CN',
      title: '❌ 充值失败：商户信息不匹配',
      theme: 'red',
      facts: [
        ['商户 ID', vars.merchantId],
        ['失败原因', '商户信息与充值会话不一致'],
      ],
      sections: ['充值请求中的商户与原始会话中记录的商户不一致，请重新发起充值。'],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.failed.session_merchant_mismatch',
      locale: 'en-US',
      title: '❌ Recharge Failed: Merchant Mismatch',
      theme: 'red',
      facts: [
        ['Merchant ID', vars.merchantId],
        ['Reason', 'The merchant does not match the original session'],
      ],
      sections: ['The merchant in this recharge request does not match the original session. Start a new recharge flow.'],
    }),
  }),
  'payment.failed.auth': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.failed.auth',
      locale: 'zh-CN',
      title: '🔑 充值失败：认证错误',
      theme: 'red',
      facts: [
        ['失败原因', 'API Key 无效或已过期'],
        ['错误码', vars.code],
      ],
      sections: ['Clink 认证失败，可能是 API Key 已过期或无效。请尝试重新初始化钱包（initialize_wallet）。'],
      actions: createPassiveActions(['重新初始化']),
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.failed.auth',
      locale: 'en-US',
      title: '🔑 Recharge Failed: Authentication Error',
      theme: 'red',
      facts: [
        ['Reason', 'The API key is invalid or expired'],
        ['Error Code', vars.code],
      ],
      sections: ['Clink authentication failed. Reinitialize the wallet and try again.'],
      actions: createPassiveActions(['Reinitialize']),
    }),
  }),
  'payment.failed.timestamp': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.failed.timestamp',
      locale: 'zh-CN',
      title: '❌ 充值失败：请求时间异常',
      theme: 'red',
      facts: [
        ['失败原因', '请求时间戳无效或已过期'],
        ['错误码', vars.code],
      ],
      sections: ['请检查系统时间是否正确后重试。'],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.failed.timestamp',
      locale: 'en-US',
      title: '❌ Recharge Failed: Invalid Timestamp',
      theme: 'red',
      facts: [
        ['Reason', 'The request timestamp is invalid or expired'],
        ['Error Code', vars.code],
      ],
      sections: ['Check the system clock and retry with a fresh timestamp.'],
    }),
  }),
  'payment.blocked.risk_rule': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.blocked.risk_rule',
      locale: 'zh-CN',
      title: '🛡️ 风控规则触发：充值被拦截',
      theme: 'orange',
      facts: [
        ['充值金额', vars.amountDisplay],
        ['触发规则', vars.ruleName],
        ['规则详情', vars.ruleDetail],
        ['任务状态', '⏸ 已暂停'],
      ],
      sections: ['当前充值请求触发了风控安全规则，充值已暂停。'],
      actions: createPassiveActions(['继续充值', '修改风控规则', '暂停任务']),
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.blocked.risk_rule',
      locale: 'en-US',
      title: '🛡️ Recharge Blocked by Risk Rule',
      theme: 'orange',
      facts: [
        ['Amount', vars.amountDisplay],
        ['Rule', vars.ruleName],
        ['Rule Detail', vars.ruleDetail],
        ['Task Status', '⏸ Paused'],
      ],
      sections: ['This recharge request triggered an active safety rule and has been paused.'],
      actions: createPassiveActions(['Continue Recharge', 'Edit Risk Rules', 'Pause Task']),
    }),
  }),
  'payment.failed.card_declined': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.failed.card_declined',
      locale: 'zh-CN',
      title: '❌ 充值失败：银行拒绝',
      theme: 'red',
      facts: [
        ['充值金额', vars.amountDisplay],
        ['失败原因', 'CARD_DECLINED'],
        ['银行卡', '当前绑定卡'],
        ['任务状态', '⏸ 已暂停'],
      ],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.failed.card_declined',
      locale: 'en-US',
      title: '❌ Recharge Failed: Card Declined',
      theme: 'red',
      facts: [
        ['Amount', vars.amountDisplay],
        ['Reason', 'CARD_DECLINED'],
        ['Card', 'Current bound card'],
        ['Task Status', '⏸ Paused'],
      ],
    }),
  }),
  'payment.failed.change_payment_method': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.failed.change_payment_method',
      locale: 'zh-CN',
      title: '⚠️ 请更换支付方式以继续充值',
      theme: 'orange',
      facts: [
        ['建议操作', '更换银行卡或其他支付方式'],
        ['备注', '更换后如需继续充值请告知'],
      ],
      sections: ['当前卡片被银行拒绝，可能原因：卡片余额不足、已过期或账单地址不符。'],
      actions: vars.manageUrl
        ? [{ type: 'url', label: '前往更换支付方式', url: vars.manageUrl }, { type: 'note', label: '暂不处理' }]
        : createPassiveActions(['前往更换支付方式', '暂不处理']),
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.failed.change_payment_method',
      locale: 'en-US',
      title: '⚠️ Change Payment Method to Continue',
      theme: 'orange',
      facts: [
        ['Recommended Action', 'Switch to another card or payment method'],
        ['Note', 'Tell me when you are ready to retry'],
      ],
      sections: ['The current card was declined by the bank. Possible reasons include insufficient funds, expiry, or billing-address mismatch.'],
      actions: vars.manageUrl
        ? [{ type: 'url', label: 'Change Payment Method', url: vars.manageUrl }, { type: 'note', label: 'Not now' }]
        : createPassiveActions(['Change Payment Method', 'Not now']),
    }),
  }),
  'payment.failed.remote_service': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.failed.remote_service',
      locale: 'zh-CN',
      title: '❌ 充值失败：服务暂时不可用',
      theme: 'red',
      facts: [
        ['充值金额', vars.amountDisplay],
        ['失败原因', '远程服务调用失败'],
      ],
      sections: ['Clink 支付服务暂时不可用，请稍后重试。如果持续出现此问题，请联系支持。'],
      actions: createPassiveActions(['联系支持']),
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.failed.remote_service',
      locale: 'en-US',
      title: '❌ Recharge Failed: Service Unavailable',
      theme: 'red',
      facts: [
        ['Amount', vars.amountDisplay],
        ['Reason', 'Remote service call failed'],
      ],
      sections: ['The Clink payment service is temporarily unavailable. Try again later or contact support if the issue persists.'],
      actions: createPassiveActions(['Contact Support']),
    }),
  }),
  'payment.failed.unexpected': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.failed.unexpected',
      locale: 'zh-CN',
      title: '❌ 充值失败：处理异常',
      theme: 'red',
      facts: [
        ['充值金额', vars.amountDisplay],
        ['失败原因', vars.reason],
        ['错误码', vars.code || 'N/A'],
        ['状态', '失败'],
      ],
      sections: ['充值过程中出现异常，请稍后重试。如问题持续，请联系支付服务支持排查。'],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.failed.unexpected',
      locale: 'en-US',
      title: '❌ Recharge Failed: Unexpected Error',
      theme: 'red',
      facts: [
        ['Amount', vars.amountDisplay],
        ['Reason', vars.reason],
        ['Error Code', vars.code || 'N/A'],
        ['Status', 'Failed'],
      ],
      sections: ['An unexpected error occurred during recharge. Try again later or contact support if it persists.'],
    }),
  }),
  'payment.failed.charged_manual_review': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.failed.charged_manual_review',
      locale: 'zh-CN',
      title: '❌ 支付异常：已扣款待处理',
      theme: 'red',
      facts: [
        ['支付金额', vars.amountDisplay],
        ['支付状态', '已扣款，等待人工处理'],
        ['失败原因', vars.reason],
        ['订单号', vars.orderId || 'N/A'],
        ['扣款方式', vars.cardDisplay || 'N/A'],
      ],
      sections: ['支付网关侧已记录扣款异常，请勿重复支付。请携带以上订单号联系商户支持继续处理。'],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.failed.charged_manual_review',
      locale: 'en-US',
      title: '❌ Payment Exception: Charge Captured',
      theme: 'red',
      facts: [
        ['Amount', vars.amountDisplay],
        ['Status', 'Charged, pending manual review'],
        ['Reason', vars.reason],
        ['Order ID', vars.orderId || 'N/A'],
        ['Payment Method', vars.cardDisplay || 'N/A'],
      ],
      sections: ['The gateway recorded a charge exception. Do not retry the payment. Contact merchant support with the order ID above for manual follow-up.'],
    }),
  }),
  'refund.application_submitted': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'refund.application_submitted',
      locale: 'zh-CN',
      title: '⏳ 退款申请已提交',
      theme: 'blue',
      facts: [
        ['原订单号', vars.orderId],
        ['退款单号', vars.refundId],
        ['退款金额', vars.refundAmountDisplay],
        ['退款状态', vars.statusDisplay],
      ],
      sections: ['退款申请已提交至 Clink，正在等待处理。最终结果将通过后续通知自动推送。'],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'refund.application_submitted',
      locale: 'en-US',
      title: '⏳ Refund Request Submitted',
      theme: 'blue',
      facts: [
        ['Original Order ID', vars.orderId],
        ['Refund ID', vars.refundId],
        ['Refund Amount', vars.refundAmountDisplay],
        ['Refund Status', vars.statusDisplay],
      ],
      sections: ['The refund request was submitted to Clink and is waiting for processing.'],
    }),
  }),
  'refund.application_failed': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'refund.application_failed',
      locale: 'zh-CN',
      title: '❌ 退款申请失败',
      theme: 'red',
      facts: [
        ['原订单号', vars.orderId],
        ['失败原因', vars.reason],
        ['错误码', vars.code || 'N/A'],
      ],
      sections: [vars.description],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'refund.application_failed',
      locale: 'en-US',
      title: '❌ Refund Request Failed',
      theme: 'red',
      facts: [
        ['Original Order ID', vars.orderId],
        ['Reason', vars.reason],
        ['Error Code', vars.code || 'N/A'],
      ],
      sections: [vars.description],
    }),
  }),
  'install.success': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'install.success',
      locale: 'zh-CN',
      title: '✅ Clink Payment Skill 安装成功',
      theme: 'green',
      facts: [
        ['Webhook 路由', '已就绪 ✓'],
        ['网关重启', '后台处理中 ✓'],
      ],
      sections: [
        `请直接回复您的邮箱地址完成钱包初始化。${vars.userEmail ? `\n\n如需继续使用之前的邮箱，直接回复：\`${vars.userEmail}\`` : ''}\n\n若网关仍在重启中，稍候几秒后重试即可。`,
      ],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'install.success',
      locale: 'en-US',
      title: '✅ Clink Payment Skill Installed',
      theme: 'green',
      facts: [
        ['Webhook Route', 'Ready ✓'],
        ['Gateway Restart', 'Scheduled ✓'],
      ],
      sections: [
        `Reply with your email address to initialize the wallet.${vars.userEmail ? `\n\nTo keep using the previous email, simply reply with \`${vars.userEmail}\`.` : ''}\n\nIf the gateway is still restarting, wait a few seconds and retry.`,
      ],
    }),
  }),
  'uninstall.completed': defineCatalogEntry({
    'zh-CN': () => buildMessageModel({
      key: 'uninstall.completed',
      locale: 'zh-CN',
      title: '🗑️ 卸载已生效',
      theme: 'green',
      sections: ['网关已重启完毕，Clink Payment 支付组件及全部配置已彻底清除。若需再次使用，请重新下发安装指令。'],
    }),
    'en-US': () => buildMessageModel({
      key: 'uninstall.completed',
      locale: 'en-US',
      title: '🗑️ Uninstall Complete',
      theme: 'green',
      sections: ['The gateway restart is complete and all Clink Payment files and configuration have been removed.'],
    }),
  }),
  'uninstall.in_progress': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'uninstall.in_progress',
      locale: 'zh-CN',
      title: '🗑️ Clink Payment Skill 卸载执行中',
      theme: 'orange',
      facts: [
        ...(Array.isArray(vars.results) ? vars.results.map((item) => ['执行结果', item]) : []),
        ['网关状态', '执行完成后自动重启'],
      ],
      sections: ['正在卸载 Clink Payment 支付组件及相关配置。卸载完成后将自动重启 gateway 生效。'],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'uninstall.in_progress',
      locale: 'en-US',
      title: '🗑️ Clink Payment Uninstall Running',
      theme: 'orange',
      facts: [
        ...(Array.isArray(vars.results) ? vars.results.map((item) => ['Result', item]) : []),
        ['Gateway Status', 'Will restart after uninstall'],
      ],
      sections: ['Clink Payment files and configuration are being removed. The gateway will restart automatically afterward.'],
    }),
  }),
  'payment.method.bound_success': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.method.bound_success',
      locale: 'zh-CN',
      title: '✅ 支付方式绑定成功',
      theme: 'green',
      facts: [
        ['绑定支付方式', vars.cardDisplay],
        ['邮箱', vars.email],
      ],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.method.bound_success',
      locale: 'en-US',
      title: '✅ Payment Method Bound',
      theme: 'green',
      facts: [
        ['Payment Method', vars.cardDisplay],
        ['Email', vars.email],
      ],
    }),
  }),
  'wallet.initialized_complete': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'wallet.initialized_complete',
      locale: 'zh-CN',
      title: '🎉 Clink 初始化完成！',
      theme: 'green',
      facts: [
        ['绑定支付方式', `${vars.cardDisplay} ✓`],
        ['规则状态', '已生效'],
      ],
      sections: ['你现在可以部署自动充值任务。风控规则可选，可随时通过「查看风控规则」配置。如需修改支付方式，请告知我。'],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'wallet.initialized_complete',
      locale: 'en-US',
      title: '🎉 Clink Setup Complete',
      theme: 'green',
      facts: [
        ['Payment Method', `${vars.cardDisplay} ✓`],
        ['Rule Status', 'Active'],
      ],
      sections: ['You can now deploy auto-top-up tasks. Risk rules are optional and can be updated later.'],
    }),
  }),
  'payment.method.default_changed_webhook': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'payment.method.default_changed_webhook',
      locale: 'zh-CN',
      title: '✅ 默认支付方式已更新',
      theme: 'green',
      facts: [
        ['当前默认卡', vars.cardDisplay],
        ['支付方式 ID', vars.paymentInstrumentId || 'N/A'],
      ],
      sections: ['后续付款将优先使用这张卡。如需继续之前失败的支付，请直接告诉我重新发起。'],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'payment.method.default_changed_webhook',
      locale: 'en-US',
      title: '✅ Default Payment Method Updated',
      theme: 'green',
      facts: [
        ['Current Default Card', vars.cardDisplay],
        ['Payment Instrument ID', vars.paymentInstrumentId || 'N/A'],
      ],
      sections: ['Future payments will prefer this card. Tell me if you want to retry the previous charge.'],
    }),
  }),
  'refund.event_succeeded': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'refund.event_succeeded',
      locale: 'zh-CN',
      title: '✅ 退款成功',
      theme: 'green',
      facts: [
        ['退款金额', vars.amountDisplay],
        ['原订单号', vars.orderId],
        ['退款单号', vars.refundId],
        ['退款方式', vars.cardDisplay],
        ['退款状态', '成功'],
      ],
      sections: ['退款申请已处理成功，资金将按发卡行或支付渠道的到账时效原路退回。'],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'refund.event_succeeded',
      locale: 'en-US',
      title: '✅ Refund Successful',
      theme: 'green',
      facts: [
        ['Refund Amount', vars.amountDisplay],
        ['Original Order ID', vars.orderId],
        ['Refund ID', vars.refundId],
        ['Refund Method', vars.cardDisplay],
        ['Refund Status', 'Succeeded'],
      ],
      sections: ['The refund completed successfully and the funds will return to the original payment method.'],
    }),
  }),
  'refund.event_approved': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'refund.event_approved',
      locale: 'zh-CN',
      title: '✅ 退款已通过',
      theme: 'green',
      facts: [
        ['退款金额', vars.amountDisplay],
        ['原订单号', vars.orderId],
        ['退款单号', vars.refundId],
        ['退款方式', vars.cardDisplay],
        ['退款状态', '成功'],
      ],
      sections: ['退款申请已审核通过，资金将按发卡行或支付渠道的到账时效原路退回。'],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'refund.event_approved',
      locale: 'en-US',
      title: '✅ Refund Approved',
      theme: 'green',
      facts: [
        ['Refund Amount', vars.amountDisplay],
        ['Original Order ID', vars.orderId],
        ['Refund ID', vars.refundId],
        ['Refund Method', vars.cardDisplay],
        ['Refund Status', 'Approved'],
      ],
      sections: ['The refund request was approved and the funds will return to the original payment method.'],
    }),
  }),
  'refund.event_failed': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'refund.event_failed',
      locale: 'zh-CN',
      title: '❌ 退款失败',
      theme: 'red',
      facts: [
        ['退款金额', vars.amountDisplay],
        ['原订单号', vars.orderId],
        ['退款单号', vars.refundId],
        ['退款方式', vars.cardDisplay],
        ['失败原因', vars.reason],
      ],
      sections: ['退款申请未能成功处理，请稍后重试或联系 Clink 支持排查。'],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'refund.event_failed',
      locale: 'en-US',
      title: '❌ Refund Failed',
      theme: 'red',
      facts: [
        ['Refund Amount', vars.amountDisplay],
        ['Original Order ID', vars.orderId],
        ['Refund ID', vars.refundId],
        ['Refund Method', vars.cardDisplay],
        ['Reason', vars.reason],
      ],
      sections: ['The refund request could not be processed. Try again later or contact Clink support.'],
    }),
  }),
  'refund.event_rejected': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'refund.event_rejected',
      locale: 'zh-CN',
      title: '❌ 退款已拒绝',
      theme: 'red',
      facts: [
        ['退款金额', vars.amountDisplay],
        ['原订单号', vars.orderId],
        ['退款单号', vars.refundId],
        ['退款方式', vars.cardDisplay],
        ['失败原因', vars.reason],
      ],
      sections: ['退款申请未通过审核，请根据失败原因调整后再试或联系 Clink 支持排查。'],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'refund.event_rejected',
      locale: 'en-US',
      title: '❌ Refund Rejected',
      theme: 'red',
      facts: [
        ['Refund Amount', vars.amountDisplay],
        ['Original Order ID', vars.orderId],
        ['Refund ID', vars.refundId],
        ['Refund Method', vars.cardDisplay],
        ['Reason', vars.reason],
      ],
      sections: ['The refund request was rejected. Review the failure reason and retry later if appropriate.'],
    }),
  }),
  'risk_rule.updated': defineCatalogEntry({
    'zh-CN': (vars) => buildMessageModel({
      key: 'risk_rule.updated',
      locale: 'zh-CN',
      title: '🛡️ 风控规则已生效',
      theme: 'green',
      facts: [
        ['单次上限', vars.singleRechargeLimit ?? 'N/A'],
        ['每日总额', vars.dailyTotalLimit ?? 'N/A'],
        ['每日次数', `${vars.dailyMaxCount ?? 'N/A'} 次`],
        ['充值间隔', vars.rechargeInterval ?? 'N/A'],
      ],
      sections: ['风控规则已同步生效，后续充值将按此规则执行。'],
    }),
    'en-US': (vars) => buildMessageModel({
      key: 'risk_rule.updated',
      locale: 'en-US',
      title: '🛡️ Risk Rules Updated',
      theme: 'green',
      facts: [
        ['Single Limit', vars.singleRechargeLimit ?? 'N/A'],
        ['Daily Total', vars.dailyTotalLimit ?? 'N/A'],
        ['Daily Count', `${vars.dailyMaxCount ?? 'N/A'}`],
        ['Recharge Interval', vars.rechargeInterval ?? 'N/A'],
      ],
      sections: ['The risk rules are now active and future recharges will follow them.'],
    }),
  }),
});

export function createMessageRequest({ messageKey, vars = {}, locale = 'auto', deliveryPolicy = {} }) {
  const key = coerceString(messageKey);
  if (!key) {
    throw new Error('messageKey is required');
  }
  if (!MESSAGE_CATALOG[key]) {
    throw new Error(`Unknown message key: ${key}`);
  }
  const normalizedVars = vars && typeof vars === 'object' && !Array.isArray(vars)
    ? JSON.parse(JSON.stringify(vars))
    : {};
  return {
    message_key: key,
    vars: normalizedVars,
    locale: locale === 'auto' ? 'auto' : normalizeLocaleTag(locale) || 'auto',
    delivery_policy: normalizeDeliveryPolicy(deliveryPolicy),
  };
}

export function compileMessage(request, { preferredLocale = 'auto' } = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Message request must be an object');
  }
  const key = coerceString(request.message_key || request.messageKey);
  if (!key) {
    throw new Error('message_key is required');
  }
  const entry = MESSAGE_CATALOG[key];
  if (!entry) {
    throw new Error(`Unknown message key: ${key}`);
  }
  const requestLocale = request.locale === 'auto' ? 'auto' : normalizeLocaleTag(request.locale);
  const requestedChain = resolveLocaleChain(requestLocale === 'auto' ? preferredLocale : requestLocale);
  const availableLocales = Object.keys(entry);
  const locale = requestedChain.find((candidate) => availableLocales.includes(candidate))
    || availableLocales[0];
  const builder = entry[locale];
  if (typeof builder !== 'function') {
    throw new Error(`Message key ${key} does not support locale ${locale}`);
  }
  return builder(request.vars || {});
}

export function renderMessageMarkdown(input, options = {}) {
  const model = input?.message_key ? compileMessage(input, options) : input;
  return buildTextLines(model, { markdown: true });
}

export function renderMessagePlainText(input, options = {}) {
  const model = input?.message_key ? compileMessage(input, options) : input;
  return buildTextLines(model, { markdown: false });
}

export function renderMessageTelegramText(input, options = {}) {
  const model = input?.message_key ? compileMessage(input, options) : input;
  return buildTelegramTextLines(model);
}

export function renderMessageFeishuCard(input, options = {}) {
  const model = input?.message_key ? compileMessage(input, options) : input;
  const elements = [];

  if (model.summary) {
    elements.push({ tag: 'markdown', content: model.summary });
  }

  if (model.facts.length > 0) {
    if (elements.length > 0) elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: model.facts.map((fact) => `**${fact.label}**　${fact.value}`).join('\n'),
    });
  }

  if (model.sections.length > 0) {
    if (elements.length > 0) elements.push({ tag: 'hr' });
    model.sections.forEach((section) => {
      elements.push({
        tag: 'markdown',
        content: section.text,
      });
    });
  }

  if (model.actions.length > 0) {
    if (elements.length > 0) elements.push({ tag: 'hr' });
    const passiveActions = model.actions.filter((action) => action.type !== 'url' || !action.url);
    if (passiveActions.length > 0) {
      elements.push({
        tag: 'markdown',
        content: passiveActions.map((action) => `- ${action.label}`).join('\n'),
      });
    }
    model.actions
      .filter((action) => action.type === 'url' && action.url)
      .forEach((action) => {
        elements.push({
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: action.label,
          },
          multi_url: {
            url: action.url,
            pc_url: action.url,
            ios_url: action.url,
            android_url: action.url,
          },
        });
      });
  }

  if (model.footer) {
    if (elements.length > 0) elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: model.footer,
    });
  }

  return {
    schema: '2.0',
    header: {
      title: {
        tag: 'plain_text',
        content: model.title || 'Notification',
      },
      template: model.theme,
    },
    body: {
      elements,
    },
  };
}

export function renderMessageTelegramCard(input, options = {}) {
  const model = input?.message_key ? compileMessage(input, options) : input;
  return {
    schema: 'telegram-card/v1',
    version: 1,
    mode: model.media ? 'media_card' : 'text_card',
    card: {
      title: model.title,
      theme: model.theme,
      summary: model.summary,
      facts: model.facts.map((fact) => ({ label: fact.label, value: fact.value })),
      sections: model.sections.map((section) => ({ type: section.type, text: section.text })),
      actions: model.actions.map((action) => ({
        type: action.type,
        label: action.label,
        ...(action.url ? { url: action.url } : {}),
      })),
      ...(model.footer ? { footer: model.footer } : {}),
      ...(model.media ? { media: model.media } : {}),
    },
  };
}

export function resolvePreferredLocale(...candidates) {
  for (const candidate of candidates) {
    const normalized = normalizeLocaleTag(candidate);
    if (normalized) return normalized;
  }
  return DEFAULT_LOCALE;
}

export function normalizeDeliveryMessageRequest(value, { preferredLocale = 'auto' } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Message request payload must be an object');
  }
  return createMessageRequest({
    messageKey: value.message_key || value.messageKey,
    vars: value.vars || {},
    locale: value.locale === 'auto' ? preferredLocale : (value.locale || preferredLocale || 'auto'),
    deliveryPolicy: value.delivery_policy || value.deliveryPolicy || DEFAULT_DELIVERY_POLICY,
  });
}

export function buildMessagePreviewTitle(input, options = {}) {
  const model = input?.message_key ? compileMessage(input, options) : input;
  return model.title || model.key;
}

export function isMessageRequest(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value.message_key || value.messageKey));
}

export function listSupportedMessageKeys() {
  return Object.keys(MESSAGE_CATALOG);
}
