function normalizeDetails(details) {
  if (!Array.isArray(details)) return [];
  return details
    .map((detail) => {
      if (!detail) return null;
      if (Array.isArray(detail) && detail.length >= 2) {
        return { label: String(detail[0] || '').trim(), value: String(detail[1] || '').trim() };
      }
      if (typeof detail === 'object') {
        const label = typeof detail.label === 'string' ? detail.label.trim() : '';
        const value = detail.value === undefined || detail.value === null ? '' : String(detail.value).trim();
        if (!label || !value) return null;
        return { label, value };
      }
      return null;
    })
    .filter(Boolean);
}

function normalizeParagraphs(paragraphs) {
  if (!Array.isArray(paragraphs)) return [];
  return paragraphs
    .map((paragraph) => (paragraph === undefined || paragraph === null ? '' : String(paragraph).trim()))
    .filter(Boolean);
}

function normalizeActions(actions) {
  if (!Array.isArray(actions)) return [];
  return actions
    .map((action) => {
      if (!action || typeof action !== 'object') return null;
      const label = typeof action.label === 'string' ? action.label.trim() : '';
      const url = typeof action.url === 'string' ? action.url.trim() : '';
      if (!label) return null;
      return { label, url };
    })
    .filter(Boolean);
}

function createNotification(input) {
  const notification = input && typeof input === 'object' ? input : {};
  return {
    title: typeof notification.title === 'string' ? notification.title.trim() : '',
    theme: typeof notification.theme === 'string' && notification.theme.trim() ? notification.theme.trim() : 'blue',
    details: normalizeDetails(notification.details),
    paragraphs: normalizeParagraphs(notification.paragraphs),
    actions: normalizeActions(notification.actions),
  };
}

function renderNotificationMarkdown(notification) {
  const normalized = createNotification(notification);
  const sections = [];

  if (normalized.title) {
    sections.push(`**${normalized.title}**`);
  }

  if (normalized.details.length > 0) {
    sections.push(normalized.details.map((detail) => `**${detail.label}** ${detail.value}`).join('\n'));
  }

  if (normalized.paragraphs.length > 0) {
    sections.push(normalized.paragraphs.join('\n\n'));
  }

  if (normalized.actions.length > 0) {
    sections.push(
      normalized.actions
        .map((action) => (action.url ? `- [${action.label}](${action.url})` : `- ${action.label}`))
        .join('\n'),
    );
  }

  return sections.join('\n\n').trim();
}

function renderNotificationFeishuCard(notification) {
  const normalized = createNotification(notification);
  const elements = [];

  if (normalized.details.length > 0) {
    elements.push({
      tag: 'markdown',
      content: normalized.details.map((detail) => `**${detail.label}**　${detail.value}`).join('\n'),
    });
  }

  if (normalized.paragraphs.length > 0) {
    if (elements.length > 0) {
      elements.push({ tag: 'hr' });
    }
    for (const paragraph of normalized.paragraphs) {
      elements.push({
        tag: 'markdown',
        content: paragraph,
      });
    }
  }

  if (normalized.actions.length > 0) {
    if (elements.length > 0) {
      elements.push({ tag: 'hr' });
    }
    elements.push({
      tag: 'action',
      actions: normalized.actions.map((action) => ({
        tag: 'button',
        text: {
          tag: 'plain_text',
          content: action.label,
        },
        ...(action.url ? { url: action.url } : {}),
      })),
    });
  }

  return {
    schema: '2.0',
    header: {
      title: {
        content: normalized.title || '通知',
        tag: 'plain_text',
      },
      template: normalized.theme,
    },
    body: {
      elements,
    },
  };
}

module.exports = {
  createNotification,
  renderNotificationMarkdown,
  renderNotificationFeishuCard,
};
