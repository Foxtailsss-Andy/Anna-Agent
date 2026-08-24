# Terminal-Bench 2.1 × Harbor —— Anna 接入实操报告

**日期**:2026-08-07
**分支**:`fix/pi-level-loop`
**协议**:`Desktop/Terminal-Bench 2.1 test code.md`(以下 §N 均指该文件章节)
**本轮范围**:§三(运行前检查)、§四(安装 Harbor)、§五(接入目标 Harness)、§六阶段1(Adapter 连通性检查,在无 Docker 的现实边界内跑到底)。
**不在范围**:阶段 2~5(冒烟 / 89 题全量 / 基线对照 / 重复实验)—— 被 Docker 硬阻塞,见 §7。

> 纪律声明:本报告所有版本号、命令、错误信息均为本机真实执行所得,未凭记忆填写。全文不含任何 API Key。
> `evals/terminal-bench/anna_agent.py` 不含任何 Terminal-Bench 专属逻辑、硬编码答案或按题分支;未读取、未向 Anna 提供任何 `solution/`(参考答案)内容。

---

## 1. §三 运行前检查 —— 环境清单

| 项 | 实测值 | 命令 / 来源 |
| --- | --- | --- |
| OS | Microsoft Windows 11 Pro,10.0.22631(build 22631) | `Get-CimInstance Win32_OperatingSystem` |
| CPU 架构 | AMD64 | `$env:PROCESSOR_ARCHITECTURE` |
| CPU | AMD EPYC 9T24 96-Core Processor;**2 物理核 / 4 逻辑核** | `Get-CimInstance Win32_Processor` |
| 内存 | **7.75 GB 总量**,空闲 3.16 GB | `Win32_ComputerSystem.TotalPhysicalMemory` |
| 磁盘 | C: 已用 63 GB / **空闲 16.9 GB**;G: 已用 432 GB / 空闲 28 GB | `Get-PSDrive -PSProvider FileSystem` |
| 机器类型 | **Alibaba Cloud ECS**(Windows 本身是 guest) | `Win32_ComputerSystem.Manufacturer/Model` |
| 嵌套虚拟化 | `HypervisorPresent=True`(因为自己就是 guest);**`VMMonitorModeExtensions=False`、`SecondLevelAddressTranslationExtensions=False`** | `Get-CimInstance Win32_Processor` |
| **Docker** | **未安装**(`docker` 不在 PATH) | `Get-Command docker` → NOT FOUND |
| **Docker daemon** | 不适用(未安装) | — |
| **WSL** | `wsl.exe` 存在,**零发行版**;`wsl --status` 报 “WSL2 is unable to start since virtualization is not enabled on this machine” | `wsl --list --quiet`(空)/ `wsl --status` |
| Python | 系统 3.14.5;**Anna venv 3.12.10**(`pyproject.toml` 钉 `>=3.12,<3.14`) | `python --version` / `.venv\Scripts\python.exe --version` |
| pip | 26.1.1 | `python -m pip --version` |
| **uv** | 检查时**未安装** → 本轮安装 **0.12.2** (46ead6098, 2026-08-05, x86_64-pc-windows-msvc) | `uv --version` |
| **Harbor** | 检查时未安装 → 本轮安装 **0.20.0** | `harbor --version` |
| Node / git | v24.16.0 / 2.54.0.windows.1 | `node --version` / `git --version` |
| **Harness(Anna)版本** | 基线 commit `d915d56`;本轮新增 `ef80c68`(headless 入口) | `git rev-parse --short HEAD` |
| **Harness 是否支持无界面 CLI** | **本轮之前:否**(仅 FastAPI + Electron)。本轮补上 `services/api/app/headless.py` → **是** | 见 §5 |
| **模型 API 是否可访问** | **否** —— 本机未配置任何模型端点 | headless 实跑返回 `model_not_configured` |
| **API Key 是否经环境变量提供** | **否**。`ANNA_MODEL_ENDPOINT` / `ANNA_MODEL_API_KEY` / `ANNA_MODEL_NAME` / `ANNA_ERP_MCP_SERVER` / `ANNA_ERP_MCP_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` **全部 unset**;`%APPDATA%\anna\runtime.json` 不存在 | 只探测**存在性**,从不打印值 |
| 模型 / 模型提供方 | **未定**(协议模板的 `<MODEL_ID>` / `<MODEL_PROVIDER>` 尚未由用户指定) | — |

### 与协议默认假设的差异及影响(§三末段要求记录)

协议默认假设 Linux + Docker + Python/uv。实测差异:

