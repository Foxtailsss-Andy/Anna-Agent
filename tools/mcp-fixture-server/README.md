# Anna MCP fixture server

一个**确定性、本地**的 MCP server（protocol revision `2025-06-18`），用于验证 Harness Host 侧的 MCP client（`apps/harness-service/src/workbench-mcp.ts`）。它不是 Anna 产品运行时的一部分，不返回任何业务数据：每个结果都只由请求参数推导得出。只依赖 Node.js 内置模块（Node ≥ 22）。

## Tools

`tools/list` 按每页 2 个分页（`nextCursor` = `page:<offset>`），用于覆盖 cursor 逻辑。

| Tool | 参数 | `readOnlyHint` | 行为 |
| --- | --- | --- | --- |
| `echo` | `{text: string}` | `true` | 原样返回 `text` |
| `add` | `{a: number, b: number}` | `true` | 返回 `{"sum":…}` 文本块，同时返回 `structuredContent: {sum}` |
| `write_note` | `{name: string, text: string}` | 无 | 把 `text` 写入 `--notes-dir/<name>`；拒绝路径穿越（`/`、`\`、`..`），未配置 `--notes-dir` 时返回 `isError: true` |
| `slow` | `{ms: number}` | `true` | 等待 `ms`（≤ 60000）后返回；收到 `notifications/cancelled` 时停止且不再回复 |
| `fail` | `{}` | `true` | 始终返回 `isError: true` 的工具执行错误 |

参数类型错误或未知 tool 返回 JSON-RPC error `-32602`。在收到 `notifications/initialized` 之前，`tools/*` 请求返回 `-32600`。

## 运行方式

```bash
# stdio（默认）：stdin/stdout 上的换行分隔 JSON-RPC，日志写 stderr
node tools/mcp-fixture-server/server.mjs --notes-dir /tmp/anna-mcp-notes

# Streamable HTTP：监听 127.0.0.1:<port>/mcp，initialize 时分配 Mcp-Session-Id
# 启动后在 stdout 打印一行 MCP_FIXTURE_HTTP_URL=http://127.0.0.1:<port>/mcp（--http 0 = 随机端口）
node tools/mcp-fixture-server/server.mjs --http 8971 --notes-dir /tmp/anna-mcp-notes
```

HTTP 模式：`tools/call` 以 SSE 流应答（先发一条无关的 `notifications/message`，再发 response），其余请求以 `application/json` 应答；校验 `Accept`、`Content-Type`、`Mcp-Session-Id`、`MCP-Protocol-Version` 和本机 `Origin`；`DELETE /mcp` 终止 session（之后该 session 返回 404）。`--require-auth <token>` 要求 `Authorization: Bearer <token>`（只用于测试 header 透传，请勿使用真实凭据）。

测试钩子（默认关闭，只供自动化测试使用）：`--exit-on <method>`（收到该 method 时 `exit(3)`）、`--env-tool`（增加 `env_report`，返回本进程环境变量）、`--extra-tools`（增加 `Echo` 同名冲突、非法 `inputSchema` 的 `bad_schema`/`array_schema` 与 `big {bytes}`）、`--stderr-bytes <n>`、`--never-initialize`。

## 在 Anna Host 中配置

MCP server 声明在受保护的 Host 配置文件中，由环境变量 `ANNA_HARNESS_MCP_CONFIG_PATH` 指向（文件应放在 checkout 与 Agent 可读 workdir 之外，例如 `~/.config/anna/` 下）。格式：

```json
{
  "mcpServers": {
    "fixture": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/Anna/tools/mcp-fixture-server/server.mjs", "--notes-dir", "/tmp/anna-mcp-notes"],
      "timeout_ms": 20000
    },
    "fixture_http": {
      "url": "http://127.0.0.1:8971/mcp"
    }
  }
}
```

- stdio server：`command` + 可选 `args`、`env`、`cwd`（绝对路径）。Host **不会**把自身环境传给子进程：子进程只拿到 `PATH`、`LANG`、一个每 server 独立的临时 `HOME`，以及这里显式配置的 `env`。`command` 建议写绝对路径。
- HTTP server：`url` + 可选 `headers`。只接受 `http://127.0.0.1`、`http://localhost`、`http://[::1]` 或 `https://`；不跟随重定向；URL 中不得包含用户名/密码。
- 可选 `timeout_ms`（每个请求，默认 20000）与 `disabled: true`。未知字段会被忽略。

Tools 以 capability `mcp.<server_id>.<tool_name>`（小写，`[a-z0-9_-]` 之外的字符替换为 `_`）出现，例如 `mcp.fixture.echo`。`readOnlyHint: true` 的 tool 是只读 effect，其余（如 `write_note`）是写 effect，只在 `contained-write` 权限模式下可用。
