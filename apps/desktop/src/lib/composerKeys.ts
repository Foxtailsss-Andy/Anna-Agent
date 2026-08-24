/**
 * composerKeys · 全局输入惯例:Enter 发送(精修二轮 S-E · 设计稿 3k)
 *
 * 三处 composer 同一契约(Home Chat/Create · Cowork 问 Anna · Crew 频道):
 *   - 纯 Enter 发送(非 IME 组词、非运行中、trim 后非空)
 *   - Shift+Enter 换行(不拦截默认,交给 textarea 原生行为)
 *   - Ctrl/⌘+Enter 仍发送(兼容旧肌肉记忆)
 *   - IME 组词中(nativeEvent.isComposing)Enter 完全放行,交给输入法确认字词
 *
 * 判定抽为纯函数,便于 node 环境单测(与仓库既有「纯逻辑 .test.ts」范式一致,
 * 不引入 jsdom / 组件测试栈)。两处 composer 的 keydown 只做事件面适配后调用本函数,
 * 因此发送惯例只有一处事实源。
 */

/** keydown 中本模块所需的最小事件面(适配 React.KeyboardEvent) */
export interface ComposerEnterSignal {
  key: string;
  shiftKey: boolean;
  /** 来自 nativeEvent.isComposing —— IME 组词进行中 */
  isComposing: boolean;
  preventDefault(): void;
}

export interface ComposerSendGuards {
  /** 运行中不发送(沿既有守卫);支持插话的 composer 见 onInterject */
  running: boolean;
  /** value.trim() 后是否仍有内容 */
  hasText: boolean;
  onSend(): void;
  /**
   * J3 插话:该 composer 所在 surface 支持「边跑边说」时提供。
   * 运行中按 Enter → 走这里(给当前 run 补一句),而不是发一个新 run。
   * 不提供(Cowork/Crew 等尚未支持 steering 的 composer)→ 运行中仍是既有的不发送守卫。
   */
  onInterject?(): void;
}

/**
 * 处理一次 keydown 的发送判定。
 * 命中发送 → preventDefault + onSend,返回 true;
 * 否则不做任何事(放行默认行为:Shift+Enter 换行 / 组词中的换行 / 空文本等),返回 false。
 *
 * 注:Ctrl/⌘ 不参与判定 —— 纯 Enter 与 Ctrl/⌘+Enter 判定一致(都发送),
 * 唯有 Shift 会阻止发送(转为换行)。
 * 调用方若已在更高优先级分支(如 skill 快召面板的 Enter 选择)消费了 Enter,则不应调用本函数。
 */
export function handleComposerEnter(
  e: ComposerEnterSignal,
  guards: ComposerSendGuards,
): boolean {
  if (e.key !== "Enter") return false;
  if (e.isComposing) return false; // IME 组词中:放行,交输入法确认
  if (e.shiftKey) return false; // Shift+Enter:换行(不拦默认)
  if (!guards.hasText) return false;
  if (guards.running) {
    // J3:运行中的 Enter 是「补充指示」,不是新 run —— 同一肌肉记忆,两种语义由
    // 运行态区分(spec 原文写 Ctrl+Enter,其后 S-E 统一了 Enter 发送惯例,
    // 故此处随新惯例:运行中 Enter 即插话)。surface 不支持插话则沿既有守卫不发送。
    if (guards.onInterject === undefined) return false;
    e.preventDefault();
    guards.onInterject();
    return true;
  }
  e.preventDefault();
  guards.onSend();
  return true;
}
