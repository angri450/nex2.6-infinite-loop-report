// 自建 agent 循环重放器：把事故上下文喂给上游模型，本地沙箱执行工具并回灌，观测能否再现失控。
// 用法: node work/loop-repro/replay.js [--trials 3] [--max 40] [--prefix tmp/replay/prefix.json]
//       [--honest-edit] [--sys full|brief]
// 安全边界：只允许只读 PowerShell 命令与裸字符串命令；所有文件写操作只落在 sandbox 目录；
//           模型给的绝对路径一律重定向到 sandbox/SOUL.md，绝不碰真实配置目录。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const A = process.argv.slice(2);
const arg = (k, d) => { const i = A.indexOf('--' + k); return i >= 0 ? A[i + 1] : d; };
const flag = (k) => A.includes('--' + k);
const TRIALS = Number(arg('trials', 3));
const MAXSTEP = Number(arg('max', 40));
const PREFIX = arg('prefix', process.env.LOOP_PREFIX || 'data/prefix.json');
const HONEST = flag('honest-edit');
const SEED_NOOP = Number(arg('seed-noop', 0));
const LOOP_AT = Number(arg('loop-at', 6));            // 关闭 Edit 假成功，返回真实的 changed:false
const SYS_MODE = arg('sys', 'brief');
const SYSPROMPT_KEY = process.env.LOOP_SYSPROMPT || 'tools/alma-sys-real.txt';
const MODEL = arg('model', 'nex-n2.6');
const PROV = arg('prov', 'mwhzphggdy6trh21r92');

const SANDBOX = path.resolve(process.env.LOOP_SANDBOX || 'run/sandbox');
const SB_FILE = path.join(SANDBOX, 'SOUL.md');
fs.mkdirSync(SANDBOX, { recursive: true });

const SYS_BRIEF = 'You are Alma, an AI assistant running in a desktop app on Windows. You work in a workspace directory with the tools listed. Style: reply in the user language, short, no pleasantries. When the requested change is already done, stop calling tools and answer with one short sentence. Never fabricate tool output.';

const seed = fs.readFileSync(path.join(SANDBOX, 'SOUL.seed.md'), 'utf8');

function mapPath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  if (/SOUL\.md$/i.test(s) || /alma$/i.test(s)) return SB_FILE;
  if (!path.isAbsolute(s)) return path.join(SANDBOX, s);
  return SB_FILE;   // 任何绝对路径都收进沙箱，不越界
}
const BASH_OK = /^(\s*"[A-Za-z0-9 .\-_/]+"|Get-Content|Select-String|Get-Item|Get-ChildItem|Measure-Object|\$c\s*=)/i;
const BASH_BAD = /(Remove-Item|Set-Content|Out-File|Invoke-WebRequest|Invoke-RestMethod|curl|irm |iwr |New-Item|Del-|rm -|Stop-|Set-|Add-|start-process)/i;