1. **OS = Windows,不是 Linux。** 对 Harbor 本身影响可控(Harbor 0.20.0 的 Windows CLI 正常工作,见 §2)。真正的影响在 Docker。
2. **Docker 完全缺席,且不是“装一下就好”。** 这台机器是**阿里云 ECS guest**,CPU 未向 guest 暴露 `VMMonitorModeExtensions` / SLAT ——
   **嵌套虚拟化不可用**,因此 WSL2 与 Hyper-V 都起不来,Docker Desktop 在本机**无法运行**。
   这不是一个“安装决策”,是**实例规格约束**。解法见 §7。
3. **磁盘 16.9 GB(C:)对 89 题全量偏紧。** TB2.1 每题一个独立 Docker 镜像(例:`pypi-server` 用 `alexgshaw/pypi-server:20251031`,题目声明 `storage_mb=10240`)。
   全量跑需要的镜像总量按经验是数十 GB 级。C: 剩余空间**不足以**支撑一次全量基线。
4. **2 核 / 7.75 GB 内存对并发不友好。** `harbor run` 默认 `-n 4` 并发;题目声明 `cpus=1, memory_mb=2048`,4 并发即 8 GB —— 超过本机物理内存。真跑必须 `-n 1`,并如实记录并发数(§四·阶段4 要求基线/优化版并发一致)。

---

## 2. §四 安装 Harbor —— 实际命令与结果

### uv(用户级,无需管理员)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
# downloading uv 0.12.2 (x86_64-pc-windows-msvc)
# installing to <user-local-bin>  →  uv.exe / uvx.exe / uvw.exe
$env:Path = "<user-local-bin>;$env:Path"
```

未走 pipx/pip 兜底 —— 官方 installer 一次成功。

### Harbor

```powershell
uv tool install harbor
# Resolved 83 packages / Installed 83 packages
# + harbor==0.20.0   (依赖含 litellm==1.95.0, openai==2.53.0, supabase==2.31.0, typer==0.27.1 …)
# Installed 3 executables: harbor, hb, hr
harbor --version   # 0.20.0
```

安装位置:`<uv-tools>/harbor`(工具 venv 的解释器:`...\harbor\Scripts\python.exe`)。

### CLI 与协议文档的差异(§四:以当前版本 `--help` 为准)

| 协议写法 | Harbor 0.20.0 实况 |
| --- | --- |
| `harbor dataset list` 应列出数据集 | **只打印一行网址**:`View registered datasets at https://hub.harborframework.com/datasets`。表格需 `harbor dataset list --legacy`,而 `--legacy` 走的是**旧 registry**,里面只有 `terminal-bench 2.0`(89 题),**没有 2.1** |
| `harbor run -d ... -a ... -m ...` | 参数名一致。`-a/--agent` **同时**接受内置名与自定义导入路径 `module.path:ClassName`(`--agent-import-path` 已废弃) |
| `--agent "path.to.agent:SomeAgent"` | 成立,见 §4 |

**内置 agent 名单**(`harbor run --help` 的 `-a` 枚举,逐字):`aider, antigravity-cli, claude-code, cline-cli, codex, computer-1, copilot-cli, cursor-cli, deerflow, devin, dspy-rlm, eve, gemini-cli, goose, grok-build, hermes, kimi-cli, langgraph, mimo, mini-swe-agent, nemo-agent, nop, openclaw, opencode, openhands, openhands-sdk, oracle, pi, qwen-coder, rovodev-cli, swe-agent, terminus, terminus-1, terminus-2, trae-agent, vibe, acp:<agent>`。

→ **Anna 不在内置名单里 ⇒ 走 §五「情况 B」,自定义 Adapter。**

### 数据集可用性:`terminal-bench/terminal-bench-2-1` —— **可用,已核实**

`harbor dataset list` 的两个视图都查不到它,因为 **org/name 形态的数据集走的是另一套 client**:
`-d` 的 `org/name` 被判为 *package* 数据集(`harbor/models/job/config.py:256`、`harbor/job.py:554`),由 `PackageDatasetClient`(`harbor/registry/client/package.py:14`)从 Harbor Hub 解析;
而 `harbor dataset list` 用的是 `RegistryClientFactory.create()` 默认的 `HarborRegistryClient`(旧 Supabase `dataset` 表,`harbor/registry/client/harbor/harbor.py:108`)—— 两者命名空间不同。

用 Harbor 自己的 client 直接解析(纯元数据,不需要 Docker):

```
PackageDatasetClient().get_dataset_metadata("terminal-bench/terminal-bench-2-1@latest")
→ name    : terminal-bench/terminal-bench-2-1
  version : sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a
  desc    : "Version 2.1 of Terminal-Bench, a benchmark for evaluating agents in terminal environments."
  n_tasks : 89
```

