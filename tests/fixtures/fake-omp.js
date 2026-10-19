#!/usr/bin/env node
/**
 * Scripted stand-in for `omp --mode rpc-ui`, for daemon and browser tests: it speaks omp's
 * JSONL protocol with frame shapes recorded from omp 18.10.3, and answers prompts by keyword.
 *
 * - default: streams "You said: <prompt>" (assistant message_start arrives pre-filled, as omp's does)
 * - contains "tool": a bash tool call with live output, then a reply
 * - contains "ask": an `ask` dialog; the reply names the chosen option
 * - contains "mystery": emits a frame type no client knows
 * - contains "garble": writes a stdout line that is not JSON
 * With `--resume <file>`, `get_messages` returns a short earlier conversation.
 */
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('omp/fake');
  process.exit(0);
}
const resumeAt = args.indexOf('--resume');
const resumed = resumeAt >= 0 ? args[resumeAt + 1] : null;

/** @type {Record<string, any>[]} */
const messages = resumed
  ? [
      { role: 'user', content: [{ type: 'text', text: 'earlier question' }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }], stopReason: 'stop', timestamp: 2 },
    ]
  : [];
let model = { provider: 'fake', id: 'fake-model', name: 'Fake Model' };
let thinkingLevel = 'off';
let msgCounter = 0;
/** @type {Map<string, (answer: Record<string, any>) => void>} */
const dialogs = new Map();

/** @param {Record<string, any>} frame */
const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
/** @param {string | undefined} id @param {string} command @param {unknown} [data] */
const ok = (id, command, data) => out({ id, type: 'response', command, success: true, ...(data === undefined ? {} : { data }) });
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.0125 } };

/** @param {Record<string, any>} message */
function record(message) {
  const messageId = `msg-${++msgCounter}`;
  messages.push(message);
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
  out({ type: 'agent_start' });
  out({ type: 'turn_start' });
  const user = { role: 'user', content: [{ type: 'text', text }], attribution: 'user', timestamp: Date.now() };
  const userId = record(user);
  out({ type: 'message_start', message: user, messageId: userId });
  out({ type: 'message_end', message: user, messageId: userId });
  if (/mystery/.test(text)) out({ type: 'mystery_frame', payload: 42 });
  if (/garble/.test(text)) process.stdout.write('this line is not json\n');
  if (/tool/.test(text)) toolCall();
  if (/ask/.test(text)) {
    const answer = await askDialog();
    const picked = answer.cancelled ? 'nothing (cancelled)' : (answer.answers?.[0]?.selectedOptions?.[0] ?? answer.answers?.[0]?.customInput);
    streamAssistant(`You picked **${picked}**.`);
  } else {
    streamAssistant(`You said: **${text}**\n\n- one\n- two`);
  }
  out({ type: 'turn_end' });
  out({ type: 'agent_end', messages: [], isTerminal: true, yielded: true });
  out({ type: 'prompt_result', id, agentInvoked: true, status: 'completed', sessionSettled: true });
  out({ type: 'session_settled' });
}

out({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
out({
  type: 'available_commands_update',
  commands: [
    { name: 'model', source: 'builtin', description: 'Select model' },
    { name: 'compact', source: 'builtin', description: 'Compact the context', input: { hint: '[instructions]' } },
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
        sessionFile: resumed ?? '/tmp/fake-omp-session.jsonl',
        sessionId: 'fake-session',
        messageCount: messages.length,
        queuedMessageCount: 0,
        isSettled: true,
        queuedMessages: { steering: [], followUp: [] },
        contextUsage: { tokens: 120, contextWindow: 1000, percent: 12 },
      });
    case 'get_messages':
      return ok(id, type, { messages });
    case 'get_available_models':
      return ok(id, type, { models: [model, { provider: 'fake', id: 'fake-large', name: 'Fake Large' }] });
    case 'set_model':
      model = { provider: cmd.provider, id: cmd.modelId, name: cmd.modelId };
      ok(id, type, model);
      return out({ type: 'model_changed', model });
    case 'get_available_thinking_levels':
      return ok(id, type, { levels: ['off', 'low', 'high'] });
    case 'set_thinking_level':
      thinkingLevel = cmd.level;
      ok(id, type);
      return out({ type: 'thinking_level_changed', level: cmd.level });
    case 'get_login_providers':
      return ok(id, type, { providers: [{ id: 'fake', name: 'Fake Provider', available: true, authenticated: false }] });
    case 'bash': {
      // Like omp, answer only when the command finishes; "sleep" makes it take a while.
      const result = { output: 'hi\n', exitCode: 0, cancelled: false, truncated: false, totalLines: 1, totalBytes: 3, outputLines: 1, outputBytes: 3 };
      return void setTimeout(() => ok(id, type, result), /sleep/.test(cmd.command) ? 600 : 0);
    }
    case 'abort':
      return ok(id, type);
    case 'abort_and_restore_queue':
      return ok(id, type, { steering: [], followUp: [] });
    case 'prompt':
      ok(id, type);
      return void runPrompt(id, cmd.message);
    default:
      return out({ id, type: 'response', command: type, success: false, error: `Unknown command: ${type}` });
  }
});
lines.on('close', () => process.exit(0));
