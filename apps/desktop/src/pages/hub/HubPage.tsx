/**
 * HubPage · 产物中心(R7)
 *
 * 数据源 = v2 durable Create projection list(无 sidecar 时回落 Legacy listDrafts);产物是一等公民。
 * 来源过滤:all / create 真(当前全部产物均来自 Create),chat / code 虚线站位
 *   (设计定死;chat 产物中心化待 B3 产物索引)。
 * 分组:按状态(已激活 / 草稿 / 其他),PetalDivider 分隔(计入点缀名额,组间放置 → ≤2)。
 * HubCard 动作 = ShellBus 真导航:「在 Chat 使用」/「引用到对话」预填真内容后跳 Chat。
 */

import { useCallback, useEffect, useState } from "react";

import { PetalDivider } from "../../components/anna/IrisPetal";
import { StateNote } from "../../components/anna/StateNote";
import { useShellBus } from "../../components/shell/AnnaShell";
import { HubCard, HubGrid, SourceFilter } from "../../components/surfaces/SurfaceKit";
import { listDrafts } from "../../lib/api/create";
import { getIdentity } from "../../lib/api/identity";
import { listHarnessV2CreateRuns, type HarnessV2CreateRunRecord } from "../../lib/api/harnessV2";
import { v2ApiBase } from "../../lib/runtime";
import { groupHubItems, hubItems, quotePrefill, useInChatPrefill } from "../create/draftView";
import "./HubPage.css";

type Rec = Record<string, unknown>;

function createListRecord(run: HarnessV2CreateRunRecord): Rec {
  return {
    id: run.runId,
    prompt: run.prompt,
    kind: typeof run.artifact?.kind === "string" ? run.artifact.kind : "skill",
    status: run.status,
    ...(run.artifact === undefined ? {} : { artifact: run.artifact }),
    ...(run.validation === undefined ? {} : { validation: run.validation }),
    ...(run.error === undefined
      ? {}
      : { error_code: run.error.code, error_message: run.error.message }),
  };
}

const SOURCE_OPTIONS = [
  { id: "all", label: "全部" },
  { id: "create", label: "Create" },
  { id: "chat", label: "Chat", stub: true },
  { id: "code", label: "Code", stub: true },
];

export function HubPage() {
  const shellBus = useShellBus();
  const [runs, setRuns] = useState<Rec[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState("all");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const runsPromise: Promise<Rec[]> = v2ApiBase() === ""
      ? listDrafts().then((r) => r as Rec[])
      : getIdentity()
        .then((identity) => listHarnessV2CreateRuns({
          channelId: `desktop-home:${identity.workspaceId}`,
        }))
        .then(({ runs }) => runs.map(createListRecord));
    runsPromise
      .then((r) => setRuns(r))
      .catch((e) => {
        setRuns(null);
        setError(String(e));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // all / create 皆呈现 Create 数据(现全部产物来自 Create;chat/code 为站位)
  const items = hubItems(runs ?? []);
  const groups = groupHubItems(items);

  return (
    <div className="ir-hub">
      <div className="ir-hub__scroll">
        <div className="ir-hub__col">
          <div className="ir-hub__head">
            <div>
              <div className="ir-hub__eyebrow">HUB</div>
              <div className="ir-hub__title">产物中心</div>
            </div>
            <button type="button" className="ir-hub__refresh" onClick={load} disabled={loading}>
              刷新
            </button>
          </div>

          <SourceFilter options={SOURCE_OPTIONS} activeId={source} onActivate={setSource} />

          {loading ? (
            <StateNote kind="loading" text="正在装载产物" />
          ) : error ? (
            <StateNote kind="error" text={error} />
          ) : items.length === 0 ? (
            <StateNote kind="empty" petal text="产物将在此陈列；先去 Create 构建一件" />
          ) : (
            groups.map((group, gi) => (
              <div key={group.key} className="ir-hub__group">
                {gi > 0 && <PetalDivider />}
                <div className="ir-hub__group-head">
                  {group.label}
                  <span className="ir-hub__group-count">{group.items.length}</span>
                </div>
                <HubGrid>
                  {group.items.map((item, ii) => (
                    <HubCard
                      key={`${item.runId}-${ii}`}
                      name={item.name}
                      metaText={item.metaText}
                      sourceText={item.sourceText}
                      onUseInChat={() => shellBus.prefillChat(useInChatPrefill(item))}
                      onQuote={() => shellBus.prefillChat(quotePrefill(item))}
                    />
                  ))}
                </HubGrid>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default HubPage;
