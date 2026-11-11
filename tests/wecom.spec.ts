import { describe, expect, it, vi } from 'vitest'
import type { Assessor, Executor, Trigger } from '../src/core/index.ts'
import { Engine, key } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { pollWecom, sendWecom, wecomKind, wecomTrigger, type WecomConfig } from '../src/sources/wecom.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = '/usr/local/bin/wecomq'
const message = (id: string, fields: Record<string, unknown> = {}) =>
  ({ id, conversation: 'wo_user', thread: 'wo_user', sender: { id: 'wo_alice', bot: false }, mentions_me: false,
    text: 'hello', at: '2026-11-11T10:00:00+08:00', url: '', ...fields })

function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'wecom-')), 'db.sqlite'))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(wecomKind)
  store.saveSettings(SettingsSchema.parse({
    sources: { wecom: { enabled: true, config: { cli: CLI, conversations: [{ id: 'wo_user', listen: 'all' }] } } },
    policy: { sources: { wecom: { allowed: [{ id: 'wo_alice' }] } } },
    eval: { mode: 'auto' },
  }))
  const deployment = testDeployment()
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: m => { store.receipts.add(m) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  return { ...deps, ctx: sourceContextOf(deps, wecomKind), store, engine, commands, receive, health: board.all }
}
/** Stubs `wecomq pull` with the answer of the current round. */
function queue(h: ReturnType<typeof host>, answer: () => unknown) {
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  return vi.spyOn(h.commands, 'run').mockImplementation(async () => JSON.stringify(answer()))
}

describe('wecom trigger translation', () => {
  it('drops the bot\'s own messages', () => {
    expect(wecomTrigger(message('m1'), 'wo_alice')).toBeUndefined()
    expect(wecomTrigger(message('m2', { sender: { id: 'wo_other', bot: true } }), 'bot')).toBeUndefined()
  })
  it('maps a single chat onto the conversation thread, addressed directly', () => {
    const trigger = wecomTrigger(message('m3'), 'bot')!
    expect(trigger.id).toBe(key('wecom', 'm3'))
    expect(trigger.threads).toEqual([{ source: 'wecom', id: 'wo_user' }])
    expect(trigger.actor).toEqual({ source: 'wecom', id: 'wo_alice' })
    expect(trigger.human).toBe(true)
    expect(trigger.addressed).toBe('direct')
    expect(trigger.channel).toMatchObject({ source: 'wecom', thread: 'wecom:wo_user',
      address: { conversation: 'wo_user', message: 'm3' } })
    expect(trigger.meta).toMatchObject({ conversation: 'wo_user', messageId: 'm3', root: 'wo_user', direct: true })
  })
  it('marks a group message addressed only when it mentions the bot', () => {
    expect(wecomTrigger(message('m4', { conversation: 'wr_group' }), 'bot')?.addressed).toBeUndefined()
    expect(wecomTrigger(message('m5', { conversation: 'wr_group', mentions_me: true }), 'bot')?.addressed).toBe('mention')
  })
})

describe('wecom poll round', () => {
  it('takes in what the bridge holds after the cursor, once, and moves the cursor after it', async () => {
    const h = host()
    queue(h, () => ({ me: 'bot', items: [message('m1'), { id: 'broken' }, message('m2', { conversation: 'wr_elsewhere' })], next: 3 }))
    expect(await pollWecom(h.ctx, new AbortController().signal)).toEqual({ read: 3, unreadable: 1 })
    expect(await h.receive.mock.results[0]!.value).toBe('stored')
    expect(await h.receive.mock.results[1]!.value).toBe('filtered')
    expect(h.store.get(KV.wecom.cursor)).toBe(3)
    // An allowed sender's single-chat message makes an explicit request.
    expect(h.engine.candidate(key('wecom', 'm1'))?.strength).toBe('explicit')
    await pollWecom(h.ctx, new AbortController().signal)
    expect(await h.receive.mock.results[2]!.value).toBe('duplicate')
    h.store.close()
  })
  it('keeps its cursor when a round stops during the read', async () => {
    const h = host()
    queue(h, () => ({ me: 'bot', items: [message('m1'), message('m2')], next: 2 }))
    h.receive.mockImplementationOnce(async () => { throw new Error('stopped') })
    await expect(pollWecom(h.ctx, new AbortController().signal)).rejects.toThrow('stopped')
    expect(h.store.get(KV.wecom.cursor)).toBeUndefined()
    h.store.close()
  })
})

describe('wecom channel', () => {
  it('sends a reply once through the bridge CLI in the address', async () => {
    const h = host()
    const run = vi.spyOn(h.commands, 'run').mockResolvedValue('✓ 已回复')
    const trigger = wecomTrigger(message('m1'), 'bot', CLI)!
    const sent = await sendWecom(h, { id: 'n1', channel: trigger.channel!, text: 'done', kind: 'reply' })
    expect(sent).toBe('sent')
    expect(run).toHaveBeenCalledWith(CLI, ['reply', '--conversation', 'wo_user', '--to', 'm1', '--key', 'n1', '--text', 'done'])
    h.store.close()
  })
  it('throws for a failed delivery so the Outbox retries', async () => {
    const h = host()
    vi.spyOn(h.commands, 'run').mockRejectedValue(commandError({ stderr: '{"error":{"code":1,"message":"发送超时（20s）"}}', code: 1 }))
    const trigger = wecomTrigger(message('m1'), 'bot', CLI)!
    await expect(sendWecom(h, { id: 'n1', channel: trigger.channel!, text: 'done', kind: 'reply' })).rejects.toThrow('发送超时（20s）')
    h.store.close()
  })
})

describe('wecom thread context', () => {
  it('reads a page of the conversation and its next cursor', async () => {
    const h = host()
    const trigger = wecomTrigger(message('m2'), 'bot')!
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
      expect(args).toEqual(['thread', '--conversation', 'wo_user', '--root', 'wo_user', '--json', '--after', '1'])
      return JSON.stringify({ items: [message('m1'), message('m2')], next: '2' })
    })
    const page = await wecomKind.threadContext!.read(h.commands, trigger, 'thread', '1', h.ctx.config<WecomConfig>('wecom')!)
    expect(page.messages).toEqual([
      { id: 'm1', from: 'wo_alice', at: '2026-11-11T10:00:00+08:00', text: 'hello' },
      { id: 'm2', from: 'wo_alice', at: '2026-11-11T10:00:00+08:00', text: 'hello' }])
    expect(page.next).toBe('2')
    expect(wecomKind.threadContext!.messageId(trigger)).toBe('m2')
    h.store.close()
  })
})

describe('wecom policy', () => {
  it('lists each configured conversation as an admission row', () => {
    const rows = wecomKind.policy!.rows!({ cli: CLI, conversations: [{ id: 'wo_user', listen: 'all' }, { id: 'wr_team', listen: 'mentions' }], pollSeconds: 15 })
    expect(rows.map(row => [row.id, row.cells.listedUnaddressed, row.cells.unlistedAddressed])).toEqual([
      ['wo_user', true, true], ['wr_team', false, true]])
  })
})
