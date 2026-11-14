# dsh-enough

> You don't need long context.

中文 · [English](README.md)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的上下文减负插件，取自 NVIDIA 研究院 *You Don't Need Long Context?*（[arXiv:2611.05306](https://arxiv.org/abs/2611.05306)）。

三件事，一个插件：

| 能力 | 默认 | 作用 |
| --- | --- | --- |
| **交接压缩（EoCC）** | 开 | 上下文到阈值时，把旧历史换成一个「谁接手都能继续」的交接简报，而不是让模型把整段对话再读一遍 |
| **长输入选择性读取** | 开 | `context_index` 把大文件/目录变成带行号的分节索引，只读需要的那一段 |
| **单动作压缩（SAC）** | 可选，默认关 | 每次 agent 空闲就压一次，只留语义状态 |

## 解决什么问题

长上下文不是免费的：KV cache 随长度线性增长，单 token 成本近线性上升。论文实测 H100 上把窗口从 16K 放到 256K，GLM / Kimi / 千问的单 token 成本分别涨 3.6 / 5.6 / 7 倍。

真正贵的是「每次都把全部历史重新读一遍」。dsh-enough 的做法：

1. **压缩时写交接简报，不写对话摘要。** 压缩引擎本来就会用一段摘要替换旧历史；dsh-enough 把这段摘要换成交接简报——原始任务 / 已完成 / 当前进度 / 下一步 / 关键事实 / 未决问题，六段都是「下一个接手的人需要的东西」。
2. **长文档先建索引。** `context_index` 按 Markdown 标题切成带行号的分节，模型用 `read(offset, limit)` 只读需要的那几段，不把整篇灌进上下文。

## 安装

暂未发布到 npm，从 GitHub 安装：

```bash
git clone https://github.com/TwiObliv0vx/dsh-enough.git ~/.dsh/plugins/dsh-enough
dsh plugin add "link:C:/Users/<you>/.dsh/plugins/dsh-enough"
```

桌面版 profile 由 Electron 托管，`dsh plugin` 会被拒绝；改 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 后 `pnpm install`，再重启桌面端。

## 用法

### 命令

```
/enough                  # 状态
/enough mode coexist     # 共存（默认）：只提供工具与命令，不动现有压缩
/enough mode takeover    # 接管：压缩摘要换成交接简报（运行时生效，可随时切回）
/enough sac on|off       # 单动作压缩
/enough index <路径>      # 看某个文件的分节索引
```

### 工具

- `enough_status` — 模式、交接摘要是否安装、压缩引擎、配置路径
- `context_index` — `{path}` 单文件分节索引；`{dir}` 扫目录列出大文件

### 设置页

设置 → 够用：模式、SAC、摘要上限、索引阈值，以及只读的引擎参数（取自压缩引擎）与引擎状态。

## 与别的压缩器共存

默认 `coexist` 模式不碰压缩后端，profile 里已有的压缩器可以继续工作。

### 预设层接管（当前 DSH 版本唯一有效的方式）

这个版本的 DSH 把压缩引擎挂在 **agent preset 的隔离组**里（`isolate: { compaction: true }`），
Host 层 `ctx.get('compaction')` 拿到的是 null。

插件监听全局 `internal/config` 事件：在任何直接挂载 `@deepseek-ai/dsh-compaction-basic` 的隔离组里，
把 `compactThresholdRatio` 写进引擎配置，并在同一组追加一行 `enough-handoff`。只改隔离组，
Host 层压缩行不动，不会重复接管。

**装在哪里很关键**：预设 revision 是注册即激活的，钩子必须在所有预设之前注册。所以
`dsh-enough` 在 profile 的 `dsh.profile.bundles` 里要排在 `@deepseek-ai/dsh-web-app` **前面**
（本机排在 `@deepseek-ai/dsh-base` 之后）。插件也不注入 `webServer`，设置页路由用
`ctx.inject(['webServer'])` 延迟挂载，否则 `apply()` 会被拖到 web 包之后才跑、一个预设都赶不上。
改动 bundles 顺序后需要重启 DSH。

**两种摘要在运行时切换**：行一旦插进去就长期留在预设里；`presetHandoff` 是每次压缩时读取的开关，
`/enough mode takeover` 用交接简报、`/enough mode coexist` 用引擎自己的摘要。切换不重启、
不重开会话，下一次压缩就生效。行本身随新会话生效（已有会话保留它启动时的预设版本）。

### 旧式的 Host 层接管

引擎确实挂在 Host 层的部署里时，`/enough mode takeover` 还会顺手替换那里的摘要器；引擎不存在就跳过，
不影响预设层那条路。压缩什么时候触发由引擎的 `thresholdRatio` 决定，要提前就用上面的 `compactThresholdRatio`。

## 配置

`~/.dsh/enough/config.json`（可用 `DSH_ENOUGH_HOME` 覆盖目录）：

```json
{
  "mode": "coexist",
  "sac": false,
  "presetHandoff": true,
  "compactThresholdRatio": 0.72,
  "summaryMaxTokens": 8000,
  "indexMinBytes": 24000,
  "indexMaxFiles": 200
}
```

- `compactThresholdRatio`：写进预设压缩引擎的触发比例（`0.1`–`0.99`），`0` 表示不改动引擎自己的值。
  大窗口下配 0.7 左右比较稳，别指望引擎精确估算中文 token。
- `handoffSpec`：可覆盖插进预设那一行的模块 spec（默认是本包的 `file://` 地址），只在排查挂载问题时才需要。

## 限制

- 交接简报的质量取决于摘要模型；`summaryMaxTokens` 给太小会丢细节（默认 8000）。
- `takeover` 只换摘要器，不改变压缩事务本身（替换哪些消息、事务原子性仍由 DSH compaction 负责）。
- SAC 每轮空闲压一次，短对话上收益为负，默认关。
- 设置页的引擎参数只读，且取自压缩引擎：它的配置在启动时冻结，dsh-enough 不改运行中的引擎；
  `compactThresholdRatio` 是写进「预设将要挂载的那份配置」，不是运行时改内存。
- 预设层接管依赖 DSH 的内部事件 `internal/config`。版本变化后如果这个事件改名，钩子会静默退回
  并存模式，`enough_status` 的 `preset hook:` 一行会显示 `off` 或错误原因。

## 开发

```bash
node test/smoke.mjs   # 44 项断言，无 DSH 运行时依赖
node test/hook.mjs    # 20 项断言：预设改写与摘要器安装
```

## License

MIT
