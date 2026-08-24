/** B2 后端通道就绪前恒 reject;LoopCard 无 l3 时不出箭头,此函数暂无调用方。 */
export function fetchToolResult(_runId: string, _stepId: string): Promise<string> {
  return Promise.reject(new Error("L3 下钻通道未上线（B2）"));
}
