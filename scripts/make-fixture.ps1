# 生成重现夹具。K = 文件里超标的条数（判定标准：正文不超过 10 个字）。
# 用法: pwsh -File work/loop-repro/make-fixture.ps1 -K 12
param([Parameter(Mandatory = $true)][int]$K)

$short = @(
  '一句只说一件事。', '主谓宾要齐全。', '动词用主动语态。', '动宾搭配要得上。',
  '表完成的了字保留。', '年份写四位数字。', '星期写星期几。', '数字要带单位。',
  '正文不留待补标记。', '一词一义不换叫法。', '无用修饰一律删掉。', '标题写完整说法。',
  '列表有几条写几条。', '讲完最后一件就停。', '开头第一句进正题。', '不夹带多余的内容。'
)
$long = @(
  '动词一律用主动语态并且要写明动作的发出者是谁。', '正文里面不许出现待补待定这类占位标记。',
  '标题和章节名要写成五个字以上的完整说法才行。', '数字一定要带上单位和统计范围才算写清楚。',
  '开头的第一句话要直接进正题不要写客套话。', '列表里有几条就写几条不要在正文里凑数量词。',
  '同一个概念全文只用一个词不要换着叫法写。', '修饰语删掉以后结论不变的就应该删掉。',
  '表示完成的了字要保留下来不要省掉。', '年份一律写成四位数字不要写两位。',
  '主语谓语宾语要齐全指不出动作发出者就补上。', '讲完最后一件实质内容就停不要预告下文。',
  '不夹带用户没有要的东西进去。', '标点里不许出现破折号。',
  '一段最多只能有一个冒号。', '句子之间要有能判真假的关系词。'
)
if ($K -gt $long.Count) { throw "K 最大 $($long.Count)" }

$dir = "work/loop-repro/trial-K$K"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$lines = @('# 写作规则', '')
for ($i = 0; $i -lt 16; $i++) {
  $body = if ($i -lt $K) { $long[$i] } else { $short[$i] }
  $lines += "$($i + 1). $body"
}
$lines -join "`r`n" | Set-Content -Path "$dir/rules.md" -Encoding UTF8 -NoNewline

# 自检：超标行数必须等于 K
$check = 0
foreach ($l in (Get-Content "$dir/rules.md")) {
  if ($l -match '^(\d+)\.\s*(.+)$') {
    if ($Matches[2].TrimEnd().Length -gt 10) { $check++ }
  }
}
if ($check -ne $K) { throw "夹具自检失败：期望 $K 条超标，实际 $check 条" }
"OK $dir  超标 $check 条  行数 $((Get-Content "$dir/rules.md").Count)"
