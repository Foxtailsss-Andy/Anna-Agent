/**
 * 预览页 App(仅供对照验收;生产接入见 README)
 * 覆盖:四态 × 三级下钻 × L3 三种数据形态 × 窄容器降级 × 状态语法五态 × 深浅双主题 × 拟人层开关
 */

import { useMemo, useState } from 'react';
import { reduceTurns } from '../src/lib/turns';
import { planProgress } from '../src/lib/plan';
import { LoopCard } from '../src/components/agent/LoopCard';
import { AgentSessionHeader } from '../src/components/agent/AgentSessionHeader';
import { AgentComposer } from '../src/components/agent/AgentComposer';
import { PlanRail } from '../src/components/agent/PlanRail';
import { ArtifactCard } from '../src/components/agent/ArtifactCard';
import { ArtifactSandbox } from '../src/components/agent/ArtifactSandbox';
import { ApprovalCard } from '../src/components/agent/ApprovalCard';
import {
  AlertBand, AskChip, ChartCard, InsightCard, KpiCard, MetricBar, ProvenanceLine, ReadingFold, TrendChart,
} from '../src/components/cowork/DashboardKit';
import {
  CreateHero, DraftLedger, HubCard, HubGrid, SegmentedControl, SettingsCard, SourceFilter, Switch, WorkshopTabs,
} from '../src/components/surfaces/SurfaceKit';
import { PetalDivider } from '../src/components/anna/IrisPetal';
import { StateNote } from '../src/components/anna/StateNote';
import { IrisPetal } from '../src/components/anna/IrisPetal';
import {
  framesAwaiting, framesDone, framesFailed, framesRunning, loadFullDemo, sandboxFilesDemo, TOOL_LABELS_DEMO,
} from '../src/fixtures/demo-run';

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section id={id} style={{ margin: '0 0 44px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '0 0 4px' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.18em', color: 'var(--iris)', fontWeight: 500 }}>{id.toUpperCase()}</span>
        <h2 style={{ font: '600 16px var(--font-sans)', color: 'var(--ink)', margin: 0 }}>{title}</h2>
      </div>
      {note && <p style={{ font: '300 12px/1.8 var(--font-sans)', color: 'var(--ink-2)', margin: '0 0 14px', maxWidth: '76ch' }}>{note}</p>}
      {children}
    </section>
  );
}

