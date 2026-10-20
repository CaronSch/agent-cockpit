#!/usr/bin/env bun
/**
 * Scripted stand-in for `omp --mode rpc-ui`, for daemon and browser tests: it speaks omp's
 * JSONL protocol with frame shapes recorded from omp 18.12.3, and answers prompts by keyword.
 *
 * - default: streams "You said: <prompt>" (assistant message_start arrives pre-filled, as omp's does)
 * - contains "tool": a bash tool call with live output, then a reply
 * - contains "ask": an `ask` dialog; the reply names the chosen option
 * - contains "mystery": emits a frame type no client knows
 * - contains "garble": writes a stdout line that is not JSON
 * - contains "table": replies with a markdown table
 * - contains "slow": an intermediate reply and a tool run, then 1.5 s before the final reply
 * - `/rename [title]`: like omp's builtin, names the session (with no title, from the first
 *   prompt that says something: "hi" alone is too little to name a session by)
 * - `btw`: a side question, answered from the conversation and kept out of it as omp's is;
 *   the answer bolds the first quoted line, and a question containing "slow" waits 1.5 s
 * With `--resume <file>`, `get_messages` returns a short earlier conversation, and the
 * session already has a name; the fake never writes to a resumed file.
 * Other sessions keep a journal in `$TMPDIR/fake-omp-sessions/`, written as omp does: a new
 * session's only once the model has replied, then after every message. `--fork <file>`
 * copies that file's title and messages into a new journal at once (omp's
 * `SessionManager.forkFrom`), leaving the source alone; a missing source exits with omp's error.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('omp/fake');
  process.exit(0);
}
/** @param {string} flag */
const option = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const resumed = option('--resume');
const forkedFrom = option('--fork');

/** The forked journal's lines (a missing file ends the process, as omp's `--fork` does). @type {Record<string, any>[]} */
let source = [];
if (forkedFrom) {
  try {
    source = readFileSync(forkedFrom, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    process.stderr.write(`Error: Session "${forkedFrom}" not found.\n`);
    process.exit(1);
  }
}

const sessionId = randomUUID();
const startedAt = new Date().toISOString();
const sessionsDir = join(tmpdir(), 'fake-omp-sessions');
const sessionFile = resumed ?? join(sessionsDir, `${sessionId}.jsonl`);

/** @type {Record<string, any>[]} */
const messages = resumed
  ? [
      { role: 'user', content: [{ type: 'text', text: 'earlier question' }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }], stopReason: 'stop', timestamp: 2 },
    ]
  : source.filter((entry) => entry.type === 'message').map((entry) => entry.message);
let model = { provider: 'fake', id: 'fake-model', name: 'Fake Model' };
let thinkingLevel = 'off';
let msgCounter = 0;
/** @type {string | null} */
let sessionName = resumed ? 'Earlier work' : source.find((entry) => entry.type === 'title')?.title || null;
/** @type {Map<string, (answer: Record<string, any>) => void>} */
const dialogs = new Map();

/** Rewrites this session's journal: a title line, the header, then one line per message. */
function persist() {
  if (resumed || (!forkedFrom && !messages.some((m) => m.role === 'assistant'))) return;
  const header = { type: 'session', version: 3, id: sessionId, timestamp: startedAt, cwd: process.cwd() };
  const parent = source.find((entry) => entry.type === 'session')?.id;
  const lines = [
    { type: 'title', v: 1, title: sessionName ?? '' },
    parent ? { ...header, parentSession: parent } : header,
    ...messages.map((message) => ({ type: 'message', message })),
  ];
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(sessionFile, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}
persist();

/** @param {Record<string, any>} frame */
const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
/** @param {string | undefined} id @param {string} command @param {unknown} [data] */
const ok = (id, command, data) => out({ id, type: 'response', command, success: true, ...(data === undefined ? {} : { data }) });
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.0125 } };

/** @param {Record<string, any>} message */
function record(message) {
  const messageId = `msg-${++msgCounter}`;
  messages.push(message);
  persist();
  return messageId;
}

/** @param {string} text */
function streamAssistant(text) {
  const final = { role: 'assistant', content: [{ type: 'text', text }], provider: model.provider, model: model.id, usage, stopReason: 'stop', timestamp: Date.now() };
  const messageId = record(final);
  out({ type: 'message_start', message: final, messageId }); // pre-filled, like real omp
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 }, message: { role: 'assistant' }, messageId });
  for (const piece of text.match(/.{1,6}/gs) ?? []) {
    out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: piece }, message: { role: 'assistant' }, messageId });
  }
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: text }, message: { role: 'assistant' }, messageId });
  out({ type: 'message_end', message: final, messageId });
}

