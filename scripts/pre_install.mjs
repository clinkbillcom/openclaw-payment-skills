#!/usr/bin/env node
/**
 * Pre-install script for agent-payment-skills.
 * No npm dependencies — only Node.js built-ins.
 *
 * Usage:
 *   node pre_install.mjs --channel feishu --target-id oc_xxx --target-type chat_id
 *   node pre_install.mjs --channel feishu --target-id ou_xxx --target-type open_id
 *   node pre_install.mjs --channel telegram --target-id 12345 --target-type target_id
 *
 * What it does (all in one):
 *   1. Registers the MCP server via npx mcporter --config <path> config add
 *   2. Stores notifyDestination in clink.config.json
 *   3. Copies hooks/my_payment_webhook.js → ~/.openclaw/hooks/transforms/
 *   4. Injects webhook mapping into ~/.openclaw/openclaw.json and verifies
 *   5. Writes + spawns background notify process (polls for gateway, then sends post-restart notification)
 *   6. Sends the status notification
 *
 * After this script exits, the agent only needs to run: openclaw gateway restart
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createNotification } from '../notification-utils.js';

function resolveOpenClawHome() {
  const explicitHome = typeof process.env.OPENCLAW_HOME === 'string' ? process.env.OPENCLAW_HOME.trim() : '';
  if (explicitHome && explicitHome !== 'undefined') {
    return explicitHome;
  }
  return os.homedir();
}

const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OPENCLAW_HOME = resolveOpenClawHome();
const OPENCLAW_DIR = path.join(OPENCLAW_HOME, '.openclaw');
const CONFIG_PATH = path.join(OPENCLAW_DIR, 'openclaw.json');
const MCPORTER_CONFIG_PATH = path.join(OPENCLAW_DIR, 'config', 'mcporter.json');
const BUNDLE = path.join(SKILL_DIR, 'index.bundle.mjs');
const MESSAGE_SENDER = path.join(SKILL_DIR, 'scripts', 'send-message.mjs');

// --- Parse args ---
const args = process.argv.slice(2);

function parseNotifyDestination(argv) {
  let channel = '';
  let targetId = '';
  let targetType = '';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      continue;
    }
    if (arg === '--channel') {
      channel = value.trim().toLowerCase();
      i++;
      continue;
    }
    if (arg === '--target-id') {
      targetId = value.trim();
      i++;
      continue;
    }
    if (arg === '--target-type') {
      targetType = value.trim();
      i++;
      continue;
    }
  }

  if (!channel && !targetId && !targetType) {
    throw new Error('A notify target is required. Use --channel, --target-id, and --target-type.');
  }
  if (!channel || !targetId || !targetType) {
    throw new Error('--channel, --target-id, and --target-type must be provided together.');
  }
  if (channel === 'feishu' && targetType !== 'chat_id' && targetType !== 'open_id') {
    throw new Error('--target-type must be "chat_id" or "open_id" when --channel feishu is used.');
  }
  return {
    channel,
    target: { type: targetType, id: targetId },
  };
}

function buildNotificationPayload(notifyDestination, notification) {
  const payload = {
    channel: notifyDestination.channel,
    target: notifyDestination.target,
    deliver: true,
  };
  if (notification?.notification && typeof notification.notification === 'object' && !Array.isArray(notification.notification)) {
    payload.notification = JSON.parse(JSON.stringify(notification.notification));
  }
  if (notification?.card) {
    payload.card = notification.card;
  }
  if (typeof notification?.text === 'string' && notification.text.trim()) {
    payload.text = notification.text.trim();
  }
  return payload;
}

async function renderWebhookModule(skillDir) {
  const webhookTemplatePath = path.join(skillDir, 'hooks', 'my_payment_webhook.js');
  const webhookSource = await fs.readFile(webhookTemplatePath, 'utf8');
  return webhookSource.split('__AGENT_PAYMENT_SKILL_DIR__').join(JSON.stringify(skillDir));
}

let notifyDestination;
try {
  notifyDestination = parseNotifyDestination(args);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}

// --- Helpers ---
async function loadConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function saveConfig(config) {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

// --- Step 1: Register MCP server ---
console.log('Step 1: Registering MCP server...');
try {
  execFileSync('npx', [
    'mcporter',
    '--config',
    MCPORTER_CONFIG_PATH,
    'config',
    'add',
    'agent-payment-skills',
    `node ${BUNDLE}`,
  ], { stdio: 'inherit' });
  console.log('  ✅ Registered via npx mcporter');
} catch (e2) {
  console.warn('  ⚠️  MCP registration skipped (will be active after gateway restart):', e2.message);
}

// --- Store notify destination in clink.config.json so webhook can resolve the current target at runtime ---
const CACHE_PATH = path.join(SKILL_DIR, 'clink.config.json');
try {
  let cache = {};
  try { cache = JSON.parse(await fs.readFile(CACHE_PATH, 'utf8')); } catch {}
  cache.notifyDestination = notifyDestination;
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  console.log(`  ✅ Saved notify target: ${notifyDestination.channel}/${notifyDestination.target.type}/${notifyDestination.target.id}`);
} catch (e) {
  console.warn('  ⚠️  Could not save notify destination to cache:', e.message);
}

// --- Step 2: Copy webhook file ---
console.log('Step 2: Installing webhook transform...');
const webhookDst = path.join(OPENCLAW_DIR, 'hooks', 'transforms', 'my_payment_webhook.js');
await fs.mkdir(path.dirname(webhookDst), { recursive: true });
await fs.writeFile(webhookDst, await renderWebhookModule(SKILL_DIR), 'utf8');
console.log('  ✅ Webhook copied');

// --- Step 3: Inject config ---
console.log('Step 3: Updating openclaw.json...');
const config = await loadConfig();
config.hooks = config.hooks || {};
config.hooks.enabled = true;
config.hooks.mappings = config.hooks.mappings || [];
if (!config.hooks.token) {
  config.hooks.token = crypto.randomBytes(32).toString('hex');
}
const CLINK_PATH = '/clink/payment';
if (!config.hooks.mappings.some(m => m.transform?.module === 'my_payment_webhook.js')) {
  config.hooks.mappings.push({ match: { path: CLINK_PATH }, transform: { module: 'my_payment_webhook.js' } });
}
await saveConfig(config);

// Verify the write actually landed
const verify = await loadConfig();
const routeOk = verify.hooks?.mappings?.some(m => m.transform?.module === 'my_payment_webhook.js');
const webhookFileOk = await fs.access(webhookDst).then(() => true).catch(() => false);
if (!routeOk) {
  console.error('  ❌ Verification failed: webhook route not found in openclaw.json after write');
  process.exit(1);
}
if (!webhookFileOk) {
  console.error('  ❌ Verification failed: webhook file not found at', webhookDst);
  process.exit(1);
}
console.log('  ✅ Config updated and verified');
console.log('  ✅ Webhook route:', CLINK_PATH, '→ my_payment_webhook.js');

// --- Step 4: Write + spawn post-restart notify process ---
console.log('Step 4: Spawning post-restart notify process...');

let userEmail = '';
try {
  const cache = JSON.parse(await fs.readFile(CACHE_PATH, 'utf8'));
  userEmail = cache?.email || '';
} catch {}

const notifyScriptPath = path.join(OPENCLAW_DIR, 'cache', 'clink_notify.mjs');
const postRestartNotification = createNotification({
  title: '✅ Clink 支付组件已上线',
  theme: 'green',
  details: [
    ['Webhook 路由', '已就绪 ✓'],
    ['网关状态', '重启完毕 ✓'],
  ],
  paragraphs: [
    `最后一步：钱包初始化\n请直接回复您的邮箱地址完成绑定。${userEmail ? `\n\n如需继续使用之前的邮箱：\n\`\`\`\n${userEmail}\n\`\`\`` : ''}`,
  ],
});
const postRestartPayload = buildNotificationPayload(notifyDestination, { notification: postRestartNotification });

const notifyCode = `
import { execFileSync, execSync } from 'child_process';
import { appendFile } from 'fs/promises';

const sendMessage = ${JSON.stringify(MESSAGE_SENDER)};
const payload = ${JSON.stringify(JSON.stringify(postRestartPayload))};
const log = ${JSON.stringify(path.join(SKILL_DIR, 'error.log'))};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isGatewayUp() {
  try {
    execSync('openclaw gateway status', { stdio: 'pipe', timeout: 3000 });
    return true;
  } catch { return false; }
}

await sleep(3000);
const MAX_WAIT_MS = 60_000;
const POLL_MS = 2_000;
let waited = 0;

// 1. 先等待网关下线 (用户执行 restart 导致进程停止)
while (isGatewayUp() && waited < MAX_WAIT_MS) {
  await sleep(POLL_MS);
  waited += POLL_MS;
}

// 2. 再等待网关重新上线
waited = 0;
while (!isGatewayUp() && waited < MAX_WAIT_MS) {
  await sleep(POLL_MS);
  waited += POLL_MS;
}

try {
  execFileSync(process.execPath, [sendMessage, '--payload', payload], { stdio: 'pipe' });
  await appendFile(log, '[' + new Date().toISOString() + '] [notify] post-restart notification sent ok (waited ' + waited + 'ms)\\n');
} catch (e) {
  await appendFile(log, '[' + new Date().toISOString() + '] [notify] FAILED: ' + e.message + '\\n');
}
`;

await fs.mkdir(path.dirname(notifyScriptPath), { recursive: true });
await fs.writeFile(notifyScriptPath, notifyCode, 'utf8');
const notifyChild = spawn(process.execPath, [notifyScriptPath], {
  detached: true,
  stdio: 'ignore',
});
notifyChild.unref();
console.log('  ✅ Notify process spawned');

// --- Step 5: Send status notification ---
console.log('Step 5: Sending status notification...');
try {
  const authPayload = buildNotificationPayload(notifyDestination, {
    notification: createNotification({
      title: '🔌 安装 Clink Payment Skill',
      theme: 'blue',
      details: [
        ['注册 Webhook 回调路由', '已完成 ✓'],
        ['写入网关配置文件', '已完成 ✓'],
        ['重启网关进程', '正在重启…'],
      ],
      paragraphs: ['网关重启完成后将自动发送下一步提示。'],
    }),
  });
  execFileSync(process.execPath, [MESSAGE_SENDER, '--payload', JSON.stringify(authPayload)], { stdio: 'inherit' });
  console.log('  ✅ Status notification sent');
} catch (e) {
  console.warn('  ⚠️  Could not send status notification:', e.message);
}

console.log('\nPre-install complete. Now run: openclaw gateway restart');