**89 题任务名(完整清单,按字典序)**:
`adaptive-rejection-sampler, bn-fit-modify, break-filter-js-from-html, build-cython-ext, build-pmars, build-pov-ray, caffe-cifar-10, cancel-async-tasks, chess-best-move, circuit-fibsqrt, cobol-modernization, code-from-image, compile-compcert, configure-git-webserver, constraints-scheduling, count-dataset-tokens, crack-7z-hash, custom-memory-heap-crash, db-wal-recovery, distribution-search, dna-assembly, dna-insert, extract-elf, extract-moves-from-video, feal-differential-cryptanalysis, …`
**完整 89 条 + 内容哈希已归档为 `evals/terminal-bench/tb21-tasks.json`**(阶段 2/3 的任务清单真值源;§四·阶段4 要求基线与优化版任务列表完全一致,以此文件为准)。

单题下载**在无 Docker 的情况下成功**,证明数据集通道打通:

```powershell
harbor download "terminal-bench/pypi-server" -o $env:TEMP\anna-tb-tasks --export
# Successfully downloaded 1 task(s)
# → pypi-server\{instruction.md, task.toml, environment\Dockerfile, tests\, solution\}
```

`task.toml` 实测字段(为 §三 资源估算与 §四·阶段4 的条件一致性提供依据):
`docker_image = "alexgshaw/pypi-server:20251031"`,`cpus = 1`,`memory_mb = 2048`,`storage_mb = 10240`,
`agent.timeout_sec = 900`,`verifier.timeout_sec = 900`,`environment.build_timeout_sec = 600`,`allow_internet = true`。

复现全量清单(不需要 Docker):

```powershell
& "$env:APPDATA\uv\tools\harbor\Scripts\python.exe" -c @"
import asyncio, json
from harbor.registry.client.package import PackageDatasetClient
async def m():
    md = await PackageDatasetClient().get_dataset_metadata('terminal-bench/terminal-bench-2-1@latest')
    print(json.dumps({'version': md.version, 'n': len(md.task_ids),
                      'tasks': sorted(t.name for t in md.task_ids)}, indent=1))
asyncio.run(m())
"@
```

---

## 3. Harbor Adapter 接口 —— 源码实测(不是凭记忆)

全部引用自本机安装的 `<uv-tools>/harbor/Lib/site-packages/harbor`。

### 3.1 `BaseAgent` — `harbor/agents/base.py:13`

```python
def __init__(self, logs_dir: Path, model_name: str | None = None,
             logger: logging.Logger | None = None,
             mcp_servers: list[MCPServerConfig] | None = None,
             skills_dir: str | None = None, *args,
             extra_env: dict[str, str] | None = None, **kwargs)   # base.py:49-68
```

抽象成员(**必须实现**):

| 成员 | 行号 | 签名 |
| --- | --- | --- |
| `name` | 104-107 | `@staticmethod def name() -> str` —— 是 **staticmethod**,无 `self` |
| `version` | 109-111 | `def version(self) -> str \| None` |
| `setup` | 120-134 | `async def setup(self, environment: BaseEnvironment) -> None` |
| `run` | 136-161 | `async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None` |

类级开关:`SUPPORTS_ATIF=False`(39)、`SUPPORTS_RESUME=False`(41)、`SUPPORTS_WINDOWS=False`(47)。
构造后由 Trial 注入 `session_id`、`context_id`(`harbor/trial/trial.py:807-808`)。

**关键点:`run()` 返回 `None`,没有 `AgentResult`。** 结果通过传入的 `context: AgentContext` **就地写回**(`trial.py:433` 建 `AgentContext()`,`trial.py:450-457` 在 `asyncio.wait_for` 里 await `run`)。
`logs_dir` 不是 run 参数,是构造参数,值为 `trial_dir/agent`,并被 bind-mount 进容器 `/logs/agent`(`trial.py:1222-1226`)。

### 3.2 `BaseInstalledAgent` — `harbor/agents/installed/base.py:282`

只多一个抽象成员:`async def install(self, environment) -> None`(602-609);`setup()` 已替你实现(611-636:建 `/installed-agent` → 建 host 侧 `logs_dir/setup` → 调 `install()` → 探版本)。
自带 `_exec` / `exec_as_root` / `exec_as_agent`(518-594,每条命令前缀 `set -o pipefail;`)、`CliFlag` / `EnvVar` / `ErrorPattern` 声明式描述符(173-212)。
**前提是 Harness CLI 装在任务容器内。**

### 3.3 容器句柄 `BaseEnvironment` — `harbor/environments/base.py:84`