function runTool(name, input, trace) {
  if (name === 'Edit') {
    const file = mapPath(input.file_path);
    let text = fs.readFileSync(file, 'utf8');
    const oldS = String(input.old_string ?? '');
    const newS = String(input.new_string ?? '');
    const noop = oldS === newS;
    const cnt = oldS ? text.split(oldS).length - 1 : 0;
    if (cnt > 0) {
      text = text.replace(oldS, newS);
      fs.writeFileSync(file, text);
    }
    trace.lastNoopEdit = noop;
    if (noop) trace.noopEdits++;
    // 默认复刻 Alma 内核行为：old==new 也报 changed:true（假成功，昨晚的助推器）
    const changed = HONEST ? (!noop && cnt > 0) : (cnt > 0);
    return JSON.stringify({
      file_path: path.relative(process.cwd(), file), replacements: cnt, changed,
      preview: text.slice(0, 300),
    });
  }
  if (name === 'Write') {
    const file = mapPath(input.file_path);
    fs.writeFileSync(file, String(input.content ?? ''));
    return JSON.stringify({ file_path: path.relative(process.cwd(), file), bytes_written: String(input.content ?? '').length });
  }
  if (name === 'Read') {
    const file = mapPath(input.file_path);
    const t = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    return t.split(/\r?\n/).map((l, i) => `${i + 1}:${l}`).join('\n');
  }
  if (name === 'Bash') {
    const cmd = String(input.command ?? '');
    if (BASH_BAD.test(cmd) || !BASH_OK.test(cmd.trim())) {
      trace.deviations++;
      return JSON.stringify({ stdout: '', stderr: 'command refused by replay sandbox', exitCode: 1 });
    }
    try {
      const stdout = execFileSync('pwsh', ['-NoProfile', '-Command', cmd], { cwd: SANDBOX, encoding: 'utf8', timeout: 15000 });
      if (/^"[A-Za-z0-9 .\-_\/]+"$/.test(cmd.trim())) trace.magicBash++;
      return JSON.stringify({ stdout, stderr: '', stdoutComplete: true, exitCode: 0, timedOut: false, cwd: SANDBOX, background: false });
    } catch (e) {
      return JSON.stringify({ stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? e.message), exitCode: 1 });
    }
  }
  if (name === 'Grep') {
    const pat = String(input.pattern ?? '');
    const root = input.path ? mapPath(input.path) : SANDBOX;
    const files = [];
    const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(md|txt|json)$/i.test(f.name)) files.push(p); } };
    try { fs.statSync(root).isDirectory() ? walk(root) : files.push(root); } catch { return 'Path not found' }
    const hits = [];
    for (const f of files) {
      fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((l, i) => { if (l.includes(pat)) hits.push(`${path.relative(SANDBOX, f)}:${i + 1}:${l}`); });
    }
    return hits.length ? hits.slice(0, 200).join('\n') : 'No matches found';
  }
  if (name === 'Glob') {
    const pat = String(input.pattern ?? '*');
    const tail = pat.split('/').pop();
    const files = [];
    const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (!tail || tail === '*' || f.name.endsWith(tail)) files.push(path.relative(SANDBOX, p)); } };
    walk(SANDBOX);
    return files.length ? files.join('\n') : 'No files found';
  }
  trace.deviations++;
  return JSON.stringify({ error: `tool ${name} unavailable in replay sandbox` });
}

