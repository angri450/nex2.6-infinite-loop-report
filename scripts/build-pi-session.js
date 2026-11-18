// 把 Alma 事故留档（tmp/replay/prefix.json）转成 pi 会话文件，用于在 pi 里续跑同一份历史。
// 有损转换三处，都在输出的 stats 里计数：AskUserQuestion 改写成 bash 注释、
// 工具名与入参形状换成 pi 的 schema、绝对路径统一写成 SOUL.md 相对名。
const fs = require('fs');
const path = require('path');

const src = JSON.parse(fs.readFileSync(process.env.LOOP_PREFIX || 'data/prefix.json', 'utf8'));
if (process.argv.includes('--drop-last-user')) {           // 把引发那句留给 pi 自己发，等于真实现场
  for (let i = src.messages.length - 1; i >= 0; i--) {
    if (src.messages[i].role === 'user') { src.trigger = src.messages[i].content; src.messages.splice(i, 1); break; }
  }
}
const OUT_DIR = process.argv[2] || 'run/pi-sessions';
fs.mkdirSync(OUT_DIR, { recursive: true });

const CWD = path.resolve(process.env.PI_SANDBOX || 'run/pisandbox');
fs.mkdirSync(CWD, { recursive: true });

const stats = { askRemapped: 0, nameMapped: 0, argMapped: 0, pathRewritten: 0, skipped: 0 };
const id = () => Math.random().toString(16).slice(2, 10);
const entries = [];
let prev = null;
function push(obj) {
  const e = { type: 'message', id: id(), parentId: prev, timestamp: new Date().toISOString(), message: obj };
  prev = e.id; entries.push(e); return e;
}
function toPi(msg) {
  if (msg.role === 'user') return { role: 'user', content: [{ type: 'text', text: String(msg.content ?? '') }], timestamp: Date.now() };
  const blocks = [];
  if (msg.reasoning_content) blocks.push({ type: 'thinking', thinking: msg.reasoning_content, thinkingSignature: 'reasoning_content' });
  if (msg.content) blocks.push({ type: 'text', text: msg.content });
  for (const tc of (msg.tool_calls || [])) {
    let name = tc.function.name;
    let args = {};
    try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
    const p = String(args.file_path ?? args.path ?? '');
    if (p) { args.file_path && delete args.file_path; args.path = /SOUL\.md$/i.test(p) ? 'SOUL.md' : path.basename(p); stats.pathRewritten++; }
    if (name === 'Bash') { const c = args.command; args = { command: c }; stats.nameMapped++; }
    else if (name === 'Read') { stats.nameMapped++; }
    else if (name === 'Write') { const ct = args.content; args = { path: args.path, content: ct }; stats.nameMapped++; }
    else if (name === 'Edit') {
      args = { path: args.path, edits: [{ oldText: args.old_string ?? '', newText: args.new_string ?? '' }] };
      stats.nameMapped++; stats.argMapped++;
    } else if (name === 'AskUserQuestion') {
      args = { command: `# 历史调用 AskUserQuestion（pi 无此工具）：${String(args.questions ?? '').slice(0, 120)}` };
      name = 'bash'; stats.askRemapped++;
    } else { args = { command: `# 历史调用 ${name}` }; name = 'bash'; stats.askRemapped++; }
    blocks.push({ type: 'toolCall', id: tc.id || `call-${id()}`, name, arguments: args });
  }
  return { role: 'assistant', content: blocks, api: 'openai-completions', provider: 'moss', model: 'nex-n2.6', stopReason: blocks.some((b) => b.type === 'toolCall') ? 'tool_calls' : 'stop', timestamp: Date.now() };
}

const head = { type: 'session', version: 3, id: '01a1dead-0000-7000-8000-' + Date.now().toString(16).padStart(12, '0'), timestamp: new Date().toISOString(), cwd: CWD };
const mc = { type: 'model_change', id: id(), parentId: null, timestamp: new Date().toISOString(), provider: 'moss', modelId: 'nex-n2.6' };
head.next = mc.id; mc.parentId = null;
entries.push(head, mc);
prev = mc.id;
let pendingResults = [];
for (const m of src.messages) {
  if (m.role === 'tool') {
    push({ role: 'toolResult', toolCallId: m.tool_call_id, toolName: 'bash', content: [{ type: 'text', text: String(m.content ?? '').slice(0, 20000) }], isError: false, durationMs: 500, timestamp: Date.now() });
    continue;
  }
  push(toPi(m));
}
const file = path.join(OUT_DIR, `nex-replay-${Date.now()}.jsonl`);
fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
const lastUser = [...src.messages].reverse().find((m) => m.role === 'user');
fs.writeFileSync(path.join(OUT_DIR, 'trigger.txt'), src.trigger || '', 'utf8');
console.log(JSON.stringify({ file, cwd: CWD, triggerChars: (src.trigger || '').length, entries: entries.length, messages: src.messages.length, stats, lastUserInPrefix: String(lastUser?.content ?? '').slice(0, 50) }, null, 1));
