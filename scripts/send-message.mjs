#!/usr/bin/env node
import { execFileSync } from 'child_process';
import path from 'path';
import { renderNotificationFeishuCard, renderNotificationMarkdown } from '../notification-utils.js';

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const FEISHU_CARD_SENDER = path.join(SCRIPT_DIR, 'send-feishu-card.mjs');

function parseArgs(argv) {
  let payloadJson = '';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--payload') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--payload requires a JSON value');
      }
      payloadJson = value;
      i++;
      continue;
    }
  }

  if (!payloadJson) {
    throw new Error('Missing --payload');
  }

  const payload = JSON.parse(payloadJson);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Payload must be a JSON object');
  }
  return payload;
}

function sanitizeInlineMarkup(text) {
  return String(text || '')
    .replace(/<font\b[^>]*>/gi, '')
    .replace(/<\/font>/gi, '')
    .replace(/<at\b[^>]*>(.*?)<\/at>/gi, '$1')
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    .trim();
}

function getElementText(element) {
  if (!element || typeof element !== 'object') {
    return '';
  }

  if (typeof element.content === 'string') {
    return sanitizeInlineMarkup(element.content);
  }

  if (element.text && typeof element.text === 'object' && typeof element.text.content === 'string') {
    return sanitizeInlineMarkup(element.text.content);
  }

  return '';
}

function getActionUrl(action) {
  if (!action || typeof action !== 'object') {
    return '';
  }
  if (typeof action.url === 'string' && action.url.trim()) {
    return action.url.trim();
  }
  const multiUrl = action.multi_url;
  if (!multiUrl || typeof multiUrl !== 'object') {
    return '';
  }
  return (
    multiUrl.url ||
    multiUrl.pc_url ||
    multiUrl.android_url ||
    multiUrl.ios_url ||
    ''
  ).trim();
}

function renderElement(element) {
  if (!element || typeof element !== 'object') {
    return '';
  }

  if (element.tag === 'hr') {
    return '---';
  }

  if (element.tag === 'action' && Array.isArray(element.actions)) {
    const lines = element.actions
      .map((action) => {
        const label = getElementText(action.text || action);
        const url = getActionUrl(action);
        if (url) {
          return `- [${label || 'Open'}](${url})`;
        }
        return label ? `- ${label}` : '';
      })
      .filter(Boolean);
    return lines.join('\n');
  }

  if (element.tag === 'button') {
    const label = getElementText(element.text || element);
    const url = getActionUrl(element);
    if (url) {
      return `- [${label || 'Open'}](${url})`;
    }
    return label ? `- ${label}` : '';
  }

  if (element.tag === 'note' && Array.isArray(element.elements)) {
    const parts = element.elements.map(renderElement).filter(Boolean);
    return parts.join('\n');
  }

  if (element.tag === 'column_set' && Array.isArray(element.columns)) {
    const parts = element.columns
      .map((column) => (Array.isArray(column.elements) ? column.elements.map(renderElement).filter(Boolean).join('\n') : ''))
      .filter(Boolean);
    return parts.join('\n');
  }

  return getElementText(element);
}

function renderCardToMarkdown(card) {
  const sections = [];
  const title = sanitizeInlineMarkup(card?.header?.title?.content || '');
  if (title) {
    sections.push(`**${title}**`);
  }

  const elements = Array.isArray(card?.elements)
    ? card.elements
    : Array.isArray(card?.body?.elements)
      ? card.body.elements
      : [];

  for (const element of elements) {
    const rendered = renderElement(element);
    if (rendered) {
      sections.push(rendered);
    }
  }

  return sections.join('\n\n').trim();
}

function buildSimpleFeishuCard(text) {
  return {
    schema: '2.0',
    header: {
      title: {
        content: '通知',
        tag: 'plain_text',
      },
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: String(text || '').trim(),
        },
      ],
    },
  };
}

function resolveNotification(payload) {
  if (payload.notification && typeof payload.notification === 'object' && !Array.isArray(payload.notification)) {
    return payload.notification;
  }
  return null;
}

function normalizeTarget(payload) {
  const channel = typeof payload.channel === 'string' && payload.channel.trim()
    ? payload.channel.trim().toLowerCase()
    : '';
  const targetType = typeof payload?.target?.type === 'string' && payload.target.type.trim()
    ? payload.target.type.trim()
    : '';
  const targetId = typeof payload?.target?.id === 'string' && payload.target.id.trim()
    ? payload.target.id.trim()
    : '';
  if (!channel) throw new Error('channel is required');
  if (!targetType) throw new Error('target.type is required');
  if (!targetId) throw new Error('target.id is required');
  return { channel, targetType, targetId };
}

function sendFeishuCard(payload) {
  const { targetId, targetType } = normalizeTarget(payload);
  if (targetType !== 'chat_id' && targetType !== 'open_id') {
    throw new Error('Feishu target.type must be "chat_id" or "open_id"');
  }
  const targetFlag = targetType === 'open_id' ? '--open-id' : '--chat-id';
  execFileSync(
    process.execPath,
    [FEISHU_CARD_SENDER, '--json', JSON.stringify(payload.card), targetFlag, targetId],
    {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 15000,
    },
  );
}

function sendFeishuText(payload) {
  const notification = resolveNotification(payload);
  const text = notification
    ? renderNotificationMarkdown(notification)
    : typeof payload.text === 'string' && payload.text.trim()
      ? payload.text.trim()
      : renderCardToMarkdown(payload.card);
  if (!text) {
    throw new Error('No text content available for Feishu delivery');
  }
  sendFeishuCard({
    ...payload,
    card: buildSimpleFeishuCard(text),
  });
}

function sendViaOpenClawMessage(payload) {
  const { channel, targetId } = normalizeTarget(payload);
  if (channel === 'feishu') {
    throw new Error('Feishu delivery must use the Feishu adapters');
  }
  const notification = resolveNotification(payload);
  const text = notification
    ? renderNotificationMarkdown(notification)
    : typeof payload.text === 'string' && payload.text.trim()
      ? payload.text.trim()
      : renderCardToMarkdown(payload.card);
  if (!text) {
    throw new Error('No text content available for delivery');
  }
  execFileSync(
    'openclaw',
    ['message', 'send', '--channel', channel, '--target', targetId, '--message', text],
    {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30000,
    },
  );
}

async function main() {
  const payload = parseArgs(process.argv.slice(2));
  const hasMedia = (
    (typeof payload.mediaUrl === 'string' && payload.mediaUrl.trim()) ||
    (Array.isArray(payload.mediaUrls) && payload.mediaUrls.some((entry) => typeof entry === 'string' && entry.trim()))
  );
  if (hasMedia) {
    throw new Error('agent-payment-skills notifications do not support media delivery');
  }
  const channel = typeof payload.channel === 'string' ? payload.channel.trim().toLowerCase() : '';
  const notification = resolveNotification(payload);
  if (notification && channel === 'feishu') {
    sendFeishuCard({
      ...payload,
      card: renderNotificationFeishuCard(notification),
    });
    return;
  }
  if (notification) {
    sendViaOpenClawMessage(payload);
    return;
  }
  if ((payload.card || payload.text) && channel === 'feishu' && payload.card) {
    sendFeishuCard(payload);
    return;
  }
  if (channel === 'feishu') {
    sendFeishuText(payload);
    return;
  }
  sendViaOpenClawMessage(payload);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
