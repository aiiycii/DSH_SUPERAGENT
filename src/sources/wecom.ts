/** WeCom source kind definition and Cordis plugin entry: the messages of the WeCom smart-bot bridge CLI (`wecomq`). */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

const SOURCE = 'wecom'
const ConfigSchema = z.object({
  /** The bridge CLI (`wecomq`); a command name or an absolute path of an executable wrapper. */
  cli: z.string().trim().default(''),
  conversations: z.array(z.object({ id: z.string().trim().min(1), listen: z.enum(['mentions', 'all']) }).strict())
    .refine(chats => new Set(chats.map(chat => chat.id)).size === chats.length, 'Duplicate conversation IDs')
    .default([]),
  pollSeconds: z.number().int().min(10).max(3600).default(15),
}).strict()
export type WecomConfig = z.infer<typeof ConfigSchema>

/** One message as `wecomq pull` and `wecomq thread` print it. */
const MessageSchema = z.looseObject({
  id: z.string().min(1), conversation: z.string().min(1), thread: z.string().optional(),
  sender: z.looseObject({ id: z.string(), bot: z.boolean().default(false) }), mentions_me: z.boolean().default(false),
  text: z.string(), at: z.string(), url: z.string().optional(),
})
type WecomMessage = z.infer<typeof MessageSchema>
/** The answer of `wecomq pull`, whose items are read one by one. */
const PageSchema = z.looseObject({ me: z.string(), items: z.array(z.unknown()), next: z.number().int() })
/** The answer of `wecomq thread`. */
const ThreadPageSchema = z.looseObject({ items: z.array(MessageSchema), next: z.string().optional() })

/**
 * A single chat's conversation id is the sender's userid; WeCom group chat ids start with `wr`.
 * The bridge records one thread per conversation (its `thread` field), so the conversation is the Thread.
 */
export const directChat = (conversation: string): boolean => !conversation.startsWith('wr')
export const wecomTriggerId = (messageId: string): string => key(SOURCE, messageId)

/** The Trigger of one WeCom message; the agent's own messages produce none. `cli` rides in the address so replies find the bridge. */
export function wecomTrigger(message: WecomMessage, me: string, cli?: string): Trigger | undefined {
  if (message.sender.id === me || message.sender.bot) return undefined
  const thread = message.thread ?? message.id
  // A single chat's message is addressed to the bot by definition; a group message only when it mentions the bot.
  const addressed = message.mentions_me ? ('mention' as const) : directChat(message.conversation) ? ('direct' as const) : undefined
  return {
    id: wecomTriggerId(message.id),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: message.sender.id },
    human: !message.sender.bot,
    ...(addressed ? { addressed } : {}),
    at: message.at,
    text: message.text,
    channel: { source: SOURCE, thread: `${SOURCE}:${thread}`,
      address: { conversation: message.conversation, message: message.id, ...(message.url ? { url: message.url } : {}), ...(cli ? { cli } : {}) } },
    ...(message.url ? { url: message.url } : {}),
    meta: { conversation: message.conversation, messageId: message.id, root: message.thread ?? message.id, direct: directChat(message.conversation) },
  }
}

/**
 * Replies under a message through the bridge, whose `--key` makes each send idempotent.
 * The bridge's CLI path rides in the address, so a reply only needs the stored address facts.
 */
export async function sendWecom(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { conversation, message: to, cli } = message.channel.address
  if (!conversation || !to || !cli) throw new Error('Missing WeCom reply target')
  await host.commands.run(cli, ['reply', '--conversation', conversation, '--to', to, '--key', message.id, '--text', message.text])
  return 'sent'
}

