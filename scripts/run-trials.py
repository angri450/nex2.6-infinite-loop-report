# 在 pi 里续跑事故会话：每次造一份新会话文件（含 next 链与完整 usage），重置沙箱 SOUL.md，
# 用事故那句纠正引发，量步数、重复调用、空操作报错、思考重复度。源码里不写反斜杠字面量。
import io, json, os, subprocess, sys, time, uuid, glob, collections, shutil

PI = shutil.which('pi') or shutil.which('pi.cmd') or shutil.which('pi.exe') or 'pi'

NL = chr(10)
WS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(WS)
SB = os.path.join(ROOT, 'run', 'pisandbox')
SRC = os.path.join(ROOT, 'run', 'pi-sessions')
SEED = os.path.join(ROOT, 'run', 'sandbox', 'SOUL.seed.md')
REALSYS = os.path.join(ROOT, 'tools', 'alma-sys-real.txt')
win = os.path.abspath(SB)
mapped = '--' + win.replace(':', '-').replace(os.sep, '-') + '--'
SDIR = os.path.join(os.path.expanduser('~'), '.pi', 'agent', 'sessions', mapped)
TRIGGER = io.open(os.path.join(SRC, 'trigger.txt'), encoding='utf-8').read().strip()

def _home_pairs():
    hw = os.path.expanduser('~').replace(chr(92), '/')
    return [(hw + '/.config/alma/SOUL.md', './SOUL.md'),
            (hw + '/.config/alma/', './.cfg/'),
            (hw, '~')]

def _extra_pairs():
    # 可选：tools/路径替换表.txt，每行一条「原路径=替换成」，用来抹掉你自己机器上的其它路径
    f = os.path.join(ROOT, 'tools', '路径替换表.txt')
    out = []
    if os.path.isfile(f):
        for line in io.open(f, encoding='utf-8'):
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                a, b = line.split('=', 1)
                out.append((a.replace(chr(92), '/').rstrip('/'), b.strip()))
    return out

SANITIZE_PAIRS = _extra_pairs() + _home_pairs()



def read_rows(p):
    out = []
    for line in io.open(p, encoding='utf-8'):
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


# 净化：历史里带的真实绝对路径会让 pi 直接去读用户机器上的正本文件，把任务偷换成审文件；
# 工具名大小写不对会让 pi 报 Tool not found。两处都在写会话前抹平。
def sanitize(x):
    if isinstance(x, str):
        t = x.replace('\\', '/')
        for a, b in SANITIZE_PAIRS:
            t = t.replace(a, b)
        return t
    if isinstance(x, dict):
        return {k: sanitize(v) for k, v in x.items()}
    if isinstance(x, list):
        return [sanitize(v) for v in x]
    return x


def stamp():
    return time.strftime('%Y-%m-%dT%H-%M-%S-', time.gmtime()) + '%03dZ' % (int(time.time() * 1000) % 1000)


def make_session():
    f = sorted(glob.glob(os.path.join(SRC, '*.jsonl')))[-1]
    rows = read_rows(f)
    sid = str(uuid.uuid4())
    rows[0]['id'] = sid
    rows[0]['timestamp'] = stamp().replace('-', ':', 3)
    for i in range(len(rows) - 1):
        rows[i]['next'] = rows[i + 1].get('id')
    rows[-1].pop('next', None)
    for i, o in enumerate(rows):
        if i:
            o['parentId'] = rows[i - 1].get('id')
        m = o.get('message')
        if isinstance(m, dict) and m.get('role') == 'assistant' and not isinstance(m.get('usage'), dict):
            m['usage'] = {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'reasoning': 0,
                          'totalTokens': 0,
                          'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 0,
                                   'totalFromProvider': False}}
            m.setdefault('thinkingLevel', 'medium')
            m.setdefault('durationMs', 1500)
            m.setdefault('api', 'openai-completions')
            m.setdefault('provider', 'moss')
            m.setdefault('model', 'nex-n2.6')
    if not os.path.isdir(SDIR):
        os.makedirs(SDIR)
    p = os.path.join(SDIR, stamp() + '_' + sid + '.jsonl')
    with io.open(p, 'w', encoding='utf-8', newline=NL) as w:
        for o in rows:
            w.write(json.dumps(sanitize(o), ensure_ascii=False) + NL)
    return p


