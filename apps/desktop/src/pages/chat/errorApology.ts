/**
 * errorApology · 失败卡外的致歉段(纯映射,可 vitest 单测)
 *
 * 输入 = error 帧原文(`tree.error.message`,后端 error_message/error_code)。
 * 语体铁律(§3 大小姐语体):**先致歉,再归因,绝不甩锅用户**。error 原文本身在
 * 失败卡 L3 内一字不改呈现;此处只负责卡外那句体面的中文致歉与温和归因。
 *
 * 归因按已知 error code / 已知 error_message 子串匹配(归一化后 tree.error 只带 message,
 * 故同时覆盖 code 词元与其人话原文);无法归类 → 通用致歉(不臆造具体缘由)。
 */

const RESUME_HINT = "此前产生的过程都为您留着，您可以复制错误原文或重新发起。";

export function errorApology(message: string): string {
  const m = (message ?? "").toLowerCase();

  if (/timeout|timed out|超时/.test(m)) {
    return `抱歉，这一步没有办成——是执行超时了，并非您的吩咐有误。${RESUME_HINT}`;
  }
  if (/model_not_configured|model endpoint and api key|模型.*(未|没).*配置|not configured/.test(m)) {
    return "抱歉，暂时未能为您办理——模型尚未配置妥当，并非您的吩咐有误。请在设置里连接好模型后再试。";
  }
  if (/client_disconnected|disconnected|连接中断/.test(m)) {
    return `抱歉，连接中断了，这一步没能办完。${RESUME_HINT}`;
  }
  return `抱歉，这一步没有办成。具体缘由已如实附在上方过程里，这不是您的问题；${RESUME_HINT}`;
}

export default errorApology;
