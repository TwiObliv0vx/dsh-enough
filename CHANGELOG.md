# Changelog

## 0.1.0 — 2026-11-13

首个版本。

- 交接压缩（EoCC）：运行时替换压缩引擎的摘要器，输出六段交接简报（原始任务 / 已完成 / 当前进度 / 下一步 / 关键事实 / 未决问题）。
- 长输入选择性读取：新增 `context_index` 工具，按 Markdown 标题给出带行号的分节索引；支持目录扫描。
- 单动作压缩（SAC）：可选，默认关，agent 空闲时压缩一次。
- `/enough` 命令：status / mode coexist|takeover / sac on|off / index。
- 设置页：模式、SAC、摘要上限、索引阈值、引擎状态。
- 默认 `coexist` 模式，与 billion-context 共存；`takeover` 运行时切换，可逆。
