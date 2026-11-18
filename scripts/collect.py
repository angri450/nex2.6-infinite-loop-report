# 收本轮 sweep 的逐轮 trace：生成指标表、把原始 trace 复制进仓库、并做外泄自检。
import csv, glob, io, json, os, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)                                   # 仓库根

def _find_root():
    # 实验机上的工作区根：优先环境变量，其次当前目录，再次仓库上两级
    cands = [os.environ.get('LOOP_WORKSPACE'), os.getcwd(),
             os.path.abspath(os.path.join(REPO, os.pardir, os.pardir))]
    for c in cands:
        if c and os.path.isfile(os.path.join(c, 'tmp', 'sweep_start.ts')):
            return c
    raise SystemExit('找不到 tmp/sweep_start.ts，请设置环境变量 LOOP_WORKSPACE 指向实验工作区根')

def _find_trace_dir(root):
    for c in [os.environ.get('LOOP_TRACES'),
              os.path.join(root, 'work', 'loop-repro', 'replay'),
              os.path.join(root, 'run', 'sandbox'),
              os.path.join(REPO, 'run', 'sandbox')]:
        if c and os.path.isdir(c):
            return c
    return os.path.join(root, 'run', 'sandbox')

ROOT = _find_root()
SINCE = int(io.open(os.path.join(ROOT, 'tmp', 'sweep_start.ts'), encoding='utf-8').read().strip())
TRACES = sorted(glob.glob(os.path.join(_find_trace_dir(ROOT), 'trace-*-s*-real-r*.json')))

rows = []
for f in TRACES:
    if int(os.path.getmtime(f)) < SINCE:
        continue
    t = json.load(io.open(f, encoding='utf-8'))
    rows.append({
        '植入组数': t.get('seededNoop'), '轮': t.get('trial'), '步数': t.get('steps'),
        '模型自发空操作次数': t.get('noopEdits'), '口令空命令次数': t.get('magicBash'),
        '正文字符': t.get('textOut'), '判定': t.get('verdict'),
        '调用序列': ''.join(t.get('seq', [])), 'max_tokens': t.get('maxTokens'),
        '模型': t.get('model'), '文件': os.path.basename(f),
    })

# 外泄自检：trace 里不该出现对话正文，任何一项值长度超过 200 视为可疑
long_items = [(r['文件'], k, len(str(v))) for r in rows for k, v in r.items() if len(str(v)) > 200]

out_csv = os.path.join(REPO, 'results', '剂量-逐轮.csv')
if rows:
    os.makedirs(os.path.dirname(out_csv), exist_ok=True)
    with io.open(out_csv, 'w', encoding='utf-8-sig', newline='\n') as w:
        cw = csv.DictWriter(w, fieldnames=list(rows[0].keys()))
        cw.writeheader()
        for r in rows:
            cw.writerow(r)

tdir = os.path.join(REPO, 'results', 'traces')
os.makedirs(tdir, exist_ok=True)
for f in TRACES:
    if int(os.path.getmtime(f)) >= SINCE:
        shutil.copy2(f, tdir)

# 汇总发作率
agg = {}
for r in rows:
    k = r['植入组数']
    a = agg.setdefault(k, [0, 0])
    a[0] += 1
    if r['判定'].startswith('LOOP') or (r['模型自发空操作次数'] or 0) >= 8:
        a[1] += 1
print(json.dumps({'本轮留盘轮数': len(rows), '发作率': {str(k): '%d/%d' % (v[1], v[0]) for k, v in sorted(agg.items())},
                  '可疑长项': long_items[:3], 'trace 复制数': len(os.listdir(tdir))}, ensure_ascii=False))