```python
class ExecResult(BaseModel):        # base.py:78-82
    stdout: str | None; stderr: str | None; return_code: int

async def exec(self, command: str, cwd=None, env=None,
               timeout_sec=None, user=None) -> ExecResult          # base.py:1127-1147
async def upload_file(self, source_path, target_path)              # 916-924
async def upload_dir(self, source_dir, target_dir)                 # 926-934
async def download_file(self, source_path, target_path)            # 936-944
async def download_dir(self, source_dir, target_dir)               # 946-955
async def is_dir(self, path, user=None) -> bool                    # 1149-1161
async def service_exec(self, command, *, service=None, ...)        # 1199-…
```

容器内路径由 `harbor/models/trial/paths.py:9-75` 定义:`/logs`、`/logs/agent`、`/logs/verifier`、`/tests`、`/solution`。

### 3.4 结果类型 `AgentContext` — `harbor/models/agent/context.py:8-34`

```python
n_input_tokens: int | None; n_cache_tokens: int | None; n_output_tokens: int | None
cost_usd: float | None; rollout_details: list[RolloutDetail] | None
metadata: dict[str, Any] | None
```

### 3.5 trajectory.json —— **是 Agent 的活,不是 Harbor 的**

Harbor 只**读** `trial_dir/agent/trajectory.json`(`viewer/server.py:2413`、`utils/traces_utils.py:800`、`upload/uploader.py:524`);
导出时硬性要求 `agent_class.SUPPORTS_ATIF`(`utils/traces_utils.py:1246`,否则 `NotImplementedError`)。
格式 = ATIF `schema_version="ATIF-v1.7"`,模型在 `harbor/models/trajectories/`:
`Trajectory`(`trajectory.py:12`,`extra="forbid"`,`steps` 最少 1 条,`step_id` 从 1 连续,`observation.results[].source_call_id` 必须命中**同一 step** 的 `tool_calls[].tool_call_id`)、
`Agent`(`agent.py:8`)、`Step`(`step.py:14`,非 `agent` 来源的 step 必须把 `model_name/reasoning_effort/reasoning_content/tool_calls/metrics` 留空)、
`ToolCall`(`tool_call.py:8`)、`Observation`/`ObservationResult`、`Metrics`、`FinalMetrics`。

### 3.6 `--agent module:Class` 的解析与构造参数

`harbor/utils/import_path.py:9-43` 的 `import_symbol`(按**第一个** `:` 切分 → `importlib.import_module` → `getattr`),包装在 `harbor/agents/factory.py:17-21`。
`AgentFactory.create_agent_from_config`(`factory.py:129-208`)在 `name` 含 `:` 时把它当 `import_path`(152-159)。构造调用(`factory.py:104-126`, `189-197`):

```python
agent_class(logs_dir=<trial_dir/agent>, model_name=<-m 值或 None>,
            extra_env=<--ae 解析>, **<--ak 解析>, **<trial kwargs: logger, [mcp_servers], [skills_dir]>)
```

`--ak key=value` 先试 `json.loads`,再试 `True/False/None`,否则原样字符串(`harbor/cli/utils.py:65-105`)。

### 3.7 参考实现

最简完整示例:`harbor/agents/nop.py`(全文 32 行,`setup`/`run` 都是 `pass`)。
**host 侧驱动容器**的最佳模板:`harbor/agents/dspy_rlm.py:175`(`setup` 注释原文:“No container-side setup needed — RLM runs host-side.”,229-232)。
ATIF 转换参考:`harbor/agents/installed/mini_swe_agent.py:248-426, 587-632`。

---

## 4. Anna ↔ Harbor 接入形态与差距分析

### 4.1 选 `BaseAgent`(host 侧),不选 `BaseInstalledAgent`

`BaseInstalledAgent` 的前提是「Harness CLI 装在任务容器内」。Anna 是 **Windows 上的 FastAPI 后端 + Electron 外壳**,带自己的 Python 3.12 venv、`.anna/state` 三个 SQLite、`runtime.json` 配置树 —— 往 89 个 Linux 任务容器里各装一份既不现实也不诚实(而且会污染被测环境)。
Anna 天然是**容器外的控制方**,正是 `BaseAgent` 的形状(`dspy_rlm.py` 是同类先例)。

### 4.2 **今天无法实现的 Adapter 方法,以及为什么** —— 直说