def measure(fp):
    ev = read_rows(fp)
    starts = [e.get('data', e) for e in ev if e.get('type') == 'tool_execution_start']
    ends = [e.get('data', e) for e in ev if e.get('type') == 'tool_execution_end']
    sigs = collections.Counter()
    noop = magic = mx = 0
    think = []
    for t in starts:
        a = t.get('args') or {}
        sigs[(t.get('toolName'), json.dumps(a, ensure_ascii=False, sort_keys=True)[:400])] += 1
        cmd = a.get('command')
        if isinstance(cmd, str) and len(cmd) > 1 and cmd[0] == '"' and cmd[-1] == '"':
            magic += 1
    for x in ends:
        r = x.get('result')
        txt = json.dumps(r, ensure_ascii=False) if isinstance(r, (dict, list)) else str(r)
        if 'identical content' in txt or 'No changes made' in txt:
            noop += 1
    last = ''
    for e in ev:
        d = e.get('data', e)
        m = d.get('message') if isinstance(d, dict) else None
        if isinstance(m, dict) and m.get('role') == 'assistant':
            u = m.get('usage') or {}
            mx = max(mx, (u.get('input') or 0) + (u.get('cacheRead') or 0) + (u.get('cacheWrite') or 0))
            for b in (m.get('content') or []):
                if isinstance(b, dict) and b.get('type') == 'thinking' and b.get('thinking'):
                    think.append(b['thinking'].strip())
                if isinstance(b, dict) and b.get('type') == 'text' and b.get('text', '').strip():
                    last = b['text'].strip()
    joined = NL.join(think)
    grams = set(joined[i:i + 24] for i in range(max(0, len(joined) - 23))) if joined else set()
    uniq = round(len(grams) / max(1, len(joined) - 23), 3) if joined else 1.0
    return {'turns': sum(1 for e in ev if e.get('type') == 'turn_end'), 'calls': len(starts),
            'maxCtx': mx, 'dupSameCall': max(sigs.values()) if sigs else 0,
            'dupKinds': sum(1 for k, v in sigs.items() if v >= 2),
            'noopEditErrors': noop, 'magicBash': magic, 'thinkChars': len(joined),
            'uniq24gram': uniq, 'finalChars': len(last), 'final': last[:140].replace(NL, ' ')}


n = int(sys.argv[1]) if len(sys.argv) > 1 else 4
print('引发那句:', TRIGGER[:40], '| 会话目录:', os.path.basename(SDIR))
for i in range(1, n + 1):
    make_session()
    io.open(os.path.join(SB, 'SOUL.md'), 'w', encoding='utf-8', newline=NL).write(io.open(SEED, encoding='utf-8').read())
    sysargv = []
    if '--real-sys' in sys.argv:
        sysargv = ['--append-system-prompt', REALSYS]
    out = os.path.join(ROOT, 'results', 'pi-%s-%d.json' % ('real' if '--real-sys' in sys.argv else 'trial', i))
    t0 = time.time()
    with io.open(out, 'w', encoding='utf-8') as fo, io.open(out + '.err', 'w', encoding='utf-8') as fe:
        try:
            subprocess.run([PI, '--continue', '-p', '--model', 'moss/nex-n2.6', '--no-extensions', '--no-mcp',
                            '--no-skills', '--mode', 'json'] + sysargv + [TRIGGER], cwd=SB, stdout=fo, stderr=fe, timeout=540)
        except subprocess.TimeoutExpired:
            print('trial %d: 540 秒超时被掐' % i)
    r = measure(out)
    r['trial'] = i
    r['secs'] = round(time.time() - t0, 1)
    r['verdict'] = ('LOOP' if (r['dupSameCall'] >= 3 or r['noopEditErrors'] >= 3 or r['magicBash'] >= 3)
                    else ('EMPTY' if not r['finalChars'] else 'ok'))
    print(json.dumps(r, ensure_ascii=False))
    sys.stdout.flush()
