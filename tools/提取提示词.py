#!/usr/bin/env python3
"""从本机 Alma 安装里提取真实系统提示词，供 scripts/replay.js 使用。

不在仓库里直接放这份提示词原文，原因是它属于客户端程序。你在自己机器上跑一次即可，
输出文件 tools/alma-sys-real.txt 已在 .gitignore 里，不会被误提交。

用法:
    python tools/提取提示词.py [server.mjs 路径]

不传路径时按 Windows 默认安装位置查找，也可用环境变量 ALMA_SERVER_BUNDLE 指定。
"""
import io
import os
import sys

START = 'LANGUAGE RULE (CRITICAL)'
END = 'write that down first'
BS = chr(92)
NL = chr(10)


def candidates():
    env = os.environ.get('ALMA_SERVER_BUNDLE')
    if env:
        yield env
    local = os.environ.get('LOCALAPPDATA', '')
    yield os.path.join(local, 'Programs', 'Alma', 'alma-server', 'lib', 'server.mjs')
    pf = os.environ.get('PROGRAMFILES', '')
    yield os.path.join(pf, 'Alma', 'alma-server', 'lib', 'server.mjs')


def find_bundle():
    if len(sys.argv) > 1:
        return sys.argv[1]
    for p in candidates():
        if p and os.path.isfile(p):
            return p
    raise SystemExit('没找到 alma-server/lib/server.mjs，请把路径作为参数传入，或设置 ALMA_SERVER_BUNDLE')


def unescape(seg):
    out = []
    i = 0
    while i < len(seg):
        c = seg[i]
        if c == BS and i + 1 < len(seg):
            n = seg[i + 1]
            table = {'n': NL, 't': chr(9), 'r': chr(13), '"': '"', BS: BS, '/': '/'}
            if n in table:
                out.append(table[n])
                i += 2
                continue
            if n == 'u' and i + 5 < len(seg):
                try:
                    out.append(chr(int(seg[i + 2:i + 6], 16)))
                    i += 6
                    continue
                except ValueError:
                    pass
        out.append(c)
        i += 1
    return ''.join(out)


def main():
    bundle = find_bundle()
    raw = io.open(bundle, encoding='utf-8', errors='replace').read()
    a = raw.find(START)
    b = raw.find(END)
    if a < 0 or b < 0:
        raise SystemExit('在 %s 里没找到提示词边界，可能版本不同，请自行改 START 与 END 两个标记' % bundle)
    txt = unescape(raw[a:b + len(END) + 2])
    keys = ['COMMITMENT ENFORCEMENT', 'PROACTIVE UPDATES', 'AGENTIC EXECUTION',
            'LAND THE ANSWER EARLY', 'ACCEPTANCE ON THE TASK', 'WORKSPACE HYGIENE',
            'DELEGATION STAYS IN THE TURN']
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'alma-sys-real.txt')
    io.open(out, 'w', encoding='utf-8', newline=NL).write(txt)
    print('来源:', bundle)
    print('写出:', out)
    print('字符数:', len(txt), '| 行数:', txt.count(NL) + 1)
    for k in keys:
        print('  含', k, ':', k in txt)


if __name__ == '__main__':
    main()