| 需要做的事 | 能不能做 | 原因(可验证) |
| --- | --- | --- |
| `setup(environment)` | ✅ 能 | 容器内零安装,只校验 host 侧 Anna 可拉起 |
| `run()` 把任务指令交给 Anna | ✅ 能(本轮补的 headless 入口) | 见 §5 |
| `run()` 收集轨迹并回填 `AgentContext` | ✅ 能 | 帧流 → ATIF,已通过 Harbor 校验器验证(§6) |
| **`run()` 把 Anna 的动作下达进任务容器** | ❌ **不能** | **Anna 没有任何可执行的工具。** chat 白名单(`services/runtime/app/chat_tool_registry.py:22-29`)= `erp.finance.query` / `chat.emit_page` / `chat.emit_document` / `plan.update`,外加 per-run **只读**的 `workdir.read_file`(`services/chat/app/capability.py:61`)。没有 shell/bash、没有写文件、没有编辑、没有 grep。**没有任何一个工具能产生一条可以喂给 `environment.exec` 的命令** —— 所以「Anna 工具调用 → 容器执行」这条回桥**无从写起**,不是没写,是没有可桥接的一端。 |

具体到题目:`pypi-server` 要求「建 Python 包 → 构建 → 起本地 PyPI server(8080)→ 用 `--index-url` 装回来」。
Anna 能读工作空间、能说出应该怎么做,**一条命令也执行不了**。容器在整个 run 期间字节不变,verifier 必然给 reward 0。
**这是真实的能力失败,不是接入缺陷** —— Adapter 因此不伪造成功、不吞掉、也不包装成异常来掩盖(见 §5.2 的 `capability_note`)。

### 4.3 第二个硬性缺口:chat 的 **ERP 连接器 preflight**

`ChatOrchestrator._prepare_advance` 调 `model_and_connector_preflight`(`services/runtime/app/mcp_dispatcher.py:10-34`):
**先查模型凭据,再查 `adapter.status()` 是否 `connected`,任一不过就直接把 run 判失败。**
也就是说,**即使模型配好了**,只要 `ANNA_ERP_MCP_SERVER` 没指向一个活的 ERP MCP,Anna 的 chat surface 连启动都启动不了 —— 与 Terminal-Bench 题目毫无关系的一个业务连接器,是跑通评测的**硬前置**。
这条必须写进 §7 前置清单。

### 4.4 结论

| 维度 | 判定 |
| --- | --- |
| 接入方式 | §五 **情况 B**,自定义 Adapter |
| 基类 | `harbor.agents.base:BaseAgent`(host 侧,容器内零安装) |
| Adapter↔Anna 契约 | 子进程 + JSONL(不在 Harbor 进程内 import Anna:Anna 有独立 Python 3.12 venv 与依赖树,进程隔离让两边各自升级互不拖累) |
| 阻塞真跑的是什么 | ①本机无 Docker 且**无法**装(§1.2)②Anna 未配模型 ③Anna 未配 ERP 连接器 ④Anna **无执行工具**(这条不阻塞“跑”,只保证分数是 0) |

---

## 5. 本轮交付的代码

### 5.1 Anna headless 入口 —— `services/api/app/headless.py`(commit **`ef80c68`**)

Anna 此前**没有任何无界面入口**:任何自动化消费者都得先起 HTTP 服务、再从 `%APPDATA%\anna\runtime-info.json` 猜端口、再自己写 SSE 解析器。这个模块补上缺的一环 —— 它**与 Harbor 无关**,是 Anna 自身欠的债。

- 进程内驱动**既有**路径:`ChatOrchestrator.create_run` → `stream_existing_run`,同一个 orchestrator / 同一个引擎 / 同一份判断层。**不新建第二条路径**,评测测到的必须是产品本身。
- 每行 JSON 都过 SSE 路由**唯一那份** `_jsonify_frame` ⇒ JSONL 与 SSE 逐字节同形。
- **终态诚实,退出码三分**:`0` 办妥 / `1` 失败 / **`2` 可续办暂停(`awaiting_continue`)** / `3` 说不清。
  为什么单列 2:Anna 顶到 `max_turns` 会转成**可续办暂停**而不是失败(L4a),把它当 0 上报是评测里最坏的一种谎。
  实现上先 `create_run` 拿 run 对象再 `stream_existing_run`,正因为**暂停态不发终态帧**(`done`/`error` 都不会来),只有手里攥着 run 才总能读到终态。
- `--workdir` 复用 `POST /api/workdirs` 的同一份 id 派生(路径 sha1 前 12 位),注册幂等。
- 末行 `headless.result` 汇总:`run_id / thread_id / status / exit_code / error_code / error_message / assistant_message / tool_calls / input_tokens / output_tokens / evaluation_continuations`。token 数只在提供方真报了才有,否则 `null`(诚实规则,不臆造 0)。

用法:

```bash
python -m services.api.app.headless --prompt "..." [--prompt-file F] [--workdir DIR] [--no-judge]
```