function toolCall() {
  const call = { type: 'toolCall', id: 'tool-1', name: 'bash', arguments: { command: 'echo hi' }, intent: 'Running echo' };
  const assistant = { role: 'assistant', content: [call], provider: model.provider, model: model.id, usage, stopReason: 'toolUse', timestamp: Date.now() };
  const messageId = record(assistant);
  out({ type: 'message_start', message: assistant, messageId });
  out({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0 }, message: { role: 'assistant' }, messageId });
  out({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: call }, message: { role: 'assistant' }, messageId });
  out({ type: 'message_end', message: assistant, messageId });
  out({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', args: { command: 'echo hi' }, intent: 'Running echo' });
  out({ type: 'tool_execution_update', toolCallId: 'tool-1', toolName: 'bash', args: { command: 'echo hi' }, partialResult: { content: [{ type: 'text', text: 'hi\n' }], details: {} } });
  const result = { content: [{ type: 'text', text: 'hi\n' }], details: {} };
  out({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'bash', result, isError: false });
  const toolResult = { role: 'toolResult', toolCallId: 'tool-1', toolName: 'bash', content: result.content, isError: false, timestamp: Date.now() };
  const resultId = record(toolResult);
  out({ type: 'message_start', message: toolResult, messageId: resultId });
  out({ type: 'message_end', message: toolResult, messageId: resultId });
}

/** @returns {Promise<Record<string, any>>} */
function askDialog() {
  const id = `ui-${Date.now()}`;
  out({
    type: 'extension_ui_request',
    id,
    method: 'ask',
    questions: [{ id: 'db', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite', description: 'file based' }], recommended: 1 }],
  });
  return new Promise((resolve) => dialogs.set(id, resolve));
}

/** @param {string | undefined} id @param {string} text */
async function runPrompt(id, text) {
  const firstMessage = messages.length;
  out({ type: 'agent_start' });
  out({ type: 'turn_start' });
  const user = { role: 'user', content: [{ type: 'text', text }], attribution: 'user', timestamp: Date.now() };
  const userId = record(user);
  out({ type: 'message_start', message: user, messageId: userId });
  out({ type: 'message_end', message: user, messageId: userId });
  if (/mystery/.test(text)) out({ type: 'mystery_frame', payload: 42 });
  if (/garble/.test(text)) process.stdout.write('this line is not json\n');
  if (/tool/.test(text)) toolCall();
  if (/slow/.test(text)) {
    // A turn's middle: an intermediate reply and a tool run, then a pause before the final reply.
    streamAssistant('Let me check first.');
    toolCall();
    await Bun.sleep(1500);
  }
  if (/ask/.test(text)) {
    const answer = await askDialog();
    const picked = answer.cancelled ? 'nothing (cancelled)' : (answer.answers?.[0]?.selectedOptions?.[0] ?? answer.answers?.[0]?.customInput);
    streamAssistant(`You picked **${picked}**.`);
  } else if (/table/.test(text)) {
    streamAssistant('Here it is:\n| When | What happens | Code |\n|---|---|---|\n| Now | Stuff happened | `tracked.rs:67` |');
  } else {
    streamAssistant(`You said: **${text}**\n\n- one\n- two`);
  }
  out({ type: 'turn_end', message: messages.at(-1), toolResults: [] });
  out({ type: 'extension_ui_request', id: `ui-${Date.now()}-w`, method: 'setWidget', widgetKey: 'autoresearch' }); // omp clears it every turn
  out({ type: 'agent_end', messages: messages.slice(firstMessage), isTerminal: true, yielded: true });
  out({ type: 'prompt_result', id, agentInvoked: true, status: 'completed', sessionSettled: true });
  out({ type: 'session_settled' });
}

/** Like omp's builtin: output first, then the answer with `agentInvoked: false` and no `prompt_result`. @param {string | undefined} id @param {string} title */
function rename(id, title) {
  const said = messages.filter((m) => m.role === 'user').map((m) => String(m.content?.[0]?.text ?? ''));
  const topic = said.find((text) => !/^\s*hi\s*$/i.test(text));
  const name = title || (topic ? `About ${topic.split(/\s+/).slice(0, 4).join(' ')}` : null);
  if (!name) out({ type: 'command_output', text: 'Could not generate a session title. Use /rename <title> to set one.' });
  else {
    sessionName = name;
    persist();
    out({ type: 'session_info_update', title: name, sessionId });
    out({ type: 'command_output', text: `Session renamed to ${name}.` });
  }
  ok(id, 'prompt', { agentInvoked: false });
}

/** The side question being answered, as omp runs one at a time. @type {{ record: Record<string, any>, timer?: ReturnType<typeof setTimeout> } | null} */
let sideQuestion = null;

/** @param {string | undefined} id @param {string} question */
function btw(id, question) {
  if (sideQuestion) {
    return out({ id, type: 'response', command: 'btw', success: false, error: 'A /btw question is still running; cancel it first' });
  }
  const now = Date.now();
  const record = { question, answer: '', status: 'running', createdAt: now, updatedAt: now, id: `btw-${now}`, leafId: 'leaf-1' };
  const current = { record, timer: /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined) };
  sideQuestion = current;
  out({ type: 'btw_record', record });
  ok(id, 'btw', { record });
  const quoted = /^> (.*)$/m.exec(question)?.[1] ?? 'that';
  const answer = `**${quoted}** is what the conversation said.`;
  current.timer = setTimeout(() => {
    for (const delta of answer.match(/.{1,8}/gs) ?? []) out({ type: 'btw_delta', recordId: record.id, delta });
    finishSideQuestion({ answer, status: 'complete' });
  }, /slow/.test(question) ? 1500 : 0);
}

/** @param {Record<string, any>} patch */
function finishSideQuestion(patch) {
  if (!sideQuestion) return;
  clearTimeout(sideQuestion.timer);
  out({ type: 'btw_record', record: { ...sideQuestion.record, ...patch, updatedAt: Date.now() } });
  sideQuestion = null;
}

out({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
out({ type: 'extension_ui_request', id: 'ui-start-w', method: 'setWidget', widgetKey: 'autoresearch' });
out({ type: 'advisor_cost_changed' });
out({
  type: 'available_commands_update',
  commands: [
    { name: 'model', aliases: ['models'], description: 'Show current model selection', source: 'builtin' },
    {
      name: 'compact',
      description: 'Compact the conversation',
      input: { hint: '[soft|remote|snapcompact] [focus]' },
      subcommands: [{ name: 'soft', description: 'Summarize locally with the active model (skip server compaction)', usage: '[focus]' }],
      source: 'builtin',
    },
    { name: 'rename', description: 'Rename the current session (omit title to generate)', input: { hint: '[title]' }, source: 'builtin' },
  ],
});

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  const cmd = JSON.parse(line);
  const { id, type } = cmd;
  switch (type) {
    case 'extension_ui_response':
      dialogs.get(cmd.id)?.(cmd);
      dialogs.delete(cmd.id);
      return;
    case 'negotiate_protocol':
      return ok(id, type, { protocolVersion: 2 });
    case 'set_event_filter':
      return ok(id, type, { events: cmd.events, messageUpdates: cmd.messageUpdates ?? 'full' });
    case 'set_ask_dialog':
      return ok(id, type, { enabled: cmd.enabled });
    case 'get_state':
      return ok(id, type, {
        model,
        thinkingLevel,
        isStreaming: false,
        isCompacting: false,
        steeringMode: 'one-at-a-time',
        followUpMode: 'one-at-a-time',
        interruptMode: 'immediate',
        sessionFile,
        sessionId,
        ...(sessionName ? { sessionName } : {}),
        autoCompactionEnabled: true,
        queuedMessageCount: 0,
        hasPendingAsyncWork: false,
        isSettled: true,
        queuedMessages: { steering: [], followUp: [], liveSteered: 0 },
        messageCount: messages.length,
        contextUsage: { tokens: 120, contextWindow: 1000, percent: 12 },
        goal: null,
      });
    case 'get_messages':
      return ok(id, type, { messages });
    case 'get_available_models':
      return ok(id, type, { models: [model, { provider: 'fake', id: 'fake-large', name: 'Fake Large' }] });
    case 'set_model':
      model = { provider: cmd.provider, id: cmd.modelId, name: cmd.modelId };
      out({ type: 'model_changed' }); // no payload, emitted while the model is set
      return ok(id, type, model);
    case 'get_available_thinking_levels':
      return ok(id, type, { levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] });
    case 'set_thinking_level':
      thinkingLevel = cmd.level;
      out({ type: 'thinking_level_changed', thinkingLevel });
      return ok(id, type);
    case 'get_login_providers':
      return ok(id, type, { providers: [{ id: 'fake', name: 'Fake Provider', available: true, authenticated: false }] });
    case 'bash': {
      // Like omp, answer only when the command finishes; "sleep" makes it take a while.
      const result = { exitCode: 0, cancelled: false, workingDir: process.cwd(), output: 'hi\n', truncated: false, totalLines: 2, totalBytes: 3, outputLines: 2, outputBytes: 3 };
      return void setTimeout(() => ok(id, type, result), /sleep/.test(cmd.command) ? 600 : 0);
    }
    case 'abort':
      return ok(id, type);
    case 'btw':
      return btw(id, String(cmd.question ?? ''));
    case 'btw_cancel': {
      const cancelled = sideQuestion !== null && (cmd.recordId === undefined || sideQuestion.record.id === cmd.recordId);
      if (cancelled) finishSideQuestion({ status: 'cancelled' });
      return ok(id, type, { cancelled });
    }
    case 'abort_and_restore_queue':
      out({ type: 'queue_update', steering: [], followUp: [], liveSteered: 0 });
      return ok(id, type, { steering: [], followUp: [] });
    case 'prompt':
      if (/^\/rename(\s|$)/.test(cmd.message)) return rename(id, cmd.message.slice('/rename'.length).trim());
      ok(id, type);
      return void runPrompt(id, cmd.message);
    default:
      return out({ id, type: 'response', command: type, success: false, error: `Unknown command: ${type}` });
  }
});
lines.on('close', () => process.exit(0));
