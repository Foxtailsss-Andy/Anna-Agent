# Crew 精修轮(用户真机反馈 → 修改)

> 2026-07-20 用户真机走查后反馈 5 点 + Fable 亲自视觉复现(截图存 scratchpad/shots)。用户拍板:#3=@它+派给它自动跑;#4=模板内置并行+多依赖;#2=授权 Fable 按 Asana 心智优化。执行:Opus 分片,Fable 把关+亲自视觉验收。base=91b8c9f(HEAD)。

## 诊断实况(视觉证实)

| # | 反馈 | 真相(截图为证) | 归属 |
|---|---|---|---|
| 3 | @ Agent 没反应=没接 harness | harness **通**(真 deepseek 产出 1178 字 PRD 验证);缺**触发**——仅抽屉「执行」按钮触发 | R-B |
| 1 | 看不到产物 | 产物**存在**,但评审卡/门**无内嵌正文**=盲审;抽屉预览埋深且 markdown 未渲染 | R-F1 |
| — | (Fable 发现)产出跑题 | PRD 产出是"在线教育平台"≠项目「登录页」——worker prompt 只喂任务标题,未喂项目目标+上游产物 | R-B |
| 4 | 要多线程 | 两模板纯线性瀑布;elk/画布底层已支持 DAG 分叉 | R-B |
| 5 | 有的项目连线有的没有 | 连线**都渲染**,但线性链被折 3 行→大幅斜跨+极淡休眠虚线→像断了 | R-F2 |
| 2 | 操作简化学 Asana | 派人→开始→提交→评审 步骤多、动作藏抽屉 | R-F2 |

## R-B 后端(Agent 触发 + 并行模板 + grounding + 自动推进)

**Files**:`services/crew/app/{lifecycle,service,sop_templates,agent_worker}.py`、`services/api/app/routes/crew.py`、相应 tests。