export default function App() {
  const [dark, setDark] = useState(false);
  const [persona, setPersona] = useState(true);
  const [draft, setDraft] = useState('');
  const [sbxOpen, setSbxOpen] = useState(false);
  const [sbxActive, setSbxActive] = useState('f1');
  const [wsTab, setWsTab] = useState('draft');
  const [hubFilter, setHubFilter] = useState('all');
  const [devMode, setDevMode] = useState(false);
  const [createDraft, setCreateDraft] = useState('');

  const running = useMemo(() => reduceTurns(framesRunning, TOOL_LABELS_DEMO), []);
  const done = useMemo(() => reduceTurns(framesDone, TOOL_LABELS_DEMO), []);
  const failed = useMemo(() => reduceTurns(framesFailed, TOOL_LABELS_DEMO), []);
  const awaiting = useMemo(() => reduceTurns(framesAwaiting, TOOL_LABELS_DEMO), []);

  const toggleTheme = (v: boolean) => {
    setDark(v);
    document.documentElement.setAttribute('data-theme', v ? 'dark' : 'light');
  };

  const col: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 820 };

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(180deg, var(--bg-grad-top), var(--bg-grad-bottom))', color: 'var(--ink)', fontFamily: 'var(--font-sans)' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '40px 36px 100px' }}>

        <header style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 36 }}>
          <span style={{ fontFamily: 'var(--font-serif)', fontSize: 22, fontWeight: 600 }}>Anna</span>
          <IrisPetal size={16} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '0.18em', color: 'var(--ink-3)' }}>
            RUNTIME · 三级下钻 · P1 组件对照预览
          </span>
          <span style={{ flex: 1 }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink-2)', cursor: 'pointer' }}>
            <input type="checkbox" checked={persona} onChange={(e) => setPersona(e.target.checked)} />
            拟人层(flavor,可关)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink-2)', cursor: 'pointer' }}>
            <input type="checkbox" checked={dark} onChange={(e) => toggleTheme(e.target.checked)} />
            深色
          </label>
        </header>

        <Section
          id="s1" title="运行中(流式)· L1 当前回合自动展开"
          note="呼吸点 + 当下行微光(engine step.intent 原文)= 全屏唯二动效;已完成回合自动折叠成一行;工具步可掀 L3(args/result 素颜);系统步无 L3 → 无箭头。右栏 PlanRail 由 plan.updated 权威帧驱动。"
        >
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
            <div style={{ ...col, flex: 1 }}>
              <AgentSessionHeader statusText="正在为您办理 · 00:26" />
              <LoopCard
                state="running"
                nowIntent={running.nowIntent}
                elapsedText="00:26"
                turns={running.turns}
                plan={planProgress(running.plan)}
                usageText="deepseek-chat · ~1,204 tokens"
                persona={persona}
              />
              <AgentComposer
                value={draft} onChange={setDraft} onSend={() => setDraft('')}
                running onStop={() => {}}
                permission="default" ctxPercent={34} modelTier="default"
              />
            </div>
            <div style={{ width: 300, flex: 'none' }}>
              <PlanRail progress={planProgress(running.plan)} />
            </div>
          </div>
        </Section>

        <Section
          id="s2" title="完成 · 礼成条收拢(320ms)+ ▸ 回看 + truncated 懒加载"
          note="整卡收拢为礼成单行(金线滚边 + 「安」印);回看重开全部回合(青瓷书脊,动效全停)。「生成网页产物」步的 L3 为 truncated 形态:预览 + 展开更多(700ms 模拟拉取)。"
        >
          <div style={col}>
            <AgentSessionHeader statusText="已办妥" />
            <LoopCard
              state="done"
              turns={done.turns}
              plan={planProgress(done.plan)}
              persona={persona}
              onLoadFull={loadFullDemo}
              ceremony={{ momentCount: done.turns.reduce((n, t) => n + t.steps.length, 0), planText: '计划 3/3', usageText: '~1,842 tokens · 00:34.2' }}
            />
          </div>
        </Section>

        <Section
          id="s2b" title="沙箱画布 Sandbox · 点产物 → 右侧挤压式自动展开(240ms)"
          note="对齐常规 Coding Agent 手感:产物 tab(激活 iris tinted)· 文件夹树可开合 · 在线预览 HTML(沙箱 iframe,无脚本/无外联)/ Markdown / 代码(mono+行号)/ 纯文本。「存入产物中心」为虚线站位。点下方产物卡试试。"
        >
          <div style={{ display: 'flex', height: 560, border: '1px solid var(--line)', borderRadius: 16, overflow: 'hidden', background: 'linear-gradient(180deg, var(--bg-grad-top), var(--bg-grad-bottom))' }}>
            <div style={{ flex: 1, minWidth: 0, padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <AgentSessionHeader statusText="已办妥" />
              <p style={{ font: '400 14px/1.9 var(--font-sans)', color: 'var(--ink)', maxWidth: '68ch', margin: 0 }}>
                都办妥了。展示页与运行留档一并呈上,请您过目。
              </p>
              <ArtifactCard
                name="团队协作金句页"
                metaText="网页产物 · 刚刚生成 · run 9F3KE2 · 含 4 个文件"
                onOpen={() => { setSbxActive('f1'); setSbxOpen(true); }}
              />
              {!sbxOpen && (
                <span style={{ fontSize: 11.5, color: 'var(--ink-3)', fontWeight: 300 }}>点击产物卡,画布将在右侧自动展开</span>
              )}
            </div>
            <ArtifactSandbox
              open={sbxOpen}
              files={sandboxFilesDemo}
              activeId={sbxActive}
              onActivate={setSbxActive}
              onClose={() => setSbxOpen(false)}
              width={470}
            />
          </div>
        </Section>

        <Section
          id="s3" title="失败 · 书脊胭脂 + 失败步默认掀到 L3 留证 + 动效全停"
          note="真命令原文(PowerShell / python heredoc)+ 真 stdout + exit 143 = 素颜凭证,persona 一个字不许改写;致歉与归因在卡外由前端按 error 类型映射。已产生消耗如实展示。"
        >
          <div style={col}>
            <AgentSessionHeader statusText="这一步没有办成" tone="error" />
            <LoopCard
              state="error"
              nowIntent="抽取正文与内嵌图片,未能完成"
              elapsedText="02:02"
              turns={failed.turns}
              persona={persona}
              failure={{ consumedText: '已消耗 ~926 tokens', onResume: () => {}, onAudit: () => {}, onCopyError: () => {} }}
            />
            <p style={{ font: '400 14px/1.8 var(--font-sans)', color: 'var(--ink-2)', maxWidth: '68ch', margin: 0 }}>
              抱歉,这一步没有办成——是命令执行超时,并非您的任务有误。此前的检查结果均已妥善保存,点「从断点续办」即可继续,不必重来。
            </p>
          </div>
        </Section>

        <Section
          id="s4" title="等待审批(awaiting)· ⏳ + 琥珀书脊 + 通用审批卡 + 受限视角 L3"
          note="审批卡(§6.4 W4 通用化)= LoopCard 暂停形态嵌在回合末端:字段逐项对账(mono)+ ▸ 原始 payload + 返回修改/确认提交。「创建报销草稿」的 L3 为受限形态(🔒 已脱敏摘要)。下方另附缺信息变体「请您补充」(number / date / file 站位)。"
        >
          <div style={col}>
            <AgentSessionHeader statusText="等您示下" />
            <LoopCard
              state="awaiting"
              nowIntent="提交前需要您确认"
              elapsedText="00:07"
              turns={awaiting.turns}
              persona={persona}
              approvalSlot={
                <div style={{ margin: '6px 0 8px 16px' }}>
                  <ApprovalCard
                    risk="low"
                    fields={[
                      { label: '单据', value: 'EXP-0712' },
                      { label: '金额', value: '¥3,180.00' },
                      { label: '事由', value: '客户拜访差旅 · 6/28-6/30', mono: false },
                    ]}
                    payloadText={JSON.stringify(awaiting.approval?.detail ?? {}, null, 2)}
                    onConfirm={() => {}}
                    onRevise={() => {}}
                  />
                </div>
              }
            />
            <div style={{ maxWidth: 620 }}>
              <ApprovalCard
                variant="supplement"
                supplementFields={[
                  { id: 'amount', label: '金额', type: 'number', placeholder: '0.00' },
                  { id: 'date', label: '发生日期', type: 'date' },
                  { id: 'file', label: '发票附件', type: 'file' },
                ]}
                onConfirm={() => {}}
                onRevise={() => {}}
                reviseLabel="稍后再说"
              />
            </div>
          </div>
        </Section>

        <Section
          id="s5" title="窄容器降级(420px 滑出副驾)"
          note="容器 < 560px 时自动:只显当下行 + 计划条,回合树折叠为「▸ 过程 N 个瞬间」。"
        >
          <div style={{ width: 420 }}>
            <LoopCard
              state="running"
              nowIntent={running.nowIntent}
              elapsedText="00:26"
              turns={running.turns}
              plan={planProgress(running.plan)}
              persona={persona}
            />
          </div>
        </Section>

        <Section
          id="s6" title="状态语法 · 七态中的 5 个非运行态"
          note="七态纪律:每个数据面 = 空 / 加载 / 运行中(流式) / 完成 / 失败 / 未连接 / 站位。运行中与完成/失败由 LoopCard 承担(见 S1-S3);其余五态统一用 StateNote,禁止裸 error_code 横幅、禁止假数据。"
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, maxWidth: 820 }}>
            <div style={{ background: 'linear-gradient(180deg, var(--surface), var(--surface-2))', border: '1px solid var(--line)', borderRadius: 16, padding: 8 }}>
              <StateNote kind="empty" text="产物将在此呈上;运行完成后自动打开" petal />
            </div>
            <div style={{ background: 'linear-gradient(180deg, var(--surface), var(--surface-2))', border: '1px solid var(--line)', borderRadius: 16, padding: 8 }}>
              <StateNote kind="loading" text="正在装载运行现场 · run 9F3KE2" />
            </div>
            <div style={{ background: 'linear-gradient(180deg, var(--surface), var(--surface-2))', border: '1px solid var(--line)', borderRadius: 16, padding: 8 }}>
              <StateNote kind="error" text="model.call.failed · 上游调用超时(30s)· provider deepseek" />
            </div>
            <div style={{ background: 'linear-gradient(180deg, var(--surface), var(--surface-2))', border: '1px solid var(--line)', borderRadius: 16, padding: 8 }}>
              <StateNote kind="offline" text="尚未连接 ERP · 接通后这里显示真实数据,不做演示数字" />
            </div>
            <div style={{ background: 'linear-gradient(180deg, var(--surface), var(--surface-2))', border: '1px solid var(--line)', borderRadius: 16, padding: 8 }}>
              <StateNote kind="stub" text="附件上传" />
            </div>
          </div>
        </Section>

        <Section id="s7" title="Composer · 非运行态(真控件形态)">
          <div style={{ maxWidth: 820 }}>
            <AgentComposer
              value={draft} onChange={setDraft} onSend={() => setDraft('')}
              permission="readonly" ctxPercent={86} modelTier="craft" tuneActive
            />
          </div>
        </Section>

        <Section
          id="s8" title="Cowork 看板 · 五段式(P3)"
          note="① 焦点警示带(琥珀书脊)→ ② KPI 带(Hero 鸢尾描边 = 全屏唯一强调卡)→ ③ 图表行(渐变收于透明)→ ④ 洞察/建议(追问 = iris tinted,接副驾注入问题)→ ⑤ Anna 解读可折叠。ProvenanceLine 必在;未连 ERP 整面走状态语法(最下方)。示例数据沿用设计稿 5c。"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 1100 }}>
            <div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.2em', color: 'var(--ink-3)' }}>COWORK · 财务经营看板</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
                <span style={{ fontFamily: 'var(--font-serif)', fontSize: 24, fontWeight: 600 }}>经营分析报告</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ink-2)', border: '1px solid var(--line-strong)', borderRadius: 999, padding: '3px 11px' }}>期间 2026-07</span>
              </div>
              <ProvenanceLine text="数据来源:ERP(只读)· 期间 2026-07 · 更新于 14:02 · 由代码计算,非模型生成" />
            </div>

            <AlertBand onAsk={() => {}}>逾期应收 <b>¥286,000</b>,前三客户占 74%</AlertBand>

            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1.3, minWidth: 0 }}>
                <KpiCard hero label="利润 · Hero" value="¥182.4万" deltaText="环比 ▲ 12%" deltaTone="ok" spark={[6, 10, 8, 15, 13, 20, 18, 25]} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}><KpiCard label="收入" value="¥906万" deltaText="环比 ▲ 4%" /></div>
              <div style={{ flex: 1, minWidth: 0 }}><KpiCard label="费用" value="¥241万" deltaText="环比 ▲ 9%" deltaTone="warn" /></div>
              <div style={{ flex: 1, minWidth: 0 }}><KpiCard label="经营现金流" value="¥97万" deltaText="环比 ▼ 3%" /></div>
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1.5, minWidth: 0, display: 'flex' }}>
                <ChartCard
                  title="经营趋势" metaText="近 6 期 · 收入 / 费用"
                  legend={[{ label: '收入', color: 'var(--iris)' }, { label: '费用', color: 'var(--gold)' }]}
                >
                  <TrendChart series={[
                    { label: '收入', color: 'var(--iris)', values: [74, 68, 92, 86, 114, 130], area: true },
                    { label: '费用', color: 'var(--gold)', values: [32, 38, 34, 44, 40, 52] },
                  ]} />
                </ChartCard>
              </div>
              <div style={{ flex: 1, minWidth: 0, display: 'flex' }}>
                <ChartCard title="应收账龄 · 重点" metaText="Top 3 客户">
                  <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 12, height: '100%' }}>
                    <MetricBar name="华东贸易" valueText="¥121,000 · 47 天" ratio={0.78} tone="warn" />
                    <MetricBar name="南方制造" valueText="¥64,000 · 38 天" ratio={0.46} />
                    <MetricBar name="启明科技" valueText="¥27,000 · 31 天" ratio={0.22} />
                  </div>
                </ChartCard>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <InsightCard title="经营洞察">市场费用环比 +38%,超出常态区间 <AskChip small onClick={() => {}} /></InsightCard>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <InsightCard title="建议动作">▸ 向 Anna 追问逾期应收明细(前三客户)</InsightCard>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <ReadingFold>
                  本期利润环比改善主要来自收入增长;需留意市场费用增速超过收入增速,以及逾期应收向头部客户集中的风险。
                </ReadingFold>
              </div>
            </div>

            <div style={{ background: 'linear-gradient(180deg, var(--surface), var(--surface-2))', border: '1px solid var(--line)', borderRadius: 16, padding: 8, maxWidth: 560 }}>
              <StateNote kind="offline" text="尚未连接 ERP · 看板将在接通后呈现真实数据,不做演示数字" />
            </div>
          </div>
        </Section>

        <Section
          id="s9" title="Create · hero + workshop(P4)"
          note="hero 态允许光晕 + 绽放鸢尾(空态层级);workshop 态回到素面秩序,五标签 = 1 真 + 4 虚线等 W9;draft 账本是全站唯一深色面板。"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1000 }}>
            <CreateHero subtitle="把您要的工具、页面或流程说给 Anna,她来搭。">
              <AgentComposer
                value={createDraft} onChange={setCreateDraft} onSend={() => setCreateDraft('')}
                placeholder="描述您要构建的东西…"
                footnote=""
              />
            </CreateHero>
            <WorkshopTabs
              activeId={wsTab} onActivate={setWsTab}
              tabs={[
                { id: 'draft', label: '草稿' },
                { id: 'files', label: '文件', stub: true },
                { id: 'terminal', label: '终端', stub: true },
                { id: 'diff', label: 'Diff', stub: true },
                { id: 'preview', label: '预览', stub: true },
              ]}
            />
            <DraftLedger lines={[
              'draft 9F3KE2 · 团队协作金句页 · v3',
              'skill: 通用对话 · tools: plan.update / chat.emit_page',
              'build 00:34.2 · ~1,842 tokens · artifacts 1',
              '──',
              '读回校验通过 · 已落库 · 可回看',
            ]} />
          </div>
        </Section>

        <Section
          id="s10" title="产物中心 · 网格卡 + 来源过滤(P4)"
          note="来源过滤:Create 真 / Chat·Code 虚线站位;网格卡 = §6.5 中心形态(名 + 类型·版本·状态 + 来源 + 「在 Chat 使用 / 引用到对话」);瓣饰分隔线用于分组(占点缀名额)。"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1000 }}>
            <SourceFilter
              activeId={hubFilter} onActivate={setHubFilter}
              options={[
                { id: 'all', label: '全部' },
                { id: 'create', label: 'Create' },
                { id: 'chat', label: 'Chat', stub: true },
                { id: 'code', label: 'Code', stub: true },
              ]}
            />
            <PetalDivider />
            <HubGrid>
              <HubCard name="团队协作金句页" metaText="网页 · v3 · 已定稿" sourceText="来源 Create · run 9F3KE2" onQuote={() => {}} onUseInChat={() => {}} />
              <HubCard name="Q3 费用结构备忘" metaText="文档 · v1 · 草稿" sourceText="来源 Create · run 7K2MD8" onQuote={() => {}} onUseInChat={() => {}} />
              <HubCard name="报销制度速查卡" metaText="文档 · v2 · 已定稿" sourceText="来源 Create · run 3B8QX1" onQuote={() => {}} onUseInChat={() => {}} />
            </HubGrid>
          </div>
        </Section>

        <Section
          id="s11" title="设置 · Boss 视角 5 卡 + 开发者模式分层(P4)"
          note="默认 Boss 视角 = 连接 / 模型档案 / 记忆(W6 站位)/ 外观(真开关)/ 关于;「开发者模式」开启后整屏接管运行时状态页(内容不删,只分层,D4 解法)。"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1000 }}>
            <div className="set-grid">
              <SettingsCard title="连接" statusChip="ERP · 只读 · 已连接" desc="数据源与权限边界;断开后看板进入未连接态,不做演示数字。" />
              <SettingsCard title="模型档案" statusChip="deepseek-chat" desc="档位 lite / default / craft 随 W2 开放;辅助小模型(标题、摘要)同批。" />
              <SettingsCard title="记忆" statusChip="即将上线" statusTone="stub" desc="W6:业务记忆命中将以系统步形式进入时间线,此处管理条目。" />
              <SettingsCard title="外观" desc="浅色主、深色补齐(非反相:瓷变墨、您的话语变纸)。">
                <SegmentedControl
                  value={dark ? 'dark' : 'light'}
                  onChange={(v) => toggleTheme(v === 'dark')}
                  options={[{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]}
                />
              </SettingsCard>
              <SettingsCard title="关于" desc="Anna · 鸢尾 Iris · 桌面版">
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ink-3)' }}>build 2026.07.09 · tokens v2 · spec V1.0</span>
              </SettingsCard>
            </div>
            <PetalDivider />
            <Switch
              checked={devMode} onChange={setDevMode}
              label="开发者模式"
              note={devMode ? '已开启 · 整屏接管运行时状态页(全部面板保留)' : '关闭 · Boss 视角只留 5 张卡'}
            />
            {devMode && (
              <DraftLedger heading="RUNTIME · 开发者视角(现 RuntimeStatusPage 全部面板在此接管)" lines={[
                'engine: QueryEngine · SSE ok · apiBase 由 __ANNA_RUNTIME__ 注入',
                'frames: step / thinking / tool_start / tool_done / event / plan.updated / awaiting_approval / done / error',
                'audit: 落库 ok · 脱敏在后端产出侧 · 下钻预览通道待 D8',
              ]} />
            )}
          </div>
        </Section>

      </div>
    </div>
  );
}
