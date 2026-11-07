/**
 * governance.mjs —— 证据约束账本的行为测试。
 *
 * 测的是「会抓到坏行为」的那几件事，不是源码里有没有某行字：
 * 必核清单不泄漏笔记内容、指标分母口径、TTL 只结算不判漏查、
 * 重启缺行只排除、关闭观察真停记、字段白名单、重复事件去重。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GOVERNANCE_FIELDS,
  RULE_FAMILIES,
  DEFAULT_TTL_SECONDS,
  buildRequiredChecks,
  createGovernance,
} from '../lib/governance.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = JSON.parse(readFileSync(path.join(ROOT, 'docs/契约-stage0/samples/context.sample-cache.json'), 'utf8'))
const schema = JSON.parse(readFileSync(path.join(ROOT, 'docs/契约-stage0/knowledge-gateway.v1.schema.json'), 'utf8'))
const tmp = mkdtempSync(path.join(tmpdir(), 'wiki-gov-'))

let serial = 0
let total = 0
let failed = 0
function ok(name, fn) {
  total += 1
  try {
    fn()
  } catch (error) {
    failed += 1
    console.error(`✗ ${name} — ${error?.message ?? error}`)
  }
}

function makeGov(overrides = {}) {
  const file = path.join(tmp, `g-${++serial}.jsonl`)
  let t = 1780000000000
  const gov = createGovernance({
    file,
    enabled: true,
    bootRef: overrides.bootRef ?? 'boot_a',
    sessionScope: 'sess',
    ttlSeconds: overrides.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    pendingMax: overrides.pendingMax ?? PENDING_MAX_FOR_TEST,
    now: () => t,
  })
  return { gov, file, advance: (ms) => { t += ms } }
}
const PENDING_MAX_FOR_TEST = 512

function ctx(id) {
  return { ...fixture, context_id: id, observe_id: `obs_${id}` }
}
function verify(status, extra = {}) {
  return { kind: 'verify', status, violations: [], ...extra }
}

// 1. 必核清单：规则族来自 schema 枚举子集
ok('RULE_FAMILIES 是冻结契约 violation.type.enum 的子集', () => {
  const allowed = schema.$defs.violation.properties.type.enum
  for (const family of RULE_FAMILIES) assert.ok(allowed.includes(family), `${family} 不在 schema 枚举里`)
})

// 2. 必核清单：只从证据派生，不把页面/引文/具体数值写进新增段
ok('必核清单从虚构 Context 派生，且不泄漏页面、引文、数值', () => {
  const checks = buildRequiredChecks(fixture)
  assert.ok(checks.count > 0, '有证据却没生成清单')
  assert.equal(checks.support, 'partial')
  assert.equal(checks.count, checks.lines.length - 1, '第一行是标题，其余每行一个清单项')
  for (const family of ['unsupported_numeric_claim', 'conditional_limit_missing', 'fabricated_quote', 'gap_not_disclosed', 'duplicate_as_independent']) {
    assert.ok(checks.families.includes(family), `该命中的规则族没命中：${family}`)
  }
  for (const family of ['unresolved_disclosure_missing', 'unresolved_arbitrated', 'conclusion_without_evidence']) {
    assert.ok(!checks.families.includes(family), `不该命中的规则族命中了：${family}`)
  }
  const text = checks.lines.join('\n')
  for (const page of fixture.evidence ?? []) {
    if (page.page) assert.ok(!text.includes(String(page.page)), '清单泄漏了页面路径')
    if (page.title) assert.ok(!text.includes(String(page.title)), '清单泄漏了页面标题')
  }
  for (const item of fixture.evidence_items ?? []) {
    if (item.quote) assert.ok(!text.includes(String(item.quote)), '清单泄漏了引文原文')
  }
  assert.ok(!/\d+\s*(秒|分|%|字|道)/.test(text), '清单写了具体数值')
})

// 3. 错误信封与空值不生成清单
ok('错误信封 / 空值不生成必核清单', () => {
  assert.equal(buildRequiredChecks({ kind: 'error', error: { code: 'E_X' } }).count, 0)
  assert.equal(buildRequiredChecks(null).count, 0)
})

// 4. Context→Verify 链：三项指标按各自口径算
ok('一条完整核验链：触发率 / 违规发现率 / 覆盖率 / 收敛诊断', () => {
  const { gov } = makeGov()
  gov.recordContext(ctx('ctx_A1'))
  gov.recordVerify('ctx_A1', verify('violations_found', { violations: [{ type: 'unsupported_numeric_claim' }] }))
  gov.recordVerify('ctx_A1', verify('ok'))
  const s = gov.stats({ days: 7 })
  assert.equal(s.state, 'ok')
  assert.equal(s.observe_enabled, true)
  const trigger = s.metrics.required_check_verification_trigger_rate
  assert.equal(trigger.denominator, 1)
  assert.equal(trigger.numerator, 1)
  assert.equal(trigger.value, 1)
  assert.equal(trigger.groups.partial_insufficient.denominator, 1)
  assert.equal(trigger.groups.partial_insufficient.numerator, 1)
  const discovery = s.metrics.effective_verify_violation_discovery_rate
  assert.equal(discovery.denominator, 2, '按 Verify 调用次数，不按违规条数')
  assert.equal(discovery.numerator, 1)
  assert.equal(discovery.value, 0.5)
  assert.equal(s.metrics.observation_coverage.denominator, 1)
  assert.equal(s.metrics.observation_coverage.numerator, 1)
  assert.equal(s.convergence.metric, '观察到的核验链收敛率')
  assert.equal(s.convergence.converged, 1)
  assert.equal(s.convergence.unresolved, 0)
  assert.equal(s.convergence.not_rechecked, 0)
  assert.equal(s.assertion_measurement.state, 'unavailable')
  assert.equal(s.assertion_measurement.assertion_count, null, '未知不能写成 0')
})

// 5. 不可用 Verify：调用级排除，不整体排除 Context
ok('不可用 Verify 进调用级排除，不进违规率分母，也不踢掉 Context', () => {
  const { gov } = makeGov()
  gov.recordContext(ctx('ctx_B1'))
  gov.recordVerify('ctx_B1', verify('context_missing', { error: { code: 'E_CONTEXT_NOT_FOUND' } }))
  const s = gov.stats({ days: 7 })
  assert.equal(s.excluded.verify_calls.context_missing, 1)
  assert.equal(s.metrics.effective_verify_violation_discovery_rate.denominator, 0)
  assert.equal(s.metrics.effective_verify_violation_discovery_rate.value, null)
  assert.equal(s.metrics.required_check_verification_trigger_rate.denominator, 1, 'Context 仍是有效样本')
  assert.equal(s.metrics.required_check_verification_trigger_rate.numerator, 0)
})

// 6. TTL 到期只结算，不冒充漏查；迟到 Verify 单列且不回退
ok('TTL 到期记 expired、迟到 Verify 不回退也不进触发率分子', () => {
  const { gov, advance } = makeGov({ ttlSeconds: 10 })
  gov.recordContext(ctx('ctx_C1'))
  advance(11000)
  gov.recordVerify('ctx_C1', verify('ok'))
  const s = gov.stats({ days: 7 })
  assert.equal(s.excluded.late_verify, 1)
  assert.equal(s.metrics.required_check_verification_trigger_rate.denominator, 1, 'expired 留在触发率分母')
  assert.equal(s.metrics.required_check_verification_trigger_rate.numerator, 0, 'expired 不进确认漏查分子')
  assert.equal(s.metrics.observation_coverage.numerator, 1, 'expired 是明确生命周期结算')
  assert.equal(s.metrics.effective_verify_violation_discovery_rate.denominator, 0, '迟到 Verify 不进违规率分母')
})

// 7. 重启：旧 boot_ref 无结算无中断标记 → 只排除，不补造中断
ok('重启后旧 boot_ref 样本归 unobserved，不推导 completed/expired/interrupted', () => {
  const file = path.join(tmp, 'g-restart.jsonl')
  const fixed = () => 1780000000000
  const govA = createGovernance({ file, bootRef: 'boot_a', sessionScope: 's', now: fixed, ttlSeconds: 1800 })
  govA.recordContext(ctx('ctx_D1'))
  const govB = createGovernance({ file, bootRef: 'boot_b', sessionScope: 's', now: fixed, ttlSeconds: 1800 })
  const s = govB.stats({ days: 7 })
  assert.equal(s.excluded.context_samples.restart_not_observed, 1)
  assert.equal(s.metrics.required_check_verification_trigger_rate.denominator, 0, 'unobserved 不进行为合规率分母')
  assert.equal(s.metrics.observation_coverage.denominator, 1, '但要在覆盖率分母里显出来')
  assert.equal(s.metrics.observation_coverage.numerator, 0)
  assert.equal(s.convergence.converged, 0)
  assert.ok(s.metrics.observation_coverage.exclude_reasons.includes('restart_not_observed'))
})

// 8. 容量淘汰也是 unobserved，不是 interrupted
ok('容量淘汰标 unobserved/capacity，不伪造 interrupted', () => {
  const { gov } = makeGov({ pendingMax: 1 })
  gov.recordContext(ctx('ctx_E1'))
  gov.recordContext(ctx('ctx_E2'))
  const s = gov.stats({ days: 7 })
  assert.equal(s.excluded.context_samples.capacity, 1)
  assert.equal(s.excluded.context_samples.restart_not_observed, 0)
})

// 9. 关闭观察：停记 + 不可用状态，不返回三个零
ok('关闭观察后停记，指标是不可用而不是 0', () => {
  const { gov } = makeGov()
  gov.setEnabled(false)
  assert.equal(gov.recordContext(ctx('ctx_F1')), null)
  const s = gov.stats({ days: 7 })
  assert.equal(s.state, 'disabled')
  assert.equal(s.observe_enabled, false)
  for (const key of ['required_check_verification_trigger_rate', 'effective_verify_violation_discovery_rate', 'observation_coverage']) {
    assert.equal(s.metrics[key].value, null)
    assert.equal(s.metrics[key].numerator, null)
    assert.equal(s.metrics[key].denominator, null)
  }
})

// 10. clear 破坏性清空，重开不补造历史
ok('clear 清掉账本、pending 与统计，重开从空周期开始', () => {
  const { gov, file } = makeGov()
  gov.recordContext(ctx('ctx_G1'))
  gov.clear()
  const s = gov.stats({ days: 7 })
  assert.equal(s.metrics.observation_coverage.denominator, 0)
  assert.equal(existsSync(file), true)
  assert.equal(readFileSync(file, 'utf8'), '')
  assert.equal(gov.pendingSize(), 0)
})

// 11. 字段白名单 + 当前不产生 no_assertion
ok('账本只写白名单字段，且从不产生 no_assertion 样本', () => {
  const { gov, file } = makeGov()
  gov.recordContext(ctx('ctx_H1'))
  gov.recordVerify('ctx_H1', verify('context_expired'))
  gov.recordVerify('ctx_H1', verify('exec_failed'))
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
  assert.ok(lines.length >= 3)
  for (const line of lines) {
    const row = JSON.parse(line)
    for (const key of Object.keys(row)) assert.ok(GOVERNANCE_FIELDS.includes(key), `字段 ${key} 不在白名单`)
    assert.notEqual(row.verify_unusable_reason, 'no_assertion')
  }
  const s = gov.stats({ days: 7 })
  assert.equal(s.excluded.verify_calls.no_assertion, undefined, '报表不展示 no_assertion 分类')
})

// 12. 同一事件重复到达不重复计数
ok('event_id 去重：文件里重复的行不把样本算两遍', () => {
  const { gov, file } = makeGov()
  gov.recordContext(ctx('ctx_I1'))
  const text = readFileSync(file, 'utf8')
  writeFileSync(file, text + text)
  const s = gov.stats({ days: 7 })
  assert.equal(s.metrics.observation_coverage.denominator, 1)
})

// 13. attempt_seq 重启后从账本恢复，不重放冲突
ok('重启后 attempt_seq 从账本 max 继续递增', () => {
  const file = path.join(tmp, 'g-seq.jsonl')
  const fixed = () => 1780000000000
  const govA = createGovernance({ file, bootRef: 'boot_a', sessionScope: 's', now: fixed, ttlSeconds: 1800 })
  govA.recordContext(ctx('ctx_J1'))
  govA.recordVerify('ctx_J1', verify('violations_found'))
  const govB = createGovernance({ file, bootRef: 'boot_b', sessionScope: 's', now: fixed, ttlSeconds: 1800 })
  const ev = govB.recordVerify('ctx_J1', verify('ok'))
  assert.equal(ev.attempt_seq, 2)
})

// 14. not_rechecked 不等于拒绝修正
ok('首次违规后没有后续有效复核 → not_rechecked，不是 unresolved', () => {
  const { gov } = makeGov()
  gov.recordContext(ctx('ctx_K1'))
  gov.recordVerify('ctx_K1', verify('violations_found'))
  gov.recordVerify('ctx_K1', verify('context_missing'))
  const s = gov.stats({ days: 7 })
  assert.equal(s.convergence.not_rechecked, 1)
  assert.equal(s.convergence.unresolved, 0)
  assert.equal(s.convergence.converged, 0)
})

rmSync(tmp, { recursive: true, force: true })
console.log(`[governance] ${total - failed}/${total} 通过`)
if (failed > 0) process.exit(1)
