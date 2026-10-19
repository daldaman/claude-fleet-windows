// What fleet asks Claude: a title and resume value per session, from Haiku.
import type { ResumeValue } from '../../types'

export const LABEL_SYSTEM =
  'You label coding sessions for a session list. Reply with JSON only: {"title": string, "value": string}.\n' +
  'title: 3-6 words naming the task, leading with the concrete project and goal ("Canvas lab 2 grading drafts"); ' +
  'no quotes, no trailing punctuation, never the words "session", "conversation" or "chat".\n' +
  'value: whether resuming is worth re-sending the whole conversation. Pick exactly one:\n' +
  '- "light": quick questions or one-off lookups; nothing a fresh session couldn\'t redo in a minute.\n' +
  '- "reference": substantial work whose main task was delivered or answered. This is the DEFAULT for real work. ' +
  'A last reply that offers more help, lists optional next steps, or asks "want me to...?" is still "reference".\n' +
  '- "active": ONLY when work is clearly mid-flight: the last reply stops partway through an implementation, ' +
  'a bug or failing test is still being chased, or the person must answer a question before anything can continue. ' +
  'Sessions idle for weeks are rarely active.'

export const labelPrompt = (first: string[], latest: string[], lastReply: string, idleText: string) =>
  (
    `Opening requests:\n${first.join('\n---\n')}\n\nLatest requests:\n${latest.join('\n---\n') || '(same)'}` +
    `\n\nLast reply (end):\n${lastReply || '(none)'}\n\nIdle for: ${idleText}`
  ).slice(0, 5000)

const cleanTitle = (text: string) =>
  text.split('\n')[0].replace(/^(title:\s*)/i, '').replace(/["'`*#]/g, '').replace(/[.\s]+$/, '').trim().slice(0, 48)

// The label reply as JSON, or a bare title when the model skipped the JSON.
export const parseLabel = (text: string): { title: string; value?: ResumeValue } | null => {
  try {
    const raw = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    const title = cleanTitle(String(raw.title ?? ''))
    const value = ['active', 'reference', 'light'].includes(raw.value) ? (raw.value as ResumeValue) : undefined
    return title ? { title, value } : null
  } catch {
    const title = cleanTitle(text)
    return title && !title.includes('{') ? { title } : null
  }
}