export const wecomKind: SourceKind<WecomConfig> = {
  kind: SOURCE,
  title: { zh: '企业微信', en: 'WeCom' },
  description: { zh: '通过 wecomq 桥接收下列企业微信会话的消息并回复。', en: 'Receives and replies to the messages of these WeCom conversations through the wecomq bridge.' },
  schema: ConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: { zh: 'wecomq 桥接 CLI', en: 'wecomq bridge CLI' },
      hint: { zh: '命令名或绝对路径，指向可执行的 wecomq 桥（比如企微联通目录里的 wecomq 包装脚本）。保存后要重启 dsh-superagent 才生效。', en: 'A command name or absolute path of an executable wecomq bridge (such as the wecomq wrapper in the bridge directory); saving requires a dsh-superagent restart to take effect.' } },
    { key: 'conversations', type: 'rows', label: { zh: '接收的会话', en: 'Conversations' },
      hint: { zh: '“仅 @”接收群里 @ 机器人的消息和已有工单的线程，单聊消息本来就指向机器人，始终接收；“全部消息”也接收群里其余消息，能否发起工作看策略里的准入。', en: '"@ only" receives group messages that mention the bot and Threads that have Tickets; single-chat messages always address the bot and are always received; "All" also receives the rest of a group, whose admission the Policy decides.' },
      columns: [
        { key: 'id', type: 'text', label: { zh: '会话', en: 'Conversation' } },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      ] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: [SOURCE],
  scope({ meta }, config) {
    const conversation = config.conversations.find(item => item.id === meta.conversation)
    if (!conversation) return { listened: false, reason: 'conversation_not_listed' }
    return { listened: true, observed: conversation.listen === 'all', row: conversation.id }
  },
  channel: {
    // A reply goes only to a conversation the Source still receives with the same bridge CLI.
    allowed: (address, config) => !!config.cli && address.cli === config.cli && config.conversations.some(item => item.id === address.conversation),
    send: sendWecom,
    link: address => ({ url: address.url ?? '', label: { zh: `企业微信会话 ${address.conversation ?? ''}`, en: `WeCom conversation ${address.conversation ?? ''}` } }),
  },
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId ?? ''),
    // A WeCom thread is the flat history of its conversation, oldest first, one page at a time.
    read: async (commands, trigger, _part, cursor, config) => {
      const page = ThreadPageSchema.parse(JSON.parse(await commands.run(config.cli, ['thread', '--conversation',
        String(trigger.meta.conversation), '--root', String(trigger.meta.root), '--json', ...(cursor ? ['--after', cursor] : [])])))
      const messages = page.items.map(item => ({ id: item.id, from: item.sender.id, at: item.at, text: item.text,
        ...(item.sender.bot ? { bot: true as const } : {}), ...(item.url ? { url: item.url } : {}) }))
      return { messages, ...(page.next ? { next: page.next } : {}), body: { messages } }
    },
  },
  find: query => ({ threads: [], terms: [...new Set(query.match(/\b[0-9a-f]{16,32}\b/g) ?? [])] }),
  policy: {
    unnamed: { person: { zh: '企微用户', en: 'WeCom user' }, bot: { zh: '企微机器人', en: 'WeCom bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate sender IDs').default([]),
    }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的企微用户', en: 'WeCom users who may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID' } }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单里的人私聊机器人，或在群里 @ 机器人。', en: 'Someone on the list messages the bot directly, or mentions it in a group.' },
    rows: stored => ConfigSchema.parse(stored).conversations.map(conversation => {
      const all = conversation.listen === 'all'
      return { id: conversation.id, label: conversation.id, note: all ? { zh: '全部消息', en: 'All' } : { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: all, unlistedAddressed: true, unlistedUnaddressed: all } }
    }),
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_WECOM_CONVERSATION', description: {
      zh: '接下工单的企业微信会话；工单不是从企业微信来的时为空',
      en: 'The WeCom conversation that started the ticket; empty when the ticket did not start on WeCom' } }],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_WECOM_CONVERSATION: trigger?.source === SOURCE ? String(trigger.meta.conversation ?? '') : '' }),
  },
}

/** Reads the bridge store after the cursor, takes in each message, then moves the cursor past them. */
export async function pollWecom(ctx: SourceContext, signal: AbortSignal): Promise<{ read: number; unreadable: number }> {
  const config = ctx.config<WecomConfig>(SOURCE)
  if (!config?.cli) throw new Error('The WeCom Source has no wecomq CLI')
  const after = ctx.state.get(KV.wecom.cursor) ?? 0
  const output = await ctx.commands.withSignal(signal).run(config.cli, ['pull', '--after', String(after), '--json'])
  const page = PageSchema.parse(JSON.parse(output))
  let unreadable = 0
  for (const item of page.items) {
    if (signal.aborted) throw new Error('The WeCom Source stopped during the read')
    const message = MessageSchema.safeParse(item)
    if (!message.success) { unreadable++; continue }
    const trigger = wecomTrigger(message.data, page.me, config.cli)
    if (!trigger) continue
    await ctx.receive(trigger)
    const conversation = { label: { zh: '会话', en: 'Conversation' }, value: message.data.conversation }
    for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { conversation } })
  }
  ctx.state.set(KV.wecom.cursor, page.next)
  return { read: page.items.length, unreadable }
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the deployment; until then the Source reads nothing.
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<WecomConfig>(SOURCE)
    if (!config?.cli) ctx.report(SOURCE, health('paused', 'wecomCliUnset'))
    else {
      const at = new Date().toISOString()
      try {
        const { read, unreadable } = await pollWecom(ctx, signal)
        failures = 0
        ctx.report(SOURCE, { state: 'ready', detail: `${read} messages, ${unreadable} unreadable`, at })
      } catch (error) {
        failures += 1
        // One failure is retried on the next round; three in a row need a person.
        if (!signal.aborted && failures >= 3) {
          ctx.report(SOURCE, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await delay((config?.pollSeconds ?? 15) * 1000, undefined, { signal }).catch(() => {})
  }
}

export const name = 'dsh-superagent-wecom'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(wecomKind), 'wecom: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, wecomKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('wecom', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
