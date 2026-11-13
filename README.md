# dsh-enough

> You don't need long context.

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的上下文减负插件，取自 NVIDIA 研究院 *You Don't Need Long Context?*（[arXiv:2611.05306](https://arxiv.org/abs/2611.05306)）。

三件事，一个插件：

| 能力 | 开关 | 作用 |
| --- | --- | --- |
| **交接压缩（EoCC）** | 必备 | 上下文到阈值时，把旧历史换成一个「谁接手都能继续」的交接简报，而不是让模型把整段对话再读一遍 |
| **长输入选择性读取** | 必备 | `context_index` 把大文件/目录变成带行号的分节索引，只读需要的那一段 |
| **单动作压缩（SAC）** | 可选，默认关 | 每次 agent 空闲就压一次，只留语义状态（对应论文的 single-action compaction） |

## 解决什么问题

长上下文不是免费的：KV cache 随长度线性增长，单 token 成本近线性上升。论文实测 H100 上把窗口从 16K 放到 256K，GLM / Kimi / 千问的单 token 成本分别涨 3.6 / 5.6 / 7 倍。

真正贵的是「每次都把全部历史重新读一遍」。dsh-enough 的做法：

1. **压缩时写交接简报，不写对话摘要。** 压缩引擎本来就会用一段摘要替换旧历史；dsh-enough 把这段摘要换成交接简报——原始任务 / 已完成 / 当前进度 / 下一步 / 关键事实 / 未决问题，六段都是「下一个接手的人需要的东西」。
2. **长文档先建索引。** `context_index` 按 Markdown 标题切成带行号的分节，模型用 `read(offset, limit)` 只读需要的那几段，不把整篇灌进上下文。

## 安装

```bash
# 从 npm（发布后）
dsh plugin add dsh-enough

# 本地开发：junction + link 安装（Windows 路径不要带空格）
dsh plugin add "link:C:/Users/<you>/.dsh/plugins/dsh-enough"
```

桌面版 profile 由 Electron 托管，`dsh plugin` 会被拒绝；改 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 后 `pnpm install`，再重启桌面端（详见 DSH 文档）。

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

设置 → 够用：模式、SAC、摘要上限、索引阈值，以及只读的压缩阈值与引擎状态。

## 与 billion-context 共存

默认 `coexist` 模式不碰压缩后端，billion-context 可以继续工作。想用 dsh-enough 的交接简报接管压缩：

```
/enough mode takeover
```

切回：`/enough mode coexist`。两者都无需重启。

> 注意：`takeover` 替换的是**摘要怎么写**；压缩**什么时候触发**仍由 `@deepseek-ai/dsh-compaction-basic` 的 `thresholdRatio` 决定（启动时冻结）。要改触发阈值，在 profile 的 `cordis.patch.yml` 里给 `compaction-basic` 配：

```yaml
- id: compaction-basic
  config:
    thresholdRatio: 0.55
    retainRatio: 0.12
```

## 配置

`~/.dsh/enough/config.json`（可用 `DSH_ENOUGH_HOME` 覆盖目录）：

```json
{
  "mode": "coexist",
  "sac": false,
  "thresholdRatio": 0.55,
  "retainRatio": 0.12,
  "summaryMaxTokens": 8000,
  "indexMinBytes": 24000,
  "indexMaxFiles": 200
}
```

设置页与 `/enough` 写的是同一份文件。

## 限制

- 交接简报的质量取决于摘要模型；`summaryMaxTokens` 给太小会丢细节（默认 8000）。
- `takeover` 只换摘要器，不改变压缩事务本身（替换哪些消息、事务原子性仍由 DSH compaction 负责）。
- SAC 每轮空闲压一次，短对话上收益为负，默认关。
- 设置页的阈值只读：`compaction-basic` 的配置在启动时冻结。

## 开发

```bash
node test/smoke.mjs   # 40 项断言，无 DSH 运行时依赖
```

## License

MIT
