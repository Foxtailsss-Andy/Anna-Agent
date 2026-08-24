/**
 * 示例帧序列(仅供预览/单测;真实数据一律来自引擎 SSE)
 * 文案沿用设计画布 4b/3c/3d 与《Runtime Brief》§2 参考实例(exit 143 超时)。
 */

import type { Frame } from '../lib/frames';

/* ---------------- 运行中(流式) ---------------- */

export const framesRunning: Frame[] = [
  { type: 'event', name: 'run.created', turn: 0, at: 100 },
  { type: 'event', name: 'skill.loaded', turn: 0, at: 400 },

  { type: 'step', phase: 'analyze', intent: '先列计划，再写金句，最后做页面', turn: 1, at: 1200 },
  { type: 'thinking', turn: 1, delta: '用户要求分三步：1） 计划工具列出执行计划 2） 写团队协作金句 3） 网页产物工具输出展示页。\n先调用 plan.update 建立三项计划，确认写入成功后再逐项执行。金句必须短、有画面感，避免口号腔；展示页用单屏居中排版。' },
  { type: 'tool_start', tool: 'plan.update', turn: 1, at: 4400 },
  {
    type: 'tool_done', tool: 'plan.update', ok: true, turn: 1, at: 5210,
    drilldown: {
      contract: 'v1 · 3f9c…e2',
      argsPreview: '{"items":["列出执行计划","输出团队协作金句","生成展示页面"]}',
      resultPreview: 'ok · 3 项写入 · 读回校验通过',
    },
  },
  {
    type: 'plan.updated',
    plan: [
      { id: 'p1', title: '列出执行计划', status: 'done' },
      { id: 'p2', title: '输出团队协作金句', status: 'in_progress' },
      { id: 'p3', title: '生成展示页面', status: 'pending' },
    ],
  },
  { type: 'text_delta', turn: 1, delta: '计划已列好，共三项。接下来为您拟金句，再做展示页。' },

  { type: 'step', phase: 'analyze', intent: '金句要短，要有画面感', turn: 2, at: 6300 },
  { type: 'thinking', turn: 2, delta: '备选方向：节奏感（快与远对比）、乐队比喻、灯塔比喻。选“冲刺 vs 节奏”——具体、有画面，不喊口号。' },
  { type: 'step', phase: 'tool', intent: '正在生成网页产物……', tool: 'chat.emit_page', turn: 2, at: 8600 },
  { type: 'tool_start', tool: 'chat.emit_page', turn: 2, at: 8600 },
];

/* ---------------- 完成(礼成) ---------------- */

export const framesDone: Frame[] = [
  ...framesRunning,
  {
    type: 'tool_done', tool: 'chat.emit_page', ok: true, turn: 2, at: 32800,
    drilldown: {
      contract: 'v1 · 8a41…c7',
      argsPreview: '{"title":"团队协作金句页","layout":"single","quote":"走得快靠一个人的冲刺，走得远靠一群人的节奏。"}',
      resultPreview: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">……（预览 1,024 bytes）',
      bytes: 18_432,
      truncated: true,
    },
  },
  {
    type: 'plan.updated',
    plan: [
      { id: 'p1', title: '列出执行计划', status: 'done' },
      { id: 'p2', title: '输出团队协作金句', status: 'done' },
      { id: 'p3', title: '生成展示页面', status: 'done' },
    ],
  },
  { type: 'text_delta', turn: 2, delta: '都办妥了。计划三项全部勾讫，金句誊在下面，展示页已在画布备好，请您过目。' },
  {
    type: 'done', at: 34200,
    run: {
      runId: '9F3KE2',
      artifacts: [{ id: 'a1', title: '团队协作金句页', kind: 'page' }],
      plan: [
        { id: 'p1', title: '列出执行计划', status: 'done' },
        { id: 'p2', title: '输出团队协作金句', status: 'done' },
        { id: 'p3', title: '生成展示页面', status: 'done' },
      ],
      usage: { tokens: 1842, model: 'deepseek-chat' },
      durationMs: 34200,
    },
  },
];

/* ---------------- 失败(留证:exit 143 超时,《Runtime Brief》§2 参考实例) ---------------- */

export const framesFailed: Frame[] = [
  { type: 'event', name: 'run.created', turn: 0, at: 100 },
  { type: 'event', name: 'skill.loaded', turn: 0, at: 400 },

  { type: 'step', phase: 'analyze', intent: '检查文件，再抽取正文与内嵌图片', turn: 1, at: 1100 },
  { type: 'thinking', turn: 1, delta: '目标 HTML 约 2.9MB，先确认大小与 Python 可用性，再跑抽取脚本。' },
  { type: 'tool_start', tool: 'shell.run', turn: 1, at: 2000 },
  {
    type: 'tool_done', tool: 'shell.run', ok: true, turn: 1, at: 2130,
    drilldown: {
      argsPreview: '$f = Get-Item "…\\workbuddy_article_standalone.html"; "{0:N0} bytes" -f $f.Length',
      resultPreview: '2,906,241 bytes',
    },
  },
  { type: 'text_delta', turn: 1, delta: '文件在，2.9MB。开始抽取正文与图片。' },

  { type: 'step', phase: 'tool', intent: '正在抽取正文与内嵌图片……', tool: 'shell.run', turn: 2, at: 2600 },
  { type: 'tool_start', tool: 'shell.run', turn: 2, at: 2600 },
  {
    type: 'tool_done', tool: 'shell.run', ok: false, turn: 2, at: 122_600,
    drilldown: {
      argsPreview: "python - <<'EOF'\nimport re, base64, pathlib\nhtml = pathlib.Path('workbuddy_article_standalone.html').read_text(encoding='utf-8')\nimgs = re.findall(r'data:image/(png|jpe?g);base64,([A-Za-z0-9+/=]+)', html)\n…\nEOF",
      resultPreview: '（stdout 为空）',
      exitText: 'Exit code 143 · Command timed out after 2m 0s',
      bytes: 0,
    },
  },
  {
    type: 'error', at: 122_700,
    message: 'tool.call.failed · shell.run 超时（2m0s）· 正则回溯疑似灾难性 · run 7K2MD8',
    provider: 'sandbox',
    turn: 2,
    retryable: true,
    consumedTokens: 926,
  },
];

