/**
 * dsh-enough — the handoff summarizer.
 *
 * Replaces the "generic conversation summary" prompt of the compaction
 * backend with a task-handoff brief: the model writes six sections that a
 * fresh agent could pick the task up from, preserving paths, commands,
 * identifiers, numbers and quoted errors verbatim.
 */
const INSTRUCTION = `You are writing a handoff brief for a conversation that is about to be replaced by this brief. Only what you write here survives; the next agent continues from it.

Write exactly these six sections, with these headings. Keep paths, commands, URLs, error strings, identifiers, numbers, config keys and function signatures verbatim — rewriting them makes them unrecoverable. Do not mention "summary" or "compaction"; write as if you were the next person taking over the task. Prefer conclusions and actionable details over long quotations. Write the brief in the same language as the conversation.

## Original task
What the user originally asked for; restate the constraints and acceptance criteria verbatim.

## Done
What is finished and verified, with evidence (file paths, commands, key output).

## Current progress
Where the work stands now, including working assumptions.

## Next steps
What to do next, in order.

## Key facts
Paths, interfaces, config, constants, pitfalls and failed attempts the next agent needs.

## Open questions
Unanswered questions, things waiting on the user, known risks.`

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
