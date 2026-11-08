/**
 * quiet-ledger.mjs —— 测试不该往用户的账本里写东西。
 *
 * 设置页「调用记录」是给人看真实调用的。以前跑一次 `npm test` 会往里灌几百条
 * 假调用（每个 apply() 过的测试文件都会真的 record），结果那一页越长越像噪音，
 * 连「今天调了多少次库」都没法信。
 *
 * 插件本来就支持用环境变量把两份账本指到别处（`lib/index.js:304` 与 `:313`），
 * 所以测试只要在 apply() 之前把变量填上就行。这个模块就是那两行，
 * 由需要 apply() 的测试在**第一行** import。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'wiki-test-ledger-'))
process.env.DSH_WIKI_CALLS_LOG ||= join(dir, 'calls.jsonl')
process.env.DSH_WIKI_GOVERNANCE_LOG ||= join(dir, 'governance.jsonl')
