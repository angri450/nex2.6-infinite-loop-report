# 度量 pi --mode json 的事件流，按失控特征逐项计数。
# 用法: python work/pi-probe/measure-pi.py <事件文件.json> [<再一个> ...]
import json, re, sys
from collections import Counter

MAGIC = re.compile(r'^"[A-Za-z0-9 .\-_/]+"$')
PROG = re.compile(r'(?i)grep|cat|sed|awk|python|node|ls |wc |head|tail|echo|printf|find|sort')

def load(fp):
    ev = []
    for line in open(fp, encoding='utf-8'):
        line = line.strip()
        if not line: continue
        try: ev.append(json.loads(line))
        except json.JSONDecodeError: pass
    return ev

def d(e): return e.get('data', e)

for fp in sys.argv[1:]:
    ev = load(fp)
    starts = [d(e) for e in ev if e.get('type') == 'tool_execution_start']
    ends = [d(e) for e in ev if e.get('type') == 'tool_execution_end']
    names = Counter(t.get('toolName') for t in starts)
    ident = magic = notfound = 0
    for x in ends:
        r = x.get('result')
        txt = json.dumps(r, ensure_ascii=False) if isinstance(r, (dict, list)) else str(r)
        if 'identical content' in txt or 'No changes made' in txt: ident += 1
        if 'not found' in txt or 'ENOENT' in txt: notfound += 1
    for t in starts:
        a = t.get('args') or {}
        cmd = a.get('command')
        if t.get('toolName') in ('bash','powershell') and isinstance(cmd,str) and MAGIC.match(cmd.strip()) and not PROG.search(cmd):
            magic += 1
    texts = []
    for e in ev:
        if e.get('type') == 'message_end':
            m = d(e).get('message', {})
            if m.get('role') == 'assistant':
                c = m.get('content')
                if isinstance(c, list):
                    c = ' '.join(x.get('text','') for x in c if isinstance(x,dict) and x.get('type')=='text')
                if c and c.strip(): texts.append(c.strip())
    turns = sum(1 for e in ev if e.get('type')=='turn_end')
    errs = sum(1 for x in ends if x.get('isError'))
    last = texts[-1] if texts else ''
    verdict = 'LOOP' if (ident>=3 or magic>=3) else ('EMPTY_FINAL' if not last.strip() else 'ok')
    print(json.dumps({'file':fp.split('/')[-1],'turns':turns,'toolCalls':len(starts),'byTool':dict(names),
        'toolErrors':errs,'noopEditErrors':ident,'magicBash':magic,'pathMiss':notfound,
        'finalTextChars':len(last),'verdict':verdict}, ensure_ascii=False))
    if last: print('   末条:', last[:220].replace('\n',' '))
