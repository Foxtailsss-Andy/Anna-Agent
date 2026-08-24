/**
 * templates · 场景层模板库 v1(Home 合并轮 M2 · V2 H-03)
 *
 * 语义:一级场景 chip → 二级模板面板(3-5 条)→ 点选把带【占位符】的提示词填入输入区
 * (纯文本填充,可改可删可只用一半;WorkBuddy 式填空 × Claude 式二级列表)。
 * Create 场景 chip 额外绑定 kind 真参数(点选同步落 tag)。
 * 纪律:前端静态表(产品文案,非假数据);不接假搜索;每 kind 3-5 条。
 * 「做个网页」四条 = V2 稿原文;其余按同一口吻成文。
 */

import type { CreateDraftKind } from "../../lib/api/create";

export interface SceneTemplate {
  name: string;
  text: string;
}

export interface Scene {
  id: string;
  label: string;
  /** Create 场景绑定的 kind 真参数(Chat 场景无) */
  kind?: CreateDraftKind;
  templates: SceneTemplate[];
}

export const CHAT_SCENES: Scene[] = [
  {
    id: "web",
    label: "做个网页",
    templates: [
      { name: "产品落地页", text: "帮我做一个【产品名】的落地页，突出【核心卖点】，附【行动号召】" },
      { name: "活动报名页", text: "为【活动名】做报名页：时间【日期】、地点【地点】、亮点【三条】" },
      { name: "数据展示页", text: "把【数据主题】做成单页展示，包含【关键指标】与【图表类型】" },
      { name: "团队介绍页", text: "为【团队名】做介绍页：定位【一句话】、成员【人数】、风格【气质】" },
    ],
  },
  {
    id: "doc",
    label: "写产品文档",
    templates: [
      { name: "需求说明", text: "帮我写【功能名】的需求说明：背景【一句话】、目标用户【谁】、验收标准【三条】" },
      { name: "版本发布说明", text: "为【产品名】【版本号】写发布说明：新增【要点】、修复【要点】、已知问题【有无】" },
      { name: "使用指南", text: "写一份【功能名】使用指南：适用场景【场景】、步骤【几步】、常见问题【两条】" },
    ],
  },
  {
    id: "data",
    label: "数据分析",
    templates: [
      { name: "经营月报解读", text: "帮我分析【期间】的经营数据：重点看【指标】，对比【上期、同期】，给出【三条】结论" },
      { name: "费用结构分析", text: "分析【期间】的费用结构：按【维度】拆分，找出异常项并解释原因" },
      { name: "趋势判断", text: "基于【数据主题】近【N 期】的走势，判断趋势并给出【风险、机会】提示" },
    ],
  },
  {
    id: "minutes",
    label: "会议纪要",
    templates: [
      { name: "速记转纪要", text: "把这段速记整理成结构化纪要：【粘贴速记】，输出议题、结论、待办（责任人+期限）" },
      { name: "周会纪要", text: "整理【日期】周会纪要：参会【人】、进展【要点】、风险【有无】、下周计划【要点】" },
      { name: "决策备忘", text: "为【议题】写决策备忘：背景【一句话】、选项【几个】、最终决定【什么】、理由【一句话】" },
    ],
  },
];

export const CREATE_SCENES: Scene[] = [
  {
    id: "skill",
    label: "建技能",
    kind: "skill",
    templates: [
      { name: "客户跟进邮件", text: "帮我建“客户跟进邮件”技能：拜访纪要进、跟进邮件出，语气用【模板、风格】" },
      { name: "周报生成", text: "建一个“周报生成”技能：输入【本周要点】，按【格式】输出周报，收尾附下周计划" },
      { name: "文档规范化", text: "建“文档规范化”技能：把【类型】文档按【规范】重排，保留原意不增删事实" },
    ],
  },
  {
    id: "prompt",
    label: "写提示词",
    kind: "prompt",
    templates: [
      { name: "角色提示词", text: "写一个【角色】提示词：职责【做什么】、口吻【风格】、边界【不做什么】" },
      { name: "改写提示词", text: "写一个改写提示词：把【输入类型】改写为【目标风格】，保留【要素】" },
      { name: "审校提示词", text: "写一个审校提示词：检查【文本类型】的【错误类型】，输出问题清单+修改建议" },
    ],
  },
  {
    id: "tool",
    label: "做工具",
    kind: "python_tool",
    templates: [
      { name: "数据清洗工具", text: "做一个数据清洗工具：输入【格式】数据，按【规则】清洗，输出【格式】" },
      { name: "文件批处理", text: "做一个文件批处理工具：对【文件类型】批量【操作】，结果存到【位置】" },
      { name: "格式转换器", text: "做一个格式转换工具：【源格式】转【目标格式】，保留【要素】，异常时【处理方式】" },
    ],
  },
];

export function scenesOf(mode: "chat" | "create"): Scene[] {
  return mode === "chat" ? CHAT_SCENES : CREATE_SCENES;
}

/** 占位符 = 全真文本「【…】」。返回自 from 起第一个占位符的 [start,end)(含括号),无则 null。 */
export function placeholderRange(
  text: string,
  from = 0,
): { start: number; end: number } | null {
  const start = text.indexOf("【", from);
  if (start === -1) return null;
  const close = text.indexOf("】", start + 1);
  if (close === -1) return null;
  return { start, end: close + 1 };
}

/** Tab 跳转:from 之后的下一个占位符;到尾则从头回绕;全无则 null。 */
export function nextPlaceholder(
  text: string,
  from: number,
): { start: number; end: number } | null {
  return placeholderRange(text, from) ?? placeholderRange(text, 0);
}
