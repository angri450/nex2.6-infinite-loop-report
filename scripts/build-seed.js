// 从留档重建那一刻的 SOUL.md（沙箱种子文件）。
// 依据：事故那一轮第一次 Write 的内容是改后态，引发前的状态按留档证据反推两处：
//   1. 开头是封闭表述（六个特征、每段只属一个）
//   2. 末尾还有价值标准、语言规范、检查清单三个占位节
const fs = require('fs');
const j = JSON.parse(fs.readFileSync((process.env.LOOP_PAGES || 'data/pages') + '/page40.json', 'utf8'));
const loop = j.messages.find((m) => String(m.slotId).endsWith('mwjexk9zmr37uedipfl'));
const w = loop.message.parts.find((p) => p.type === 'tool-Write');
let content = w.input.content;

const OPEN_NEW = '本节定义一组特征，用于给模型输出中的内容成分命名，后续规则按需引用。目前收录以下六项，清单可继续增补。';
const OPEN_OLD = '本节定义六个特征，作为后续规则和交流的统一用语。每段内容属于且只属于一个特征。';
if (!content.includes(OPEN_NEW)) throw new Error('没找到改后开头句，种子重建失败');
content = content.replace(OPEN_NEW, OPEN_OLD);
content = content.replace(/\s*$/, '\n\n') + '## 2 价值标准（待定）\n\n## 3 语言规范（待定）\n\n## 4 检查清单（待定）\n';

fs.mkdirSync(process.env.LOOP_SANDBOX || 'run/sandbox', { recursive: true });
fs.writeFileSync((process.env.LOOP_SANDBOX || 'run/sandbox') + '/SOUL.seed.md', content);
console.log(JSON.stringify({
  bytes: content.length,
  lines: content.split('\n').length,
  head: content.split('\n').slice(0, 3),
  tail: content.trimEnd().split('\n').slice(-4),
  hasClosedFraming: content.includes('每段内容属于且只属于一个特征'),
  hasPlaceholders: content.includes('价值标准（待定）'),
}, null, 1));
