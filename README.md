# dsh-enough

> You don't need long context.

[中文](README.zh.md) · English

A context-relief plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), based on NVIDIA Research's *You Don't Need Long Context?* ([arXiv:2611.05306](https://arxiv.org/abs/2611.05306)).

Three things, one plugin:

| Capability | Default | What it does |
| --- | --- | --- |
| **Handoff compaction (EoCC)** | on | When context hits the threshold, old history is replaced with a handoff brief the next agent can continue from — not a generic conversation recap |
| **Selective long-input reading** | on | `context_index` turns a big file or directory into a line-ranged section index, so the agent reads only the slice it needs |
| **Single-action compaction (SAC)** | optional, off | Compact once whenever an agent goes idle, keeping only semantic state |

## Why

Long context is not free: the KV cache grows with length and per-token cost rises nearly linearly. The paper measured an H100 going from a 16K to a 256K window and per-token cost rose 3.6× / 5.6× / 7× for GLM / Kimi / Qwen.

What is actually expensive is re-reading the entire history on every turn. dsh-enough:

1. **Compacts into a handoff brief, not a conversation summary.** The compaction engine already replaces old history with a summary; dsh-enough swaps that summary for a brief — task / done / progress / next / key facts / open questions — each section is what the next person needs.
2. **Indexes long documents first.** `context_index` splits a file by Markdown headings with line ranges; the model then reads only the sections it needs with `read(offset, limit)`.

## Install

```bash
# npm (once published)
dsh plugin add dsh-enough

# local development: junction + link install (Windows paths must not contain spaces)
dsh plugin add "link:C:/Users/<you>/.dsh/plugins/dsh-enough"
```

The desktop profile is managed by Electron and rejects `dsh plugin`; edit `~/.dsh/profiles/<profile>/package.json` (`dependencies` + `dsh.profile.bundles`), run `pnpm install`, then restart the desktop app.

## Usage

### Commands

```
/enough                  # status
/enough mode coexist     # coexist (default): tools + command only, existing compaction untouched
/enough mode takeover    # takeover: compaction summaries become handoff briefs (runtime, reversible)
/enough sac on|off       # single-action compaction
/enough index <path>     # section index for one file or directory
```

### Tools

- `enough_status` — mode, whether the handoff summarizer is installed, engine, config path
- `context_index` — `{path}` file section index; `{dir}` scan a directory for large files

### Settings

Settings → 够用 (dsh-enough): mode, SAC, summary cap, index thresholds, plus engine limits (read-only, sourced from the compaction engine) and engine status.

## Coexisting with another compressor

`coexist` (default) leaves the compaction backend alone, so whatever compressor your profile already runs keeps working. To let dsh-enough's handoff brief take over:

```
/enough mode takeover
```

Switch back with `/enough mode coexist`. Neither needs a restart.

> Note: `takeover` replaces **how the summary is written**; **when compaction fires** is still decided by `@deepseek-ai/dsh-compaction-basic`'s `thresholdRatio` (frozen at startup). To change the trigger, configure it in the profile's `cordis.patch.yml`:

```yaml
- id: compaction-basic
  config:
    thresholdRatio: 0.8
    retainRatio: 0.16
```

## Configuration

`~/.dsh/enough/config.json` (override the directory with `DSH_ENOUGH_HOME`):

```json
{
  "mode": "coexist",
  "sac": false,
  "summaryMaxTokens": 8000,
  "indexMinBytes": 24000,
  "indexMaxFiles": 200
}
```

The settings page and `/enough` write the same file. Engine limits are never stored here — they belong to the compaction engine.

## Limitations

- Handoff quality depends on the summarization model; too small a `summaryMaxTokens` loses detail (default 8000).
- `takeover` swaps only the summarizer; the compaction transaction itself (which messages are replaced, atomicity) stays with DSH compaction.
- SAC compacts on every idle turn and is negative-value on short conversations — off by default.
- The engine limits on the settings page are read-only and sourced from the compaction engine: its config is frozen at startup. dsh-enough never persists or applies them — configure `@deepseek-ai/dsh-compaction-basic` in the profile patch instead.

## Development

```bash
node test/smoke.mjs   # smoke assertions, no DSH runtime required
```

## License

MIT