**测试证据** —— `tests/api/test_headless_cli.py`,6 例,全部用仓库既有 `FakeStreamModel` 惯用法(**零 token、零网络**),RED 先行:

| 用例 | 断言 |
| --- | --- |
| 正常完成 | 每行合法 JSON;`text_delta`/`event`/`done` 帧齐备;`done.run` 已 JSON 化;末行 `headless.result` 且 `exit_code=0` |
| preflight 失败 | `error` 帧 + 退出码 1;`error_code="model_not_configured"` 出现在汇总行 |
| `max_turns` 顶满 | 退出码 **2**;**没有** `done`/`error` 帧;有 `run.suspended` 审计帧;`tool_calls>0` |
| workdir 注册 | 同一目录两次注册 → 同一 id,注册表不重复 |
| workdir 注入 | system prompt 含 `[工作空间]` 与 `README.md`;`workdir.read_file` 出现在模型可见工具里 |
| CLI 解析 | argv → 参数默认值正确 |

```
.venv\Scripts\python.exe -m pytest tests/api/test_headless_cli.py -q   →  6 passed in 0.36s
.venv\Scripts\python.exe -m pytest -q                                  →  943 passed in 78.55s
```

**真机 dry-run**(未配模型的当前环境,输出经脱敏检查无 Key):

```
{"type":"event","event":{"type":"chat.run.created", ...}}
{"type":"event","event":{"type":"skill.loaded","payload":{"skill_id":"chat/general-assistant", ...}}}
{"type":"event","event":{"type":"chat.run.failed","payload":{"error_code":"model_not_configured"}}}
{"type":"error","run":{...,"status":"failed","error_code":"model_not_configured"}}
{"type":"headless.result","status":"failed","exit_code":1,"error_code":"model_not_configured", ...}
EXIT_CODE=1
```

### 5.2 Harbor Adapter —— `evals/terminal-bench/anna_agent.py`

`class AnnaAgent(BaseAgent)`,`SUPPORTS_ATIF = True`。职责严格限于 §五允许的四件事:

1. `setup()`:容器内零安装,只校验 Anna 能被拉起(解释器 + 仓库存在)。**宁可在 setup 阶段炸**,也不要跑到一半才发现根本没装 —— 前者 Harbor 归成 agent setup 错误,后者会被误读成任务失败。
2. `_mirror_container_workdir()`:`environment.download_dir(container_workdir, host_tmp)` 把容器工作目录**单向只读**镜像到 host,登记成 Anna 的工作空间。默认 `/app`,可 `--ak container_workdir=...` 覆盖。镜像失败 → 降级为「无工作空间」并记日志,**不炸 trial**。
3. `_drive_anna()`:用 Anna 自己的 venv 起 `python -m services.api.app.headless`,任务指令经 `--prompt-file` **原样**传入(不改写、不加提示、不夹带任何 TB 知识),逐行收帧。非 JSON 的噪声也留证据(`adapter.unparsed_stdout`),不装作没看见。
4. 落盘 `anna-frames.jsonl` / `anna-stderr.log` / `instruction.txt` / **`trajectory.json`(ATIF)**,回填 `AgentContext`。

**诚实性设计(重点)**:

- **不含任何 TB 专属逻辑 / 硬编码答案 / 按题分支。** 唯一与题目形态相关的常量是容器工作目录默认值 `/app`,且可覆盖。
- 能力缺口以**事实**记进 `context.metadata`:`container_bridge="none"`、`environment_mutations=0`、`anna_tools_called=[...]`,以及一句 `capability_note`:
  > “Anna exposes no shell/file-write/edit tool, so this adapter issues no commands into the task container; the container is unchanged and any reward 0 is a genuine capability failure, not an adapter defect.”
  这是关于 **Adapter 自身**的事实陈述,不是对 Anna 的猜测。
- **能力失败不抛,基础设施失败必抛**(§七:不得把基础设施失败伪装成 Agent 失败)。
  `INFRA_ERROR_CODES = {model_not_configured, mcp_connector_not_ready, model_provider_unavailable, model_rate_limited, model_call_timeout, model_unauthorized}` → `raise AnnaAgentStartupError`;
  headless 一条 `headless.result` 都没吐出来 → 同样 raise。
  其余(含 reward 0、含 `awaiting_continue`)一律如实回填、正常返回,交给 verifier 判分。

调用方式(目录名带连字符,不能作点分模块路径,故走 `PYTHONPATH`):

```bash
PYTHONPATH=/path/to/Anna/evals/terminal-bench \
ANNA_PYTHON=/path/to/Anna/.venv/Scripts/python.exe \
ANNA_REPO=/path/to/Anna \
harbor run -d "terminal-bench/terminal-bench-2-1" --agent "anna_agent:AnnaAgent" -m "<MODEL_ID>" -n 1
```