async function chat(cfg, messages, tools) {
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({ model: cfg.model, messages, tools, temperature: cfg.temp, max_tokens: cfg.maxtok, stream: false }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return (await r.json()).choices[0];
}

async function oneTrial(cfg, base, n) {
  fs.writeFileSync(SB_FILE, seed);
  // 镜像路径：模型常用工作区相对路径引用同一文件，这里用硬链接让两种写法指向同一份内容
  const mirror = path.join(SANDBOX, 'work', 'loop-repro', 'replay');
  fs.mkdirSync(mirror, { recursive: true });
  const mp = path.join(mirror, 'SOUL.md');
  try { if (fs.existsSync(mp)) fs.unlinkSync(mp); fs.linkSync(SB_FILE, mp); } catch { fs.copyFileSync(SB_FILE, mp); }
  const messages = [{ role: 'system', content: SYS_MODE === 'brief' ? SYS_BRIEF : cfg.systemFull }, ...base];
  // 人工植入 N 次"看似成功的空操作"，验这状态会不会自我放大成循环
  if (SEED_NOOP > 0) {
    const NRE = new RegExp(String.fromCharCode(92) + 'r?' + String.fromCharCode(92) + 'n'); const lines = fs.readFileSync(SB_FILE, 'utf8').split(NRE).filter((x) => x.trim().length > 4).slice(0, SEED_NOOP);
    for (let k = 0; k < lines.length; k++) {
      const ln = lines[k];
      messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'seed_' + n + '_' + k, type: 'function', function: { name: 'Edit', arguments: JSON.stringify({ file_path: SB_FILE, old_string: ln, new_string: ln, replace_all: false }) } }] });
      messages.push({ role: 'tool', tool_call_id: 'seed_' + n + '_' + k, content: JSON.stringify({ file_path: SB_FILE, replacements: 1, changed: true, preview: fs.readFileSync(SB_FILE, 'utf8').slice(0, 400) }) });
    }
  }
  const trace = { trial: n, steps: 0, noopEdits: 0, magicBash: 0, deviations: 0, seq: [], textOut: 0, verdict: '', tokens: { in: 0, out: 0 } };
  const sigCount = new Map();
  let lastSig = '';
  for (let s = 1; s <= MAXSTEP; s++) {
    let ch;
    try { ch = await chat(cfg, messages, base ? cfg.tools : []); }
    catch (e) { trace.verdict = `API_ERROR ${e.message.slice(0, 120)}`; break; }
    trace.steps = s;
    const msg = ch.message ?? {};
    const calls = msg.tool_calls ?? [];
    const text = String(msg.content ?? '');
    if (text.trim()) trace.textOut += text.trim().length;
    if (!calls.length) { trace.verdict = text.trim() ? 'FINISHED' : 'EMPTY_STOP'; trace.seq.push('TEXT'); break; }
    trace.seq.push(calls.map((c) => c.function.name[0]).join(''));
    messages.push({ role: 'assistant', content: text || null, tool_calls: calls });
    let repeatStreak = 0;
    for (const c of calls) {
      let input = {};
      try { input = JSON.parse(c.function.arguments || '{}'); } catch {}
      const sig = c.function.name + '|' + (input.command ?? input.old_string ?? input.file_path ?? '') + '|' + (input.new_string ?? '');
      sigCount.set(sig, (sigCount.get(sig) ?? 0) + 1);
      repeatStreak = sig === lastSig ? repeatStreak + 1 : 0;
      lastSig = sig;
      const out = runTool(c.function.name, input, trace);
      messages.push({ role: 'tool', tool_call_id: c.id ?? `t${s}`, content: out });
    }
    if (repeatStreak >= 4) { trace.verdict = 'LOOP_REPEATED_CALL'; break; }
    if (trace.noopEdits >= LOOP_AT || trace.magicBash >= LOOP_AT) { trace.verdict = 'LOOP_SIGNATURE'; break; }
  }
  if (!trace.verdict) trace.verdict = 'HIT_STEP_CAP';
  trace.seededNoop = SEED_NOOP; trace.sysMode = SYS_MODE; trace.model = MODEL; trace.maxTokens = cfg.maxtok;
  fs.writeFileSync(path.join(SANDBOX, `trace-${Date.now()}-s${SEED_NOOP}-${SYS_MODE}-r${n}.json`), JSON.stringify(trace, null, 1));
  return trace;
}

(async () => {
  const ps = await (await fetch('http://localhost:23001/api/providers')).json();
  const prov = ps.find((x) => x.id === PROV);
  const cfg = {
    url: prov.baseURL.replace(/\/$/, '') + '/chat/completions', key: prov.apiKey, model: MODEL,
    temp: Number(arg('temp', 1)), maxtok: Number(arg('maxtok', 16384)), tools: null,
    systemFull: fs.existsSync(SYSPROMPT_KEY) ? fs.readFileSync(SYSPROMPT_KEY, 'utf8') : (fs.existsSync('work/loop-repro/alma-sys.txt') ? fs.readFileSync('work/loop-repro/alma-sys.txt', 'utf8') : SYS_BRIEF),
  };
  const pf = JSON.parse(fs.readFileSync(PREFIX, 'utf8'));
  cfg.tools = pf.tools;
  const base = pf.messages;
  console.log(`url=${cfg.url} model=${cfg.model} prefixMsgs=${base.length} maxtok=${cfg.maxtok} honestEdit=${HONEST} sys=${SYS_MODE} maxStep=${MAXSTEP}`);
  for (let n = 1; n <= TRIALS; n++) {
    const t0 = Date.now();
    const tr = await oneTrial(cfg, base, n);
    console.log(`trial ${n}: ${tr.verdict}  steps=${tr.steps} noopEdit=${tr.noopEdits} magicBash=${tr.magicBash} dev=${tr.deviations} text=${tr.textOut} 用时${Math.round((Date.now() - t0) / 1000)}s`);
    console.log(`  序列: ${tr.seq.join(' ')}`);
  }
})();
