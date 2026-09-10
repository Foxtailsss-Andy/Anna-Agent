# WB-02 公共读取切片交接胶囊

状态：公共搜索/URL读取切片的D/O契约、独立两轴、主控完整回归与AC-18b增量已验收；代码和公开证据已精确提交。整WB-02保持in_progress，下一主控继续文件与固定业务能力。

## 范围与现场

- scope：M0 + M1；ticket：WB-02；slice：公共搜索与受控URL正文读取。
- 实施owner_task_id：`01a08bb4-50a8-7ad0-9e6e-0af0ce5e3938`。唯一owner/交接HEAD以STATUS为准。
- 唯一工作树：`Anna-Workbench-Plan-20260907`；branch：`codex/workbench-plan-20260907`。所有命令必须显式workdir指向此树；外层Anna只是项目容器。
- 固定点：`e3e95621abbb15b66767e7b4bd9a6b2b3db7a9d4`。代码/证据提交：`10cc1e799b9b88b4e9c4e9d1878aa78918ace20e`。
- Spec1.2；R-01/04/05/15，AC-01/04/05/15公共读取部分及AC-18b；不关闭整AC-05或WB-02。
- 原AGENTS/CONTEXT/docs/agents/AWB规划保护；12项输入（除STATUS）未变。原tracked dirty SHA256：`5a5a75dad632d126dad8073c8548b44508804e4329dc52d54696697da6c4611b`。
- 具体决策见[契约](WB-02-public-contract.md)，独立审查、失败及日志例外见[审查](WB-02-public-review.md)。旧核心A/Skill文档及正式证据保持。

## 实现与证据边界

复用已有web_search Provider，v2公共目录不再受旧默认Skill工具表求交限制；显式Skill限制仍收窄授权。可信Host登记endpoint和配置，renderer/model不能提交网络策略或凭据。搜索拒绝redirect，非成功取消未消费body；JSON流上限1MiB，结果最多5条时显式truncated，严格校验来源并记录fetched_at，published_at只保留实际来源值。

新增Host web_read，parse5 exact8.0.1用于HTML解析。受管OMP Worker保持禁直接网络；没有接入上游完整fetch转换框架。只接公共HTTP(S)标准端口、无userinfo，每跳验证全部DNS答案并绑定实际socket。拒绝私网及保留地址。请求不携带业务凭据，默认identity编码；支持UTF8 HTML/plain正文，1,000,000来源bytes、每页最大20,000字符，safe integer offset。返回title或明确缺失、来源发布时间、fetched_at、正文hash、分页与source_truncated。合法UTF8在cap边界只保留完整前缀，内部非法编码仍失败。

v2模型工具定义来自持久catalog，同名静态定义不能抢先；v1兼容保留。新能力未改变内核/Worker/protocol或初始化顺序。

D/O代表测试通过真实Workbench Session/Run、Python身份/scope、Host/Gateway/EventStore和当前OMP进程；模型/搜索HTTP/公共页面响应为明确fixture。实际搜索观察决定直接结束或继续URL及分页；失败参数、未配置和权限拒绝后可继续。chat/create/crew与有/无Project六组合均搜索成功；网页自称新权限仍被既有Gateway拒绝。

网络D用例经过真实URL/地址策略、解析和分页；native request桥消费生产lookup(all)并产生真实IncomingMessage。上游保持打开，cap/取消在cleanup前出现peer close。它不代表fixture地址对应的真实网站已访问。

公开receipt每Run一份，只保留run_id、dispatch的seq/name及response的event_id/seq/status；不伪造ToolCallId或将正文强行关联。终态与参数/内容断言由对应测试及源hash约束，receipt不是完整Trace导出。预期失败记录保留。

## 冻结、审查和检查

r2 scope为本地 `.tmp-tests/wb02-public/supervisor/product-review-r2/scope.json`；12文件patch159695bytes，SHA256 `117634b27f90e6b1b2d550cdf524025d78e7f2da7b3e325518db86acaf80af30`。两位fresh Astra初末重建实际diff与12hash一致，Standards0、Spec遗漏/越界/错误0/0/0。

所有检查使用排他wrapper；真实stdout/stderr、command/cwd、源码before/after、exit记录在 `.tmp-tests/wb02-public/supervisor/checks/`，没有覆盖失败。