可选 `--ak`:`anna_repo=` / `anna_python=` / `container_workdir=/app` / `sync_workdir=False` / `judge=False` / `timeout_sec=1800`。

---

## 6. §六 阶段1 —— 在无 Docker 边界内实跑到底

| 阶段1 检查项 | 结果 | 证据 |
| --- | --- | --- |
| Harbor CLI 可用 | ✅ | `harbor --version` → 0.20.0;`harbor --help` / `run --help` / `dataset --help` 全部正常 |
| 数据集可解析 | ✅ | `PackageDatasetClient` 解出 `terminal-bench/terminal-bench-2-1`,89 题,`sha256:7d7bdc1c…` |
| 单题可下载(不需 Docker) | ✅ | `harbor download terminal-bench/pypi-server` → `Successfully downloaded 1 task(s)` |
| **Adapter 能被 Harbor 自己解析** | ✅ | `import_class("anna_agent:AnnaAgent")` → `subclass of BaseAgent: True`;`__abstractmethods__ == frozenset()`(**无遗漏抽象方法**);`import_path` → `anna_agent:AnnaAgent` |
| Adapter 可实例化 + `to_agent_info()` | ✅ | `AgentInfo(name='anna', version='ef80c68', model_info=ModelInfo(name='deepseek-chat'))` —— version 取自 Anna 真实 commit |
| `setup()` 无容器可跑通 | ✅ | 正例通过;反例(错误的 `anna_python`)→ `AnnaAgentStartupError: Anna python not found: ...`,**在 setup 阶段响亮失败** |
| **Harness 能读到任务指令并被驱动** | ✅ | 用 stub environment 复刻容器(只拷 `instruction.md` + `environment/`,**刻意不拷 `solution/`**),跑完整 `agent.run()`:子进程起、帧收全、日志落盘 |
| Harbor 能拿到执行结果 | ✅ | `AgentContext.metadata` 完整回填(见下) |
| **trajectory.json 能生成且合法** | ✅ | 用真实 29 帧流(fake model,含一次 `plan.update` 工具往返)转 ATIF → 6 steps,`sources=['user','agent'×5]`,`step2.tool_calls=[{tool_call_id:"anna-2-0", function_name:"plan.update"}]`,observation 的 `source_call_id` 正确配对;**`Trajectory.model_validate()` 往返通过** |
| Shell / 文件编辑工具能工作 | ❌ **不能** | Anna 无此类工具(§4.2)。**这一项永远不会绿,直到 Anna 长出执行工具** |
| 容器能创建 | ⛔ **被阻塞** | Docker 缺席 |
| Verifier 能产生 reward | ⛔ **被阻塞** | 同上 |

**真实的 `harbor run` 尝试与精确阻塞点**:

```powershell
harbor run -d "terminal-bench/terminal-bench-2-1" --agent "anna_agent:AnnaAgent" -m "deepseek-chat" -l 1 -n 1 -y
# → Docker is not installed or not on PATH. Please install Docker and try again.
# EXIT=1
```

源码位置:`harbor/environments/docker/docker.py:151-169` 的 `DockerEnvironment.preflight()` —— `shutil.which("docker")` 失败即 `SystemExit`。
**这是在下载任务、创建容器、调用 Adapter 之前的第一道门**,所以阶段1 的后三项一个都没能触达。

**无 Docker 的端到端 dry-run 输出**(真跑,真子进程):

```
setup OK
run() raised (classified as INFRA, per protocol §7):
  Anna run failed with an infrastructure error: model_not_configured — model endpoint and API key are required before running Anna Chat
logs_dir contents: ['anna-frames.jsonl', 'instruction.txt', 'trajectory.json', 'workdirs.json']
AgentContext.metadata:
{
  "anna_exit_code": 1, "anna_status": "failed", "anna_error_code": "model_not_configured",
  "anna_suspended": false, "anna_tools_called": [], "anna_tool_call_count": 0,
  "anna_evaluation_continuations": 0,
  "container_bridge": "none", "environment_mutations": 0,
  "capability_note": "Anna exposes no shell/file-write/edit tool, ..."
}
trajectory.json validates as ATIF
```

即:**Adapter 全链路已通,唯一没跑的是 Docker 之后的那半段。**

---

## 7. 真跑阶段1 所需的前置条件(精确清单)

### 7.1 阻塞级(不满足则一步都跑不了)

