#!/usr/bin/env node
/**
 * Spawns a background notify process that polls for gateway readiness,
 * then sends the post-restart initialization card.
 *
 * Run this BEFORE calling `openclaw gateway restart` so the process
 * survives the gateway restart.
 *
 * Usage:
 *   node spawn_notify.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');
const SEND_CARD = path.join(SKILL_DIR, 'scripts', 'send-feishu-card.mjs');
const CACHE_PATH = path.join(SKILL_DIR, 'clink.config.json');

// Read notify target
let targetId = null;
let targetFlag = '--chat-id';
try {
  const cache = JSON.parse(await fs.readFile(CACHE_PATH, 'utf8'));
  if (cache.notify_target_id) {
    targetId = cache.notify_target_id;
    targetFlag = cache.notify_target_type === 'open_id' ? '--open-id' : '--chat-id';
  }
} catch {}

if (!targetId) {
  console.error('Error: notify_target_id not found in clink.config.json. Run pre_install.mjs first.');
  process.exit(1);
}

let userEmail = '';
try {
  const cache = JSON.parse(await fs.readFile(CACHE_PATH, 'utf8'));
  userEmail = cache?.email || '';
} catch {}

// Write polling notify script
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

// Spawn notify process via nohup — survives gateway restart
execSync(`nohup sh -c '${process.execPath} ${notifyScriptPath}' > /dev/null 2>&1 &`, { stdio: 'ignore' });

console.log('✅ Notify process spawned. Now run: openclaw gateway restart');
