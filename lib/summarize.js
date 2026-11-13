/**
 * dsh-enough — the handoff summarizer.
 *
 * Replaces the "generic conversation summary" prompt of the compaction
 * backend with a task-handoff brief: the model writes six sections that a
 * fresh agent could pick the task up from, preserving paths, commands,
 * identifiers, numbers and quoted errors verbatim.
 */
const INSTRUCTION = `你正在为一次「上下文交接」写摘要。这段对话接下来会被这条摘要替换，之后的任务只能靠你写的摘要继续。

请严格按下面六节输出。逐字保留路径、命令、URL、错误原文、标识符、数字、配置键和函数签名——这些一旦改写就无法恢复。不要提"摘要""压缩"这件事，就当你是这个任务的新接手人，在给自己写交接笔记。不要复述大段原文，优先写结论和可执行细节。

## 原始任务
用户最初要什么，逐字复述关键约束和验收条件。

## 已完成
已经做完并验证的事，附证据（文件路径、命令、输出要点）。

## 当前进度
正在做的事做到哪一步，进行中的假设是什么。

## 下一步
紧接着要做的事，按顺序编号。

## 关键事实
之后会用到的路径、接口、配置、常量、坑和踩过的失败。

## 未决问题
还没答案的问题、待用户确认的事、已知风险。`

const TRANSCRIPT_MAX_CHARS = 160_000

function blockText(block) {
  if (!block || typeof block !== 'object') return ''
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : ''
    case 'tool-call':
      return `[tool-call] ${block.name ?? ''}(${block.arguments ?? ''})`
    case 'reasoning':
      return ''
    default:
      return ''
  }
}

function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(blockText).filter(Boolean).join('\n')
}

/** Flatten the compacted message span into a plain transcript. */
export function buildTranscript(messages) {
  const parts = []
  for (const message of messages ?? []) {
    const text = messageText(message).trim()
    if (!text) continue
    const role = typeof message?.role === 'string' ? message.role : 'user'
    parts.push(`[${role}]\n${text}`)
  }
  let transcript = parts.join('\n\n')
  if (transcript.length > TRANSCRIPT_MAX_CHARS) {
    const half = Math.floor(TRANSCRIPT_MAX_CHARS / 2)
    transcript = `${transcript.slice(0, half)}\n\n[…中间内容过长，交接摘要时省略…]\n\n${transcript.slice(-half)}`
  }
  return transcript
}

function finishFailure(reason) {
  if (!reason || typeof reason !== 'object') return null
  if (reason.kind === 'error' || reason.kind === 'aborted') {
    const failure = reason.failure ?? {}
    const detail = failure.message ?? failure.code ?? 'unknown failure'
    return `dsh-enough: summarization stream failed: ${detail}`
  }
  if (reason.kind === 'max-tokens') return 'dsh-enough: summary hit the token cap; refusing to checkpoint a truncated brief'
  return null
}

/**
 * Produce the handoff summary for a compaction span.
 *
 * Returns the exact shape `BasicCompactionEngine.summarize()` is expected to
 * return: `{ summary: TextBlock[], rawOutput, llmStreamCall, provider, model, maxTokens }`.
 */
export async function summarizeEnough(ctx, config, input, agent, signal) {
  const header = agent?.session?.requestHeader?.()
  const routed = header?.config
  const provider = (routed?.provider ?? '').length > 0 ? routed.provider : agent?.options?.provider
  const model = (routed?.model ?? '').length > 0 ? routed.model : agent?.options?.model
  if (!provider || !model) {
    throw new Error('dsh-enough: no provider/model available for handoff summarization')
  }

  const transcript = buildTranscript(input?.messages)
  if (!transcript.trim()) {
    throw new Error('dsh-enough: nothing to summarize (empty compacted span)')
  }

  const maxTokens = Math.max(2000, Math.min(16000, Number(config?.summaryMaxTokens) || 8000))
  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: `${INSTRUCTION}\n\n<conversation>\n${transcript}\n</conversation>` }],
    },
  ]

  let text = ''
  let finish = null
  for await (const chunk of ctx.llm.stream({
    provider,
    model,
    messages,
    maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...(signal ? { signal } : {}),
  })) {
    if (chunk?.type === 'text-delta') text += chunk.text ?? ''
    else if (chunk?.type === 'finish') finish = chunk.reason ?? null
  }

  const failure = finishFailure(finish)
  if (failure) throw new Error(failure)
  const trimmed = text.trim()
  if (!trimmed) throw new Error('dsh-enough: handoff summarizer produced no text')

  const summary = [{ type: 'text', text: trimmed }]
  return {
    summary,
    rawOutput: summary,
    llmStreamCall: true,
    provider,
    model,
    maxTokens,
  }
}
