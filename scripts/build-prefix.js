// 把事故留档转成 OpenAI chat 格式的上下文前缀。
// 用法: node work/loop-repro/build-prefix.js [--with-reasoning] [--out tmp/replay/prefix.json]
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const withReasoning = args.includes('--with-reasoning');
const outIdx = args.indexOf('--out');
const PAGES = process.env.LOOP_PAGES || 'data/pages';
const PREFIX = process.env.LOOP_PREFIX || 'data/prefix.json';
const SANDBOX = process.env.LOOP_SANDBOX || 'run/sandbox';
const SYSPROMPT = process.env.LOOP_SYSPROMPT || 'tools/alma-sys-real.txt';
const OUT = outIdx >= 0 ? args[outIdx + 1] : PREFIX;

const LOOP_MSG = 'mwjexk9zmr37uedipfl';          // 事故那一轮 assistant
const TRIGGER = 'mwjbzaqfd0i8yc8zs6w--user-1794842562569'; // 引发那句否定纠正

let all = [];
for (const f of fs.readdirSync(PAGES).filter((x) => /^page\d+\.json$/.test(x))) {
  const j = JSON.parse(fs.readFileSync(path.join(PAGES, f), 'utf8'));
  all = all.concat(j.messages || []);
}
const seen = new Set();
const msgs = [];
for (const m of all) { if (!seen.has(m.slotId)) { seen.add(m.slotId); msgs.push(m); } }
msgs.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

// 工具 schema：名字与关键入参按留档重建，描述为占位（与 Alma 原文不同，报告里如实标注）
const TOOLS = [
  { type: 'function', function: { name: 'Bash', description: '运行 shell 命令，前台返回 stdout 与 stderr。', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' }, timeout: { type: 'integer' }, run_in_background: { type: 'boolean' } }, required: ['command', 'description'] } } },
  { type: 'function', function: { name: 'Read', description: '读取文件内容。', parameters: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['file_path'] } } },
  { type: 'function', function: { name: 'Write', description: '写入文件。', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } } },
  { type: 'function', function: { name: 'Edit', description: '把文件里的 old_string 替换成 new_string。', parameters: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['file_path', 'old_string'] } } },
  { type: 'function', function: { name: 'Glob', description: '按模式找文件。', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'Grep', description: '搜索文件内容。', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } } },
];

const isLoop = (id) => String(id).endsWith(LOOP_MSG);
const isTrigger = (id) => String(id).endsWith(TRIGGER);

const out = [];
for (const m of msgs) {
  if (isLoop(m.slotId)) continue;                   // 事故那一轮本身不进前缀
  if (m.message.role === 'user') {
    const t = (m.message.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    out.push({ role: 'user', content: t });
    continue;
  }
  if (m.message.role !== 'assistant') continue;
  const parts = m.message.parts || [];
  const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  const reason = parts.filter((p) => p.type === 'reasoning').map((p) => p.text).join('\n');
  const calls = parts.filter((p) => p.type && p.type.startsWith('tool-')).map((p, i) => ({
    id: p.toolCallId || `call_${m.slotId}_${i}`,
    type: 'function',
    function: { name: p.type.slice(5), arguments: JSON.stringify(p.input ?? {}) },
  }));
  const msg = { role: 'assistant', content: text || (calls.length ? '' : null) };
  if (withReasoning && reason) msg.reasoning_content = reason;
  if (calls.length) msg.tool_calls = calls;
  out.push(msg);
  for (const p of parts) {
    if (!p.type || !p.type.startsWith('tool-')) continue;
    const id = p.toolCallId || `call_${m.slotId}`;
    out.push({ role: 'tool', tool_call_id: id, content: typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? null) });
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ messages: out, tools: TOOLS }, null, 0));
const bytes = fs.statSync(OUT).size;
console.log(JSON.stringify({
  file: OUT, withReasoning, messages: out.length,
  users: out.filter((x) => x.role === 'user').length,
  assistants: out.filter((x) => x.role === 'assistant').length,
  toolResults: out.filter((x) => x.role === 'tool').length,
  endsWithTrigger: out[out.length - 1]?.role === 'user',
  lastUserPreview: String(out.filter((x) => x.role === 'user').slice(-1)[0]?.content ?? '').slice(0, 60),
  bytes, approxTokens: Math.round(bytes / 3.2),
}, null, 1));