1. **Agent 自动触发(#3)**:
   - `assign` 到 agent-kind 成员**且任务 ready**(assigned 态)→ 自动异步 dispatch run-agent(复用 B2 后台 manager + B4 在飞去重)。预派到 blocked 任务不跑;解锁进 ready 时若已派 agent→此刻自动跑。
   - 频道 say **@了某 agent** 且该 agent 在本项目有 assigned|rework 任务 → 重新 dispatch(「@Scribe 再改改」)。
   - Anna 口吻频道 event:「已派 @Agent·X,开始执行。」(已有)+ 自动跑时不重复喧闹。
2. **自动推进(#2 的后端半)**:评审门 approve → 下游新 ready 任务**自动 smart-match 指派**(复用 matching)+ 若指派对象是 agent 则自动跑;**人类下游只指派不自动做**(等人)。链路在评审门自然暂停(Boss 审)——不会 runaway。
3. **prompt grounding(质量硬伤)**:`agent_worker` 组 prompt 必须含:①项目 `goal_text`(醒目置顶);②**上游依赖任务的最新 artifact 正文**(截断,作为输入);③项目共识(已有 B1b)。让 PRD 真的写登录页。
4. **并行模板 + 多依赖(#4)**:`feature_iteration` 改为含并行段——需求简报→PRD 起草→PRD 评审◇→**(设计稿 ∥ 技术预研)**→设计评审◇(依赖设计稿+技术预研两者)→实施→代码评审◇→验收合并。验证:门/任务 `depends_on` 多父就绪逻辑(B4 `_deps_satisfied` 已支持 list,补多父测试);`+任务` confirm 支持 depends_on 多值(已是 list,补测)。

**验收**:全量 pytest 绿(基线 781);新测试覆盖 auto-run-on-assign(agent ready→跑、预派不跑、在飞不重复)、@重派、approve→下游自动指派+agent 自动跑、多父门就绪、prompt 含 goal+上游 artifact。

## R-F1 前端(评审内嵌产物 + markdown)

**Files(所有权)**:`apps/desktop/src/pages/crew/channel/ReviewCard.tsx`、`apps/desktop/src/pages/crew/inspect/TaskDrawer.tsx` + 其样式、新增 `MarkdownView` 复用件(react-markdown 已是依赖,参考 chat/AnswerBody 用法 + remark-gfm)。**禁碰** graph/、TaskNode、DetailPage、CrewProjectsPage、后端。

1. **评审卡内嵌被评审产物(#1)**:ReviewCard(kind="review",task_id=门)从项目快照解析该门 `reviews` 指向的 producer 任务→取其最新 artifact_versions 正文→**内嵌可展开的 markdown 预览**(默认折叠一行标题+展开读全文),Boss 读完正文再点 通过/驳回。产物为空则显「尚无产物」。
2. **抽屉产物 markdown 渲染**:TaskDrawer 产物版本卡的预览从纯文本改 markdown 渲染;产物区更醒目(默认展开最新版首屏)。
3. 双主题;markdown 样式随 Iris(表格/代码/标题 iris 化,沿 chat 答复排版)。

**验收**:三门绿(基线 318 vitest);真机(Fable 验)评审卡直接读到 PRD 正文。

## R-F2 前端(节点就地动作 + 布局质量 + 简化)

**Files(所有权)**:`apps/desktop/src/pages/crew/graph/{TaskNode,GateNode,CrewGraphCanvas,useElkLayout}.tsx/ts`、`apps/desktop/src/pages/crew/CrewProjectDetailPage.tsx`、`apps/desktop/src/pages/crew/inspect/{useTaskOps,actions}.ts`(就地动作复用)、相应样式。**禁碰** channel/、TaskDrawer、后端。

1. **节点就地主动作(#2 Asana 就地)**:每个任务节点按状态直显**唯一主动作**小按钮,一键完成,不必开抽屉:就绪待认领→「认领」;执行中(人)→「提交」;agent 任务未跑→「执行」(冗余入口,后端已 auto-run 但保留手动);待审(门)→「评审」(开 R-F1 的评审面);阻塞→「看原因」。动作调既有 API 后即时 refresh。单击节点仍开轻检视 popover(不冲突:主按钮 stopPropagation)。
2. **布局质量(#5)**:调 `useElkLayout` elk 参数——优先干净的**从左到右分层**,避免线性链强制折行产生大幅斜跨回边(放宽/去掉 aspectRatio 强制,让并行段自然纵向展开,长链保持水平可横向滚动);休眠虚线**提升可见度**(opacity/描边),确保 edge 在 elk 布局 resolve 后确定性渲染(查 async 竞态:首帧无坐标→补一次 layout)。并行模板(R-B)会让布局天然更宽更清晰。
3. **健康条/列表**保持;列表视图任务行也带就地主动作(与节点一致)。

**验收**:三门绿;真机(Fable 验)布局清晰无断线错觉、节点一键推进。

## 执行波次

```
波A: R-B(后端,独立)∥ R-F1(评审内嵌)∥ R-F2(节点就地+布局)  ← 三片文件所有权互斥,可全并行
波B: Fable 亲自视觉验收(重跑 inspect 脚本,建新项目走 @触发/自动跑/并行图/评审读正文/一键推进)+ 清理演示脏数据(?????? 乱码项目)+ 全门 + 记账
```

## 🏁 精修收轮(2026-07-20,Fable 亲自视觉验收)

**三片落地**:R-B(4e46e1c 并行模板+610224e grounding+fe91a2d 自动触发/推进/@重派+1800a09 返工喂批注)、R-F1(a4a7cb7 评审内嵌+markdown)、R-F2(735de2a 节点就地+布局)+ 把关打磨(74abc1d fitView 可读下限)。**四门:pytest 801 / tsc 0 / vitest 349 / build ✓**。

**Fable 真机视觉验收(截图 scratchpad/shots2,清库重种后建旗舰项目 proj_1)**:
- **#3 自动触发 ✓**:派 PRD 给 Agent·Scribe(**未调 run-agent**)→ auto_pilot 自动跑真模型 ~24s → submitted;频道叙事「Anna 派→@Agent·Scribe 产出→评审卡」自然成链。
- **grounding ✓**(质量硬伤):PRD 产出 2005 字,登录相关命中 6、跑题 0(修前是"在线教育平台");喂了项目目标+上游简报正文。
- **#4 并行 ✓**:9 节点,PRD 评审→(设计稿∥技术预研)→设计评审双父门,分叉/汇合清晰。
- **#5 布局 ✓**:线性段单行、并行段纵向展开,底栏「2 行」,无纠缠斜跨;休眠虚线提实;fitView 首屏 72% 可读(修前 50% 小字)。
- **#1 评审内嵌 ✓**:评审卡「查看待评审产物」展开**内嵌渲染 PRD 全文 markdown(含表格)**,Boss 读完再点通过/驳回;抽屉产物版本卡同样 markdown 渲染 + 执行 trace 显真 run_subagent 过程。
- **#2 简化 ✓**:节点/列表行就地主动作(认领/开始/执行/提交/评审),不必翻抽屉。

**用户拍板决议全部落地**。**服务器运行中**(端口 8000,新代码+清净库+旗舰项目 proj_1 已带真 PRD),待用户视觉验收。

## 偏差登记

**R-B**:D1 auto-advance 用确定性角色 match(非模型,转移在请求 loop 线程避阻塞);D2 auto_pilot 默认关、生产 main.py 开(保测试手动驱动用例);D3 四转移路由 sync→async(dispatcher 需 running loop);D4 run_agent 内部解锁不链式 dispatch(过门自然暂停不 runaway);D5 门 grounding 只解析 reviews 主对象;**D6 返工喂驳回批注入 prompt(超字面契约,使「@再改改」有的放矢——Fable 裁定接纳)**。
**R-F1**:remark-gfm 未装(worktree 无),用自包含竖线表格解析器兜住(表格已渲染,其余 GFM 扩展降级为字面——PRD 够用);CSS 落组件级 CrewMarkdown.css;评审卡走 props(ChannelColumn 传 tasks 快照)非 fetch。
**R-F2**:节点主动作取 hover/选中显形(保七态署名行不挤)、列表行常驻;纯映射落 graphMapping 复用 inspectActions 不重复封装;去掉折返第二行(#5 根源);休眠边提实 1.6px;边与节点同门 layout 消除首帧竞态。
**Fable 打磨**:fitView 首屏加 minZoom 0.72 下限(宽扁 DAG 不压到 50%);清库重种消除早先 curl 编码脏数据(?????? 项目)。
**遗留 P1**(不阻验收):看板视图/就地审批/悬挂 run 清扫/成员侧栏列项目/催收派办集成;画布宽 DAG 首屏仍需横向平移看全(可读优先取舍)。
