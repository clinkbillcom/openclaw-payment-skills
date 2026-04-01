#!/usr/bin/env node
/**
 * Standalone Feishu card sender — no external dependencies.
 * Reads Feishu credentials from ~/.openclaw/openclaw.json.
 *
 * Usage:
 *   node send-feishu-card.mjs <card-file.json> --chat-id oc_xxx
 *   node send-feishu-card.mjs --json '{"config":{},"header":{},"elements":[]}' --chat-id oc_xxx
 *   node send-feishu-card.mjs <card-file.json> --open-id ou_xxx
 *
 * Card format: { "config": { "wide_screen_mode": true }, "header": {...}, "elements": [...] }
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const LOG_PATH = path.join(SCRIPT_DIR, '..', 'error.log');

function logScriptError(context, error) {
  const parts = [
    `[${new Date().toISOString()}] [${context}]`,
    error instanceof Error ? error.stack || error.message : String(error),
  ];
  try {
    fs.appendFileSync(LOG_PATH, `${parts.join('\n')}\n`, 'utf8');
  } catch {}
}

function fail(message, error = null) {
  const finalMessage = error instanceof Error ? `${message}: ${error.message}` : message;
  logScriptError('scripts/send-feishu-card', error ?? new Error(finalMessage));
  console.error(finalMessage);
  process.exitCode = 1;
  process.exit();
}

// --- Parse args ---
const args = process.argv.slice(2);
let cardFile = null;
let cardJsonStr = null;
let chatId = null;
let openId = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--chat-id' || arg === '--open-id' || arg === '--json') {
    const val = args[i + 1];
    if (!val || val.startsWith('--')) {
      fail(`Error: ${arg} requires a value`);
    }
    i++;
    if (arg === '--chat-id')  chatId      = val;
    if (arg === '--open-id')  openId      = val;
    if (arg === '--json')     cardJsonStr = val;
  } else if (!arg.startsWith('--')) {
    cardFile = arg;
  }
}

if (chatId && openId) {
  fail('Error: provide --chat-id or --open-id, not both');
}

const receiveId     = chatId ?? openId;
const receiveIdType = openId ? 'open_id' : 'chat_id';

if (!receiveId) {
  fail('Error: --chat-id or --open-id is required');
}
if (!cardFile && !cardJsonStr) {
  fail('Error: provide a card file path or --json <json-string>');
}

// --- Load card ---
let card;
try {
  if (cardJsonStr) {
    card = JSON.parse(cardJsonStr);
  } else {
    // Expand ~ to home directory
    const expanded = cardFile.startsWith('~/')
      ? path.join(os.homedir(), cardFile.slice(2))
      : cardFile;
    const p = path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);
    card = JSON.parse(fs.readFileSync(p, 'utf-8'));
  }
} catch (e) {
  fail('Error loading card', e);
}

// --- Load OpenClaw config ---
const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (e) {
  fail('Error reading openclaw.json', e);
}

const feishuConfig = config?.channels?.feishu;
const accounts = feishuConfig?.accounts;
const defaultAccountId =
  typeof feishuConfig?.defaultAccount === 'string' ? feishuConfig.defaultAccount.trim() : '';
const account =
  (defaultAccountId ? accounts?.[defaultAccountId] : null) ??
  accounts?.main ??
  accounts?.default ??
  (accounts ? Object.values(accounts)[0] : null) ??
  feishuConfig;
const appId = account?.appId ?? feishuConfig?.appId;
const appSecret = account?.appSecret ?? feishuConfig?.appSecret;
if (!appId || !appSecret) {
  fail('Error: Feishu account is missing appId or appSecret');
}

// --- Feishu API calls ---
async function getTenantAccessToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  if (!res.ok) throw new Error(`Auth HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Auth failed: ${data.msg}`);
  return data.tenant_access_token;
}

async function sendCard(token) {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      }),
    },
  );
  if (!res.ok) throw new Error(`Send HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Send failed: ${data.msg} (code: ${data.code})`);
  console.log(`✅ Card sent (message_id: ${data.data?.message_id})`);
}

(async () => {
  const token = await getTenantAccessToken();
  await sendCard(token);
})().catch(e => {
  logScriptError('scripts/send-feishu-card', e);
  console.error('❌', e.message);
  process.exitCode = 1;
});
