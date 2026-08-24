/**
 * interjectNotes(J3 前端)· 插话没送到时的回退文案与草稿还原(纯函数)
 *
 * 插话的全部价值是「这句话确实进了正在跑的这次 run」。没进去的时候,回执是用户
 * 唯一的凭据 —— 它必须说清两件事:**为什么没进去**,和**那句话现在在哪**。
 * 两者都错过一次,用户就再也不会相信这个入口。
 *
 * 抽成纯函数(与仓库既有「纯逻辑 .test.ts」范式一致,不引入 jsdom):
 * HomePage 只做事件面适配,文案与还原语义只有这一处事实源。
 */

/** 后端 `_TERMINAL_CHAT_STATUSES` 的中文说法;这里只翻译,不归并。 */
const TERMINAL_TEXT: Record<string, string> = {
  failed: "失败",
  interrupted: "已停止",
};

/**
 * 把插话的原文还回输入框。
 *
 * **追加,不是二选一**。旧实现是 `prev.trim() ? prev : text`:用户在等回执的这一两
 * 秒里又打了字,那句插话就被静默丢弃 —— 而提示还写着「话先还给你了」。宁可让用户
 * 删掉多出来的一行,也不能让他以为话还在、其实已经没了。
 */
export function restoredDraft(prev: string, text: string): string {
  return prev.trim() ? `${prev}\n${text}` : text;
}

/**
 * `accepted: false` 的回执文案 —— 按 run 的**真实终态**分叉。
 *
 * 旧实现对任何终态都说「这次任务刚好已经办完」,可后端返回的 status 也可能是
 * failed / interrupted:任务失败了却被告知「办完了」,是这一片最直接的谎。
 * 认不出的状态原样回显后端说法,不猜也不美化。
 */
export function interjectRejectedNote(status: string): string {
  const normalized = (status || "").trim();
  if (normalized === "ready" || normalized === "saved") {
    return "这次任务刚好已经办完，这句没能进去 —— 直接发出去，就是新的一轮。";
  }
  const how = TERMINAL_TEXT[normalized] ?? (normalized ? `状态：${normalized}` : "状态不明");
  return `这次任务已结束（${how}），这句没能进去 —— 话已还给输入框。`;
}

/**
 * 提交刚发出、后台 run 通道还没建立时按下回车的回执。
 *
 * 这段窗口是真实存在的:`running` 在 submit RPC 返回**之前**就翻成 true,而
 * run_id 要等响应才有。此时回车被插话分支吃掉、run_id 还是 null —— 旧实现直接
 * `return`,用户敲了回车、屏幕上什么都没发生,只能怀疑是不是没按到。
 * 这条回执与「不清空草稿」是同一件事的两半。
 */
export const CHANNEL_PENDING_NOTE =
  "任务通道还在建立，这句还在输入框里 —— 稍候一两秒再回车。";

/** 插话 RPC 本身失败(网络问题):不假装送到了。 */
export const UNDELIVERED_NOTE = "补充指示没送达（连接问题），话先还给你了。";