| 主控检查 | 结果 |
| --- | --- |
| issue-public-r2-focused-001 | 4文件48项通过 |
| issue-public-r2-typecheck-001 | 全仓类型检查通过 |
| issue-public-r2-cli-guards-001 | 12项通过 |
| issue-public-r2-python-001 | 1085项通过 |
| issue-public-r2-web-build-001 / host-build-001 | Web与Host构建通过 |
| issue-public-r2-release-scan-001 | 公开扫描通过 |
| issue-public-r2-full-js-001 | 1229通过 / 7跳过 / 0失败；781.01秒 |
| issue-public-increment-r1 | wb02-public-20260911-r1：51TS + 5Python通过；177.02秒 |

上述检查sourceChanged=false。issue-public-r2-check-ledger-001独立核对七组完整argv/cwd/exit、日志hash和12文件before/after/current均与r2冻结一致。正式轮[证据目录](../../../../evals/workbench/wb02/runs/wb02-public-20260911-r1/evidence/increment-result.json)保存54源hash；41条manifest全部核对，连manifest共42JSON。issue-public-round-verify-001及git-verify-001分别核对当前字节、真实私有命令/输出与代码提交Git blob；54源和12审查hash全部一致，12公共Run/45响应/5预期失败完整。正式轮记录的是当时base SHA与dirty候选，源码hash对应代码提交，不改写旧轮。

## 运行包、现场限制与历史例外

Node24.12.0、Python3.12.13；本树先前npm ci/uv sync已完成。OMP18.0.11/Bun1.3.14 materialize包的21465文件、worker/protocol/runtime lock再次逐项核对一致；manifest `sha256:168da57a60493b094ea6b2525f312c3e05a6585ffc167cba2a7b9c5beb6719ec`，manifest文件SHA `3a78ef5da9aa194186fdde8324633928a7d37f2a07ea4f6be64c9cb927fe0def`。根parse5依赖改变不代表OMP runtime lock变化。

最终reader默认公网probe使用23个核对过的编译输入，bundle SHA `ebdabccc31d7c47d5ae9a3877381f1fb2a910c3ecc54042bc2c9f901d2ddd8e8`。实际example.com读取被web_read_destination_not_public拒绝；系统DNS再次返回1个属于198.18.0.0/15 benchmark的IPv4答案。成功公网读取仍blocked；不放宽策略、不改DNS或代理，不能据fixture宣称联网成功。

L/M blocked，P not_run，usage unavailable。WB00 r5 / wb00-dataset-v1.1的36槽保持21blocked/15not_run，CLI基线校验通过；不以增量门禁替代最终36槽放行。

历史Worker readiness超时根因仍未知。旧CLI六次外层raw缺失及另一次未包裹诊断继续保留；后续通过不恢复旧字节。本轮CLI 2秒窗口失败以受控2.5秒延迟RED和10秒观察窗口GREEN修复，旧失败保留。A/B/D早期fixture错误、被拒绝的helper测试和普通修改误称mutation均在审查记录区分；当前有真实mutation1/恢复0。搜索receipt审计首次错误路径空目录不算通过，后续在真实生成路径独立核对12Run/45响应/5预期失败。

## 下一主控动作

1. 当前owner转交前只读STATUS；核对同树HEAD/branch、代码/正式证据hash、原12保护输入和运行包，再接管。不得自改owner或提前派工。
2. 继续WB-02剩余R-05：可信resource_refs/工作目录、目录或内容搜索、分段文件读取，以及固定Hiker/报销/剩余Crew读取。先查已有执行器和可信解析入口，从公共seam写可失败行为，fresh Luna xhigh逐条实现；不能让renderer任意path/workdir扩权，不预做WB-06。
3. 新源/资源/必需测试纳入CLI前后hash和独立缺失门禁；保留失败，D/O与L/M/P分开。每个独立slice冻结、fresh Astra双轴、主控完整验证后接力。整WB-02完成前不进入WB-03。
4. 用户已授权M0+M1内部推进，后续WB-03/04按依赖接续；WB-05～09、Memory/Sandbox扩展、push/PR/发布不在范围。用户暂停立即停止，不能以接力绕过。

所有Coding/Reviewer与测试进程已drain；运行包、源、manifest/receipt及公开候选扫描通过。54个owned代码/JSON路径已提交；本三份交接文档单独提交，交接HEAD和唯一owner转交记录以STATUS为准。旧主控转交后停止派工和仓库写入。
