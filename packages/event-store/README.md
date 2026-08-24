# @anna/event-store

Anna 的 channel-scoped canonical Event Store。`InMemoryEventStore` 用于 conformance，`SqliteEventStore` 用于本地持久化与重启恢复；两者通过同一 `EventStore` / `ScopedChannelStore` seam 提供事件、命令与投影行为。

## Local SQLite runtime

- Node **>=22.19.0**；SQLite 仅使用内置实验性 `node:sqlite` 的 `DatabaseSync`，没有 `better-sqlite3`、`sqlite3` 或 fallback。
- 文件库启动时执行版本化迁移，并设置 `journal_mode=WAL`、`synchronous=FULL`、`foreign_keys=ON` 与 `busy_timeout=5000ms`。
- 写入 `append`、`claimStart`、`claimChannelSession`、`commitProjection` 都以 `BEGIN IMMEDIATE` 包住短同步事务；调用方不得在这些事务中等待 I/O 或运行 reducer。每个 scope 只能持久化认领一个 `ChannelSession`。
- 投影按 `(scope, projector, streamId)` 绑定；receipt 也带 `streamId`，因此同一 projector 的两个 sequence-0 stream 不会互相跳过事件。
- `schema_migrations` 高于当前版本会以 `UnsupportedSchemaVersionError` fail-closed，且不会尝试执行旧版 schema SQL。
- `close()` 后可安全重开同一文件。测试覆盖迁移、WAL、重开恢复、重启 reconciliation、两个连接的 sequence / projection version fencing，以及由受控子进程在不调用 `close()` 时以 73 退出后的 projection / Run 重建。

`node:sqlite` 仍会在当前 Node 版本发出 `ExperimentalWarning`，这是已知运行时提示，并非测试失败。Windows 主机尚未实际跑过；在目标 Windows 环境发布前，需复跑 file reopen、WAL 和双连接 fencing 测试。
