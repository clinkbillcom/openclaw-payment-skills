#!/usr/bin/env node
/**
 * Standalone Feishu card sender — no external dependencies.
 * Reads Feishu credentials from ~/.openclaw/openclaw.json.
 *
 * Usage:
 *   node send-feishu-card.mjs <card-file.json> --chat-id oc_xxx
 *   node send-feishu-card.mjs --json '{"schema":"2.0",...}' --chat-id oc_xxx
 *   node send-feishu-card.mjs <card-file.json> --open-id ou_xxx
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

// --- Parse args ---
const args = process.argv.slice(2);
let cardFile = null;
let cardJsonStr = null;
let chatId = null;
let openId = null;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--chat-id':    chatId    = args[++i]; break;
    case '--open-id':   openId    = args[++i]; break;
    case '--json':      cardJsonStr = args[++i]; break;
    default:
      if (!args[i].startsWith('--')) cardFile = args[i];
  }
}

const receiveId     = chatId ?? openId;
const receiveIdType = openId ? 'open_id' : 'chat_id';

if (!receiveId) {
  console.error('Error: --chat-id or --open-id is required');
  process.exit(1);
}
if (!cardFile && !cardJsonStr) {
  console.error('Error: provide a card file path or --json <json-string>');
  process.exit(1);
}

// --- Load card ---
let card;
try {
  if (cardJsonStr) {
    card = JSON.parse(cardJsonStr);
  } else {
    const p = path.isAbsolute(cardFile) ? cardFile : path.resolve(process.cwd(), cardFile);
    card = JSON.parse(fs.readFileSync(p, 'utf-8'));
  }
} catch (e) {
  console.error('Error loading card:', e.message);
  process.exit(1);
}

// --- Load OpenClaw config ---
const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (e) {
  console.error('Error reading openclaw.json:', e.message);
  process.exit(1);
}

const accounts = config?.channels?.feishu?.accounts;
if (!accounts) {
  console.error('Error: No feishu accounts found in ~/.openclaw/openclaw.json');
  process.exit(1);
}
const account = accounts.main ?? Object.values(accounts)[0];
if (!account?.appId || !account?.appSecret) {
  console.error('Error: Feishu account is missing appId or appSecret');
  process.exit(1);
}

// --- Feishu API calls ---
async function getTenantAccessToken() {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: account.appId, app_secret: account.appSecret }),
  });
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
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Send failed: ${data.msg} (code: ${data.code})`);
  console.log(`✅ Card sent (message_id: ${data.data?.message_id})`);
}

getTenantAccessToken()
  .then(sendCard)
  .catch(e => { console.error('❌', e.message); process.exit(1); });
