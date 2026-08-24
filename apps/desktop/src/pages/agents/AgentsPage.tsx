/**
 * AgentsPage · Agent 中心(C1 · 校对基准 P-02 侧栏项)
 *
 * 薄页面:承载既有 AgentDirectivesPanel(五 Agent 附加指令,真读写 runtime config)。
 * 面板复用 DevTakeover 的 ir-dev__* 块样式(引其 CSS);数据密集面,零点缀。
 */

import { AgentDirectivesPanel } from "../settings/AgentDirectivesPanel";
import "../settings/DevTakeover.css";
import "./AgentsPage.css";

export function AgentsPage() {
  return (
    <div className="ir-agents">
      <div className="ir-agents__head">
        <div className="ir-agents__eyebrow">AGENTS · 指令中枢</div>
        <h1 className="ir-agents__title">Agent 中心</h1>
        <p className="ir-agents__sub">
          为每个域 Agent 追加 Boss 指令，保存后注入系统提示，下次 run 生效。
        </p>
      </div>
      <AgentDirectivesPanel />
    </div>
  );
}

export default AgentsPage;
