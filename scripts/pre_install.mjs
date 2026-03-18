#!/usr/bin/env node
/**
 * Pre-install script for agent-payment-skills.
 * No npm dependencies — only Node.js built-ins.
 *
 * Usage:
 *   node pre_install.mjs --chat-id oc_xxx
 *   node pre_install.mjs --open-id ou_xxx
 *
 * What it does (all in one):
 *   1. Registers the MCP server via mcporter config add (or mcp add as fallback)
 *   2. Stores notifyTargetId in clink.config.json
 *   3. Copies hooks/my_payment_webhook.js → ~/.openclaw/hooks/transforms/
 *   4. Injects webhook mapping into ~/.openclaw/openclaw.json and verifies
 *   5. Writes + spawns background notify process (polls for gateway, then sends post-restart card)
 *   6. Sends the status card
 *
 * After this script exits, the agent only needs to run: openclaw gateway restart
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFileSync, execSync } from 'child_process';
import { fileURLToPath } from 'url';

const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');
const CONFIG_PATH = path.join(OPENCLAW_DIR, 'openclaw.json');
const BUNDLE = path.join(SKILL_DIR, 'index.bundle.mjs');
const SEND_CARD = path.join(SKILL_DIR, 'scripts', 'send-feishu-card.mjs');
const AUTH_CARD = path.join(SKILL_DIR, 'cards', 'auth_request.json');

// --- Parse args ---
const args = process.argv.slice(2);
let chatId = null;
let openId = null;
for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--chat-id' || args[i] === '--open-id') && args[i + 1]) {
    if (args[i] === '--chat-id') chatId = args[++i];
    else openId = args[++i];
  }
}
const targetId = chatId ?? openId;
const targetFlag = openId ? '--open-id' : '--chat-id';

if (!targetId) {
  console.error('Error: --chat-id or --open-id is required');
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
  execSync(`mcporter config add agent-payment-skills "node ${BUNDLE}"`, { stdio: 'pipe' });
  console.log('  ✅ Registered via mcporter');
} catch {
  try {
    execSync(`mcp add agent-payment-skills "node ${BUNDLE}"`, { stdio: 'pipe' });
    console.log('  ✅ Registered via mcp add');
  } catch (e2) {
    console.warn('  ⚠️  MCP registration skipped (will be active after gateway restart):', e2.message);
  }
}

// --- Store target_id in clink.config.json so webhook can resolve chat_id at runtime ---
const CACHE_PATH = path.join(SKILL_DIR, 'clink.config.json');
try {
  let cache = {};
  try { cache = JSON.parse(await fs.readFile(CACHE_PATH, 'utf8')); } catch {}
  cache.notifyTargetId = targetId;
  cache.notifyTargetType = openId ? 'open_id' : 'chat_id';
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  console.log(`  ✅ Saved notify target: ${targetId}`);
} catch (e) {
  console.warn('  ⚠️  Could not save target_id to cache:', e.message);
}

// --- Step 2: Copy webhook file ---
console.log('Step 2: Installing webhook transform...');
const webhookSrc = path.join(SKILL_DIR, 'hooks', 'my_payment_webhook.js');
const webhookDst = path.join(OPENCLAW_DIR, 'hooks', 'transforms', 'my_payment_webhook.js');
await fs.mkdir(path.dirname(webhookDst), { recursive: true });
await fs.copyFile(webhookSrc, webhookDst);
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
const postRestartCard = JSON.stringify({
  schema: '2.0',
  header: { title: { content: '✅ Clink 支付组件已上线', tag: 'plain_text' }, template: 'green' },
  body: { elements: [
    { tag: 'markdown', content: `**Webhook 路由**　<font color="green">已就绪 ✓</font>\n**网关状态**　　<font color="green">重启完毕 ✓</font>` },
    { tag: 'hr' },
    { tag: 'markdown', content: `🔐 **最后一步：钱包初始化**\n请直接回复您的邮箱地址完成绑定。${userEmail ? `\n\n如需继续使用之前的邮箱：\n\`\`\`\n${userEmail}\n\`\`\`` : ''}` }
  ]}
});

const notifyCode = `
import { execFileSync, execSync } from 'child_process';
import { appendFile } from 'fs/promises';

const sendCard = ${JSON.stringify(SEND_CARD)};
const card = ${JSON.stringify(postRestartCard)};
const flag = ${JSON.stringify(targetFlag)};
const id = ${JSON.stringify(targetId)};
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
while (!isGatewayUp() && waited < MAX_WAIT_MS) {
  await sleep(POLL_MS);
  waited += POLL_MS;
}

try {
  execFileSync(process.execPath, [sendCard, '--json', card, flag, id], { stdio: 'pipe' });
  await appendFile(log, '[' + new Date().toISOString() + '] [notify] post-restart card sent ok (waited ' + waited + 'ms)\\n');
} catch (e) {
  await appendFile(log, '[' + new Date().toISOString() + '] [notify] FAILED: ' + e.message + '\\n');
}
`;

await fs.mkdir(path.dirname(notifyScriptPath), { recursive: true });
await fs.writeFile(notifyScriptPath, notifyCode, 'utf8');
execSync(`nohup sh -c '${process.execPath} ${notifyScriptPath}' > /dev/null 2>&1 &`, { stdio: 'ignore' });
console.log('  ✅ Notify process spawned');

// --- Step 5: Send status card ---
console.log('Step 5: Sending status card...');
try {
  execFileSync(process.execPath, [SEND_CARD, AUTH_CARD, targetFlag, targetId], { stdio: 'inherit' });
  console.log('  ✅ Status card sent');
} catch (e) {
  console.warn('  ⚠️  Could not send status card:', e.message);
}

console.log('\nPre-install complete. Now run: openclaw gateway restart');
