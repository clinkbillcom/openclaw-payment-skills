#!/usr/bin/env node
/**
 * Standalone install script for agent-payment-skills.
 * No npm dependencies — only Node.js built-ins.
 *
 * Usage:
 *   node install.mjs --chat-id oc_xxx
 *   node install.mjs --open-id ou_xxx
 *
 * What it does (in order):
 *   1. Registers the MCP server via mcporter config add (or mcp add as fallback)
 *   2. Copies hooks/my_payment_webhook.js → ~/.openclaw/hooks/transforms/
 *   3. Injects webhook mapping into ~/.openclaw/openclaw.json
 *   4. Sends the "✅ 安装成功" confirmation card to the user
 *   5. Spawns background: sleep 3s → gateway restart
 *   6. Spawns background: sleep 15s → send post-restart initialization card
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFileSync, execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');
const CONFIG_PATH = path.join(OPENCLAW_DIR, 'openclaw.json');
const SEND_CARD = path.join(SKILL_DIR, 'scripts', 'send-feishu-card.mjs');
const BUNDLE = path.join(SKILL_DIR, 'index.bundle.mjs');

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

function sendCard(cardObj) {
  const json = JSON.stringify(cardObj);
  execFileSync(process.execPath, [SEND_CARD, '--json', json, targetFlag, targetId], { stdio: 'inherit' });
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
console.log('  ✅ Config updated');

// --- Step 4: Send confirmation card ---
console.log('Step 4: Sending confirmation card...');
let userEmail = '';
try {
  const cache = JSON.parse(await fs.readFile(path.join(SKILL_DIR, 'clink.config.json'), 'utf8'));
  userEmail = cache?.email || '';
} catch {}

sendCard({
  schema: '2.0',
  header: { title: { content: '✅ 依赖与路由注入成功', tag: 'plain_text' }, template: 'green' },
  body: { elements: [
    { tag: 'markdown', content: `**Webhook 路由**　<font color="green">已就绪 ✓</font>\n**网关状态**　　<font color="orange">即将重启</font>\n**绑定邮箱**　　<font color="grey">${userEmail || '未设置'}</font>` },
    { tag: 'hr' },
    { tag: 'markdown', content: `网关将在 3 秒后自动重启。重启完成后，请直接回复您的邮箱地址完成钱包初始化。${userEmail ? `\n\n如需继续使用之前的邮箱，复制下方口令发送：\n\`\`\`\n${userEmail}\n\`\`\`` : ''}` }
  ]}
});
console.log('  ✅ Confirmation card sent');

// --- Step 5 & 6: Background restart + post-restart notification ---
console.log('Step 5: Scheduling background restart...');

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
import { execFileSync } from 'child_process';
const sendCard = ${JSON.stringify(SEND_CARD)};
const card = ${JSON.stringify(postRestartCard)};
const flag = ${JSON.stringify(targetFlag)};
const id = ${JSON.stringify(targetId)};
try {
  execFileSync(process.execPath, [sendCard, '--json', card, flag, id], { stdio: 'inherit' });
} catch (e) { console.error('notify failed:', e.message); }
`;
await fs.mkdir(path.dirname(notifyScriptPath), { recursive: true });
await fs.writeFile(notifyScriptPath, notifyCode, 'utf8');

spawn('sh', ['-c', 'sleep 3 && openclaw gateway restart'], { detached: true, stdio: 'ignore' }).unref();
spawn('sh', ['-c', `sleep 15 && ${process.execPath} ${notifyScriptPath}`], { detached: true, stdio: 'ignore' }).unref();

console.log('  ✅ Background processes scheduled');
console.log('\nInstallation complete.');