/* ---------------- 等待审批(含受限视角 L3) ---------------- */

export const framesAwaiting: Frame[] = [
  { type: 'event', name: 'run.created', turn: 0, at: 100 },
  { type: 'step', phase: 'analyze', intent: '核对单据，先建报销草稿', turn: 1, at: 900 },
  { type: 'thinking', turn: 1, delta: '发票三张，金额合计与行程单一致；按差旅类目建草稿，提交前须过人工审批门。' },
  { type: 'tool_start', tool: 'erp.create_draft', turn: 1, at: 2100 },
  {
    type: 'tool_done', tool: 'erp.create_draft', ok: true, turn: 1, at: 3400,
    drilldown: {
      restricted: true,
      resultPreview: '草稿 EXP-0712 已创建 · 金额 ¥ **,***.**（已脱敏） · 3 张发票关联',
    },
  },
  {
    type: 'awaiting_approval', turn: 1, at: 3600,
    reason: '提交前需要您确认',
    detail: { 单据: 'EXP-0712', 金额: '¥3,180.00', 事由: '客户拜访差旅 · 6/28-6/30', 风险: '低' },
  },
];

export const TOOL_LABELS_DEMO = {
  'plan.update': '更新任务计划',
  'chat.emit_page': '生成网页产物',
  'shell.run': '执行命令',
  'erp.create_draft': '创建报销草稿',
};

/* ---------------- 沙箱画布示例产物(多类型 + 文件夹) ---------------- */

import type { SandboxFile } from '../components/agent/ArtifactSandbox';

export const sandboxFilesDemo: SandboxFile[] = [
  {
    id: 'f1',
    path: '团队协作金句页.html',
    kind: 'html',
    content: [
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>',
      'body{margin:0;display:grid;place-items:center;min-height:100vh;background:linear-gradient(180deg,#F9F8F4,#F6F5F0);font-family:"Noto Serif SC",serif;color:#232328}',
      'blockquote{margin:0;padding:0 24px 0 42px;border-left:2px solid #CBBB8E;font-size:26px;line-height:1.9;max-width:20em}',
      'p{font-family:system-ui,sans-serif;font-size:12px;color:#A3A3A8;text-align:center}',
      '</style></head><body><main><blockquote>“走得快靠一个人的冲刺，走得远靠一群人的节奏。”<p>Anna · 团队协作金句</p></blockquote></main></body></html>',
    ].join(''),
  },
  {
    id: 'f2',
    path: '说明/README.md',
    kind: 'markdown',
    content: [
      '# 团队协作金句页',
      '',
      '本产物由 **chat.emit_page** 生成，run `9F3KE2`。',
      '',
      '## 内容',
      '- 金句一条（衬线大字 + 金线滚边）',
      '- 单屏居中排版，浅色瓷底',
      '',
      '## 使用',
      '在画布预览，或“存入产物中心”后分发。详见 [产物中心](#)。',
      '',
      '```',
      'artifact: page · 18,432 bytes · sandbox: no-script / no-network',
      '```',
    ].join('\n'),
  },
  {
    id: 'f3',
    path: 'extract/extract_images.py',
    kind: 'code',
    language: 'py',
    content: [
      'import re, base64, pathlib',
      '',
      'html = pathlib.Path("workbuddy_article_standalone.html").read_text(encoding="utf-8")',
      '# 注意：超大文件上这条正则可能灾难性回溯（exit 143 的教训）',
      'imgs = re.findall(r"data:image/(png|jpe?g);base64,([A-Za-z0-9+/=]+)", html)',
      '',
      'out = pathlib.Path("extracted"); out.mkdir(exist_ok=True)',
      'for i, (ext, data) in enumerate(imgs):',
      '    (out / f"img_{i:03d}.{ext}").write_bytes(base64.b64decode(data))',
      'print(f"extracted {len(imgs)} images")',
    ].join('\n'),
  },
  {
    id: 'f4',
    path: 'extract/notes.txt',
    kind: 'text',
    content: '改进方案：放弃整段正则，按 <img 标签流式切割再逐段解码；\n超过 1MB 的 base64 段落先落盘再解码，避免峰值内存。\n（此文件为运行留档，原文未经改写）',
  },
];

/** truncated 凭证懒加载演示(真实实现:按 stepId 拉后端全文,已脱敏) */
export function loadFullDemo(): Promise<string> {
  return new Promise((resolve) =>
    setTimeout(
      () =>
        resolve(
          '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>团队协作金句页</title></head><body><main style="display:grid;place-items:center;min-height:100vh"><blockquote>走得快靠一个人的冲刺，走得远靠一群人的节奏。</blockquote></main></body></html>\n（全文 18,432 bytes · 已从后端拉取）',
        ),
      700,
    ),
  );
}
