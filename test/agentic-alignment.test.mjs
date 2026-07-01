import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';

const indexSource = await fs.readFile(new URL('../index.mjs', import.meta.url), 'utf8');
const indexBundle = await fs.readFile(new URL('../index.bundle.mjs', import.meta.url), 'utf8');
const preInstallSource = await fs.readFile(new URL('../scripts/pre_install.mjs', import.meta.url), 'utf8');
const eventPumpSource = await fs.readFile(new URL('../scripts/event-pump.mjs', import.meta.url), 'utf8');
const skillDoc = await fs.readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');
const readmeZh = await fs.readFile(new URL('../README-zh.md', import.meta.url), 'utf8');

function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function sliceSection(source, heading, nextHeadingPattern) {
  const start = source.indexOf(heading);
  assert.ok(start >= 0, `Missing heading: ${heading}`);
  const restStart = start + heading.length;
  const match = source.slice(restStart).match(nextHeadingPattern);
  const end = match ? restStart + match.index : source.length;
  assert.ok(end > start, `Invalid section bounds for: ${heading}`);
  return source.slice(start, end);
}

test('OpenClaw payment skill does not use direct Clink HTTP helpers', () => {
  const code = stripComments(indexSource);
  assert.doesNotMatch(code, /function\s+fetchClink\b/);
  assert.doesNotMatch(code, /function\s+fetchInstruction\b/);
  assert.doesNotMatch(code, /function\s+httpsRequest\b/);
  assert.doesNotMatch(code, /fetch\s*\(\s*['"]https:\/\/(?:api|agent)\.clinkbill\./);
  assert.match(code, /CLINK_CLI_BUNDLE\s*=\s*path\.join\(SKILL_DIR,\s*'vendor',\s*'clink-cli',\s*'clink-cli\.bundle\.mjs'\)/);
  assert.match(code, /async function runClinkCli\(args/);
});

test('install path starts event pump and does not install a payment webhook route', () => {
  assert.match(preInstallSource, /event pump/i);
  assert.doesNotMatch(preInstallSource, /my_payment_webhook\.(?:mjs|js)['"]/);
  assert.doesNotMatch(preInstallSource, /hooks\/clink\/payment/);
  assert.doesNotMatch(preInstallSource, /hooks\.mappings\.push/);

  const installHandlerStart = indexSource.indexOf('async function handle_install_system_hooks(args)');
  const uninstallHandlerStart = indexSource.indexOf('async function handle_uninstall_system_hooks(args)');
  assert.ok(installHandlerStart >= 0, 'install handler exists');
  assert.ok(uninstallHandlerStart > installHandlerStart, 'uninstall follows install');
  const installHandler = indexSource.slice(installHandlerStart, uninstallHandlerStart);
  assert.match(installHandler, /ensureEventPumpRunning\(\)/);
  assert.doesNotMatch(stripComments(installHandler), /my_payment_webhook\.(?:mjs|js)/);
  assert.doesNotMatch(stripComments(installHandler), /hooks\/clink\/payment/);
});

test('event pump is the only async payment completion path and uses the event FSM', () => {
  assert.match(eventPumpSource, /'events',\s*'poll'/);
  assert.match(eventPumpSource, /agent_order\.succeeded/);
  assert.match(eventPumpSource, /agent_refund\.succeeded/);
  assert.match(eventPumpSource, /payment_method\.added/);
  assert.match(eventPumpSource, /risk_rule\.updated/);
  assert.match(eventPumpSource, /processedEventSeqs/);
  assert.match(eventPumpSource, /classifyEventWorkflow/);
  assert.match(eventPumpSource, /event_fsm/);
});

test('payment flow uses explicit FSM classification and observability markers', () => {
  assert.match(indexSource, /classifyPaymentResponse/);
  assert.match(indexSource, /classifyPaymentError/);
  assert.match(indexSource, /formatPaymentFsmDirective/);
  assert.match(indexSource, /\[PAYMENT_FSM\]/);
});

test('tool descriptions in source and runtime bundle reflect event-pump install ownership', () => {
  for (const [name, text] of [['index.mjs', indexSource], ['index.bundle.mjs', indexBundle]]) {
    assert.match(text, /install_system_hooks/iu, `${name} should expose install_system_hooks`);
    assert.match(text, /notify routing/iu, `${name} install description should mention notify routing`);
    assert.match(text, /event pump/iu, `${name} install description should mention event pump`);
    assert.doesNotMatch(text, /Update openclaw\.json and restart the gateway/iu, `${name} has stale install description`);
  }
});

test('skill install section says when event pump starts, without webhook install route', () => {
  const installSection = sliceSection(skillDoc, '### 3.1 Install (Strict Single-Step Workflow)', /^###\s+3\.2\s+/m);
  assert.match(installSection, /pre_install\.mjs/i);
  assert.match(installSection, /registers the MCP server/i);
  assert.match(installSection, /saves notify routing/i);
  assert.match(installSection, /does not install a payment webhook transform/i);
  assert.match(installSection, /event pump starts idempotently when usable wallet credentials are available/i);
});

test('skill requires agent-owned execution instead of user-run commands', () => {
  const installSection = sliceSection(skillDoc, '### 3.1 Install (Strict Single-Step Workflow)', /^###\s+3\.2\s+/m);
  assert.match(skillDoc, /agent owns command execution/i);
  assert.match(installSection, /execute `node scripts\/pre_install\.mjs/i);
  assert.doesNotMatch(installSection, /show the exact manual command/i);
  assert.doesNotMatch(skillDoc, /Shell examples below assume/i);
  assert.doesNotMatch(skillDoc, /If calling via shell/i);
  assert.doesNotMatch(skillDoc, /npx mcporter --config/i);
});

test('skill documents the FSM control loop and payment FSM actions', () => {
  assert.match(skillDoc, /Control Loop \/ FSM Contract/i);
  assert.match(skillDoc, /Observe\s*→\s*Classify\s*→\s*Act\s*→\s*Verify\s*→\s*Persist/i);
  for (const action of [
    'WAIT_EVENT_PUMP',
    'SEND_3DS_AND_WAIT_EVENT',
    'NOTIFY_SUCCESS_AND_CONFIRM_MERCHANT',
    'NOTIFY_FAILURE_STOP',
    'VERIFY_BEFORE_RETRY',
    'ASK_WALLET_SETUP',
    'SURFACE_ERROR',
  ]) {
    assert.match(skillDoc, new RegExp(action));
  }
});

test('skill documents event hooks that update local config before notification', () => {
  const eventHookSection = sliceSection(skillDoc, '### 2.5 Event Hook → Local Cache Update Matrix', /^###\s+2\.6\s+/m);
  for (const eventType of [
    'payment_method.added',
    'payment_method.updated',
    'payment_method.update',
    'payment_method.default_change',
    'risk_rule.updated',
    'purchase_instruction.activated',
    'vic_device.binding_succeeded',
    'agent_order.succeeded',
    'agent_order.failed',
    'agent_refund.succeeded',
    'agent_refund.approved',
    'agent_refund.failed',
    'agent_refund.rejected',
  ]) {
    assert.match(eventHookSection, new RegExp(eventType.replaceAll('.', '\\.')));
  }
  assert.match(eventHookSection, /clink\.config\.json/i);
  assert.match(eventHookSection, /before notifying/i);
});

test('payment method management does not fabricate update confirmation after page return', () => {
  const managementSection = sliceSection(skillDoc, '### 3.5 Payment Method Management', /^###\s+3\.6\s+/m);
  assert.match(managementSection, /Do NOT treat the user's return from the external page as proof/i);
  assert.match(managementSection, /payment_method\.updated/i);
  assert.match(managementSection, /payment_method\.default_change/i);
  assert.doesNotMatch(managementSection, /Risk rules: unchanged ✓/i);
});

test('skill and README docs no longer expose legacy webhook wait directives for this payment skill', () => {
  for (const [name, text] of [['SKILL.md', skillDoc], ['README.md', readme], ['README-zh.md', readmeZh]]) {
    assert.doesNotMatch(text, new RegExp('webhook' + 'Available', 'iu'), `${name} should not mention the legacy webhook availability flag`);
    assert.doesNotMatch(text, new RegExp('WAIT_FOR_' + 'WEBHOOK', 'iu'), `${name} should not mention the legacy webhook wait directive`);
    assert.doesNotMatch(text, new RegExp('DIRECT_SEND_' + 'POLL_REQUIRED', 'iu'), `${name} should not mention the legacy direct-send poll directive`);
  }
  assert.match(skillDoc, /event pump|事件监控|events poll/i);
  assert.match(skillDoc, /clink-cli/i);
});

test('README install commands cd into the openclaw payment skill repository', () => {
  for (const [name, text] of [['README.md', readme], ['README-zh.md', readmeZh]]) {
    assert.match(text, /git clone https:\/\/github\.com\/clinkbillcom\/openclaw-payment-skills\.git/i, `${name} should clone the OpenClaw repository`);
    assert.match(text, /^cd openclaw-payment-skills$/m, `${name} should cd into the cloned OpenClaw repository`);
    assert.doesNotMatch(text, /^cd agent-payment-skills$/m, `${name} should not use the stale generic skill directory`);
  }
});