1. **容器运行时。** 本机**装不了 Docker Desktop** —— 阿里云 ECS guest 未暴露嵌套虚拟化(`VMMonitorModeExtensions=False`),WSL2 与 Hyper-V 都起不来。三条出路,按推荐排序:
   - **(a) 换机器**:一台原生 Linux + Docker 的机器(或支持嵌套虚拟化的 ECS 实例规格)。Anna 是纯 Python + FastAPI,配置全走 env,可以在 Linux 上跑 headless —— 需要在该机建一个 Linux venv(`pyproject.toml` 钉 3.12)。
   - **(b) 远程环境后端**:Harbor 的 `-e/--env` 支持 `e2b / daytona / modal / runloop / beam / blaxel / novita / gke / ec2 / …`,这些**不走本地 Docker**(本地 Docker 检查只在 `environments/docker/docker.py`)。需要对应服务商的账号与 API Key,以及网络可达。**这是唯一能保留当前机器的路径。**
   - **(c) 放弃本机**:在 CI(Linux runner)上跑。
2. **模型配置。** `ANNA_MODEL_ENDPOINT` + `ANNA_MODEL_API_KEY` + `ANNA_MODEL_NAME`(或等价的 `runtime.json`)。当前**全部 unset**,headless 直接 `model_not_configured`。协议模板里的 `<MODEL_ID>` / `<MODEL_PROVIDER>` 仍待用户指定。
3. **ERP MCP 连接器。** `ANNA_ERP_MCP_SERVER`(+ 视需要 `ANNA_ERP_MCP_API_KEY`)必须指向一个 `status="connected"` 的 MCP。
   **这是 Anna 自身的架构耦合,与 Terminal-Bench 无关**:`_prepare_advance` 的 preflight 不过就直接判 run 失败(§4.3)。
   若不想为评测拉起 ERP,只有改 Anna(把连接器 preflight 从「硬前置」降级为「按需」)——**属于产品决策,本轮不擅动。**

### 7.2 容量级(不满足则跑不完 / 结果不可比)

4. **磁盘 ≥ 100 GB 可用**(89 个独立镜像;单题声明 `storage_mb=10240`)。当前 C: 仅 16.9 GB。
5. **内存与并发**:题目声明 `memory_mb=2048`;Harbor 默认 `-n 4` ⇒ 8 GB,超过本机 7.75 GB。本机若真跑必须 `-n 1`,并把并发数写进配置记录(§四·阶段4 要求基线/优化版**并发一致**)。
6. **时间预算**:单题 `agent.timeout_sec=900` + `verifier.timeout_sec=900` + `build_timeout_sec=600`;89 题 `-n 1` 的最坏情况约 60 小时。串行跑全量在本机不现实。

### 7.3 能力级(不满足则分数注定为 0,但不阻塞流程)

7. **Anna 需要执行工具。** 没有 shell / 文件写 / 编辑,Terminal-Bench 的 89 题**一题都不可能通过**。
   基线跑仍有价值(它给出一个诚实的地板值,并把失败归因固定在「工具面缺失」而非「模型不行」),但任何「优化是否有效」的实验在这之前都没有信噪比可言 —— 主指标恒为 0,`pass^k` 无法区分任何改动。
   **建议**:把「执行工具面」当作跑 TB 之前的先决产品工作,而不是评测发现的问题。

### 7.4 一旦上述满足,阶段1 的执行命令

```bash
export ANNA_REPO=/path/to/Anna
export ANNA_PYTHON=$ANNA_REPO/.venv/bin/python
export PYTHONPATH=$ANNA_REPO/evals/terminal-bench
export ANNA_MODEL_ENDPOINT=... ANNA_MODEL_API_KEY=... ANNA_MODEL_NAME=...
export ANNA_ERP_MCP_SERVER=...

harbor run \
  -d "terminal-bench/terminal-bench-2-1" \
  --agent "anna_agent:AnnaAgent" \
  -m "<MODEL_ID>" \
  -i "pypi-server" \
  -n 1 -k 1 \
  -o ./jobs
harbor view jobs
```

逐项核对 §六阶段1 的七条,并保留 `config.json` / `result.json` / `trajectory.json` / verifier logs / agent logs 作为下一阶段的基线证据。

---

## 8. 归档

| 产物 | 路径 |
| --- | --- |
| Anna headless 入口 | `services/api/app/headless.py`(commit `ef80c68`) |
| headless 测试 | `tests/api/test_headless_cli.py`(6 例,全绿) |
| Harbor Adapter | `evals/terminal-bench/anna_agent.py` |
| 本报告 | `docs/superpowers/plans/2026-08-06-terminal-bench/00-integration-report.md` |

未提交的临时探针(dataset 解析 / ATIF 校验 / e2e dry-run 脚本)留在会话 scratchpad,复现命令已内联在本报告对应小节。
