/**
 * governance.js —— 插件侧的证据约束账本。
 *
 * 为什么单独一个文件：它既要从 Context 派生「本次回答必须核验」清单，
 * 又要记住「哪份 Context 被核过、哪份只是超时没等到后续」。
 * 两件事共用同一批最小化字段，放一起才不会各说各话。
 *
 * 三条硬纪律（来自已复审的设计稿，不许改）：
 *   1. 生命周期状态与样本处置状态是两个维度。重启后没有持久化中断标记，
 *      只能 excluded / unobserved，不能补造 interrupted / completed / 漏查。
 *   2. 字段只在白名单里：ID、时间、状态、违规类型、父子关联、计数。
 *      回答原文、引文、页面路径、具体数值一律不进账本。
 *   3. Python Gateway v1 冻结。这里只读插件自己拿到的 Context / Verify
 *      返回体，不改管线、不改 schema、不读 Python 快照内部。
 */
import { createHash } from 'node:crypto'
import { createJsonlStore } from './jsonl-store.js'

/** 事件账本只认这 18 个字段。 */
export const GOVERNANCE_FIELDS = [
  'ts', 'boot_ref', 'session_ref', 'event_id', 'kind', 'context_id',
  'parent_observe_id', 'lifecycle', 'disposition', 'exclude_reason',
  'support', 'required_check_count', 'verify_unusable_reason', 'status',
  'reason', 'violation_types', 'attempt_seq', 'ttl_seconds',
]

/** 冻结契约里 violation.type 的 11 个枚举；本模块的规则族只能取子集。 */
export const RULE_FAMILIES = [
  'conditional_limit_missing',
  'answered_unfilled_slot',
  'gap_not_disclosed',
  'unresolved_disclosure_missing',
  'unresolved_arbitrated',
  'review_flag_missing',
  'duplicate_as_independent',
  'fabricated_quote',
  'conclusion_without_evidence',
  'unsupported_numeric_claim',
  'numeric_check_failed',
]

/** 当前冻结契约下可产生的 Verify 不可用原因。 */
const VERIFY_UNUSABLE_REASONS = ['context_missing', 'context_expired', 'context_corrupt', 'exec_failed']
/** no_assertion 是兼容性保留值：当前不可产生、不计数、不展示。 */
const EFFECTIVE_STATUSES = new Set(['ok', 'violations_found'])
const RISK_SUPPORTS = new Set(['partial', 'insufficient'])

export const DEFAULT_TTL_SECONDS = 1800
export const PENDING_MAX = 512

function pad(value) {
  return String(value).padStart(2, '0')
}

/** 本地时间戳，和调用账本同一套时区。 */
function stamp(ms) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function shortHash(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 12)
}

function randomBootRef() {
  return `boot_${shortHash(`${Date.now()}|${Math.random()}`)}`
}

function clampDays(days) {
  const value = Number(days)
  return Number.isFinite(value) && value > 0
    ? Math.min(3650, Math.max(1, Math.trunc(value)))
    : 7
}

function clampTtl(seconds) {
  const value = Number(seconds)
  return Number.isFinite(value) && value > 0
    ? Math.max(1, Math.trunc(value))
    : DEFAULT_TTL_SECONDS
}

function clampPendingMax(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : PENDING_MAX
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value !== ''))]
}

function hasNumericValues(values) {
  if (Array.isArray(values)) {
    return values.some((value) => typeof value === 'number' || (typeof value === 'string' && /\d/.test(value)))
  }
  if (values !== null && typeof values === 'object') {
    return Object.values(values).some((value) => typeof value === 'number' || (typeof value === 'string' && /\d/.test(value)))
  }
  return false
}

function idsText(ids) {
  const clean = ids.filter((value) => typeof value === 'string' && value !== '')
  if (clean.length === 0) return '未提供编号'
  const shown = clean.slice(0, 4).join('、')
  return clean.length > 4 ? `${shown} 等` : shown
}

function pickEvent(event) {
  const out = {}
  for (const key of GOVERNANCE_FIELDS) {
    if (event[key] !== undefined) out[key] = event[key]
  }
  return out
}

/**
 * 从一份 Context 返回体派生「本次回答必须核验」清单。
 *
 * 只从 evidence / evidence_items / missing / unresolved / conflicts /
 * status / answer.constraints 读；不重新推断事实，不制造新证据。
 * 新增清单段只列槽位 id、evidence_id、计数、规则族，不含数值、引文、
 * 页面路径、页面标题。
 */
export function buildRequiredChecks(value) {
  const title = '本次回答必须核验'
  const empty = { count: 0, support: '', lines: [title], families: [] }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return empty
  if (value.kind === 'error' || value.kind !== 'context') return empty

  const status = value.status && typeof value.status === 'object' ? value.status : {}
  const support = typeof status.support === 'string' ? status.support : ''
  const evidence = asArray(value.evidence)
  const evidenceItems = asArray(value.evidence_items)
  const supports = evidence.flatMap((page) => asArray(page.supports))
  const missing = asArray(value.missing)
  const unresolved = asArray(value.unresolved)
  const conflicts = asArray(value.conflicts)
  const constraints = value.answer && typeof value.answer === 'object' && value.answer.constraints
    && typeof value.answer.constraints === 'object' ? value.answer.constraints : {}

  const items = []
  const families = []
  function add(ruleFamilies, line) {
    items.push(line)
    families.push(...ruleFamilies)
  }

  // 1. 数值类：numeric 槽，或 supports[].values 里带数值。
  const numericItems = evidenceItems.filter((item) => item.slot === 'numeric' || hasNumericValues(item.values))
  const numericSupports = supports.filter((item) => item.slot === 'numeric' || hasNumericValues(item.values))
  if (numericItems.length > 0 || numericSupports.length > 0) {
    const count = numericItems.length || numericSupports.length
    const ids = idsText(numericItems.map((item) => item.evidence_id))
    add(
      ['unsupported_numeric_claim', 'numeric_check_failed'],
      `- 数值类证据单元：${count} 项（${ids}）· 槽位：numeric · 规则族：unsupported_numeric_claim / numeric_check_failed`,
    )
  }

  // 2. 条件限定：quote_support === 'conditional'。
  const conditionalCount = supports.filter((item) => item.quote_support === 'conditional').length
  if (conditionalCount > 0) {
    add(['conditional_limit_missing'], `- 条件限定支撑：${conditionalCount} 项 · 规则族：conditional_limit_missing`)
  }

  // 3. 引文型：evidence_items[].quote 非空。
  const quoted = evidenceItems.filter((item) => typeof item.quote === 'string' && item.quote.trim() !== '')
  if (quoted.length > 0) {
    add(['fabricated_quote'], `- 引文型证据单元：${quoted.length} 项 · 规则族：fabricated_quote`)
  }

  // 4. 缺口与未填槽位：missing 非空，或支持度 partial / insufficient。
  if (missing.length > 0 || RISK_SUPPORTS.has(support)) {
    add(
      ['gap_not_disclosed', 'answered_unfilled_slot'],
      `- 缺口披露：支持度 ${support || '未标注'}、明确缺口 ${missing.length} 项 · 规则族：gap_not_disclosed / answered_unfilled_slot`,
    )
  }

  // 5. 单页多引擎：仅限 page_count === 1 && engine_count >= 2。
  const duplicate = evidenceItems.filter((item) => Number(item.page_count) === 1 && Number(item.engine_count) >= 2)
  if (duplicate.length > 0) {
    add(['duplicate_as_independent'], `- 单页多引擎来源：${duplicate.length} 项 · 规则族：duplicate_as_independent`)
  }

  // 6. 复核标记：某个槽位的支撑全部 needs_review。
  const bySlot = new Map()
  for (const item of supports) {
    const slot = typeof item.slot === 'string' ? item.slot : ''
    if (!bySlot.has(slot)) bySlot.set(slot, [])
    bySlot.get(slot).push(item)
  }
  const reviewSlots = [...bySlot.entries()]
    .filter(([, list]) => list.length > 0 && list.every((item) => item.needs_review === true))
    .map(([slot]) => slot)
  if (reviewSlots.length > 0) {
    add(['review_flag_missing'], `- 复核标记：槽位 ${reviewSlots.join('、')} 的支撑需复核 · 规则族：review_flag_missing`)
  }

  // 7. 未裁决与冲突。
  if (unresolved.length > 0 || conflicts.length > 0) {
    add(
      ['unresolved_disclosure_missing', 'unresolved_arbitrated'],
      `- 未裁决与冲突：${unresolved.length + conflicts.length} 项 · 规则族：unresolved_disclosure_missing / unresolved_arbitrated`,
    )
  }

  // 8. 零证据结论。
  if (support === 'insufficient' && evidenceItems.length === 0) {
    add(['conclusion_without_evidence'], '- 零证据结论：不得在无证据单元时下结论 · 规则族：conclusion_without_evidence')
  }

  // 9. 回答约束本身也是必核项，但不引入新事实。
  const constraintFlags = []
  if (constraints.must_disclose_gaps === true) constraintFlags.push('必须披露缺口')
  if (constraints.must_preserve_sources === true) constraintFlags.push('保留来源')
  if (constraints.allow_inference === false) constraintFlags.push('不得推断')
  if (constraintFlags.length > 0) {
    add(['gap_not_disclosed'], `- 回答约束：${constraintFlags.join('、')} · 规则族：gap_not_disclosed`)
  }

  return {
    count: items.length,
    support,
    lines: [title, ...items],
    families: unique(families),
  }
}

function blankMetric() {
  return {
    numerator: null,
    denominator: null,
    value: null,
    effective_samples: null,
    excluded_count: null,
    exclude_reasons: [],
  }
}

function metric(numerator, denominator, excludedCount, excludeReasons) {
  return {
    numerator,
    denominator,
    value: denominator > 0 ? numerator / denominator : null,
    effective_samples: denominator,
    excluded_count: excludedCount,
    exclude_reasons: unique(excludeReasons),
  }
}

function disabledStats(days) {
  const trigger = blankMetric()
  trigger.groups = { partial_insufficient: blankMetric() }
  return {
    state: 'disabled',
    observe_enabled: false,
    window: { days: clampDays(days), since: null },
    message: '观察未启用，因此没有数据',
    metrics: {
      required_check_verification_trigger_rate: trigger,
      effective_verify_violation_discovery_rate: blankMetric(),
      observation_coverage: blankMetric(),
    },
    assertion_measurement: { state: 'unavailable', assertion_count: null, reason: 'contract_unavailable' },
    convergence: {
      metric: '观察到的核验链收敛率',
      converged: null,
      unresolved: null,
      not_rechecked: null,
    },
    excluded: {
      context_samples: { restart_not_observed: null, capacity: null },
      verify_calls: { context_missing: null, context_expired: null, context_corrupt: null, exec_failed: null },
      late_verify: null,
    },
  }
}

function computeConvergence(effectiveRows) {
  const groups = new Map()
  for (const row of effectiveRows) {
    const id = typeof row.context_id === 'string' ? row.context_id : ''
    if (id === '') continue
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(row)
  }
  let converged = 0
  let unresolved = 0
  let notRechecked = 0
  for (const rows of groups.values()) {
    rows.sort((a, b) => {
      const seqDiff = (Number(a.attempt_seq) || 0) - (Number(b.attempt_seq) || 0)
      if (seqDiff !== 0) return seqDiff
      const tsDiff = String(a.ts ?? '').localeCompare(String(b.ts ?? ''))
      if (tsDiff !== 0) return tsDiff
      return String(a.event_id ?? '').localeCompare(String(b.event_id ?? ''))
    })
    const firstViolation = rows.findIndex((row) => row.status === 'violations_found')
    if (firstViolation < 0) continue
    const after = rows.slice(firstViolation + 1)
    if (after.length === 0) {
      notRechecked += 1
      continue
    }
    const last = after[after.length - 1]
    if (last.status === 'ok') converged += 1
    else if (last.status === 'violations_found') unresolved += 1
    else notRechecked += 1
  }
  return {
    metric: '观察到的核验链收敛率',
    converged,
    unresolved,
    not_rechecked: notRechecked,
  }
}

/**
 * 建一份治理观察账本。
 *
 * `cycle()` 给调用方在发起异步工具调用前取周期号；`clear()` 或重新开启
 * 之后，旧周期号传回来会被丢弃 —— 关闭完成后旧观察周期不再落盘。
 */
export function createGovernance({
  file,
  enabled = true,
  bootRef,
  sessionScope,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  pendingMax = PENDING_MAX,
  now = () => Date.now(),
} = {}) {
  const store = createJsonlStore({ file })
  const currentBootRef = typeof bootRef === 'string' && bootRef !== '' ? bootRef : randomBootRef()
  const sessionRef = shortHash(sessionScope ?? 'unscoped')
  const ttl = clampTtl(ttlSeconds)
  const maxPending = clampPendingMax(pendingMax)

  let on = enabled !== false
  let warned = false
  let cycleRef = 1

  const pending = new Map()
  const seqByContext = new Map()
  const contextIds = new Set()
  const observeById = new Map()
  const expiredContexts = new Set()
  const capacityContexts = new Set()

  function nowMs() {
    const value = Number(now())
    return Number.isFinite(value) ? value : Date.now()
  }

  function warnOnce(error) {
    if (warned) return
    warned = true
    console.warn('[wiki-notes] 治理观察账本写不进文件，只保留在内存里：', error?.message ?? error)
  }

  function scanRows(rows) {
    const seen = new Set()
    const deduped = []
    for (const row of rows) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
      const id = typeof row.event_id === 'string' && row.event_id !== ''
        ? row.event_id
        : `${row.ts ?? ''}|${row.context_id ?? ''}|${row.kind ?? ''}|${row.attempt_seq ?? ''}`
      if (seen.has(id)) continue
      seen.add(id)
      deduped.push(row)
    }

    const contexts = new Map()
    const observeIds = new Map()
    const capacityRows = new Set()
    const expired = new Set()
    const completed = new Set()
    const effectiveVerifyRows = []
    const unusableRows = []
    const lateRows = []
    const seqs = new Map()

    function contextInfoFromRow(row) {
      const id = typeof row.context_id === 'string' ? row.context_id : ''
      if (id === '') return null
      return {
        contextId: id,
        ts: typeof row.ts === 'string' ? row.ts : stamp(nowMs()),
        bootRef: typeof row.boot_ref === 'string' && row.boot_ref !== '' ? row.boot_ref : currentBootRef,
        support: typeof row.support === 'string' ? row.support : '',
        requiredCheckCount: Number(row.required_check_count) > 0 ? Math.trunc(Number(row.required_check_count)) : 0,
        observeId: typeof row.parent_observe_id === 'string' ? row.parent_observe_id : null,
        disposition: row.disposition === 'unobserved' ? 'unobserved' : 'included',
        lifecycle: row.lifecycle === 'expired' || row.lifecycle === 'completed' ? row.lifecycle : 'pending',
      }
    }

    // 先放 Context 创建事件，再补只有结算/淘汰事件、没有创建行的极端情况。
    for (const row of deduped) {
      if (row.kind !== 'context') continue
      const info = contextInfoFromRow(row)
      if (info === null || contexts.has(info.contextId)) continue
      contexts.set(info.contextId, info)
      observeIds.set(info.contextId, info.observeId)
    }
    for (const row of deduped) {
      if (row.kind !== 'expired' && row.kind !== 'capacity') continue
      const info = contextInfoFromRow(row)
      if (info === null || contexts.has(info.contextId)) continue
      contexts.set(info.contextId, info)
      observeIds.set(info.contextId, info.observeId)
    }

    for (const row of deduped) {
      const id = typeof row.context_id === 'string' ? row.context_id : ''
      if (id === '') continue
      const seq = Number(row.attempt_seq)
      if (Number.isFinite(seq)) seqs.set(id, Math.max(seqs.get(id) ?? 0, Math.trunc(seq)))

      if (row.kind === 'capacity' || row.exclude_reason === 'capacity') capacityRows.add(id)
      if (row.kind === 'expired' || row.lifecycle === 'expired') expired.add(id)

      if (row.kind !== 'verify') continue
      if (row.reason === 'late_verify') {
        lateRows.push(row)
        continue
      }
      if (row.verify_unusable_reason) {
        const reason = VERIFY_UNUSABLE_REASONS.includes(row.verify_unusable_reason)
          ? row.verify_unusable_reason
          : 'exec_failed'
        unusableRows.push({ ...row, verify_unusable_reason: reason })
        continue
      }
      if (row.reason === 'unobserved_context' || row.reason === 'unlinked') continue
      if (EFFECTIVE_STATUSES.has(row.status)) {
        effectiveVerifyRows.push(row)
        completed.add(id)
      }
    }

    const terminal = new Set([...completed, ...expired])
    for (const id of capacityRows) terminal.delete(id)
    const unobserved = new Map()
    for (const id of capacityRows) unobserved.set(id, 'capacity')
    for (const [id, info] of contexts) {
      if (unobserved.has(id)) continue
      if (info.bootRef !== currentBootRef && !terminal.has(id)) {
        unobserved.set(id, 'restart_not_observed')
      }
    }

    return {
      contexts,
      observeById: observeIds,
      capacityRows,
      expired,
      completed,
      terminal,
      unobserved,
      effectiveVerifyRows,
      unusableRows,
      lateRows,
      seqByContext: seqs,
    }
  }

  function makeEvent({
    kind,
    contextId,
    attemptSeq = 0,
    lifecycle = 'pending',
    disposition = 'included',
    excludeReason = null,
    support = null,
    requiredCheckCount = null,
    verifyUnusableReason = null,
    status = null,
    reason = null,
    violationTypes = [],
    parentObserveId = null,
    eventTtlSeconds = ttl,
  }) {
    const ts = stamp(nowMs())
    const eventId = `evt_${shortHash(`${contextId}|${kind}|${attemptSeq}|${ts}`)}`
    return pickEvent({
      ts,
      boot_ref: currentBootRef,
      session_ref: sessionRef,
      event_id: eventId,
      kind,
      context_id: contextId,
      parent_observe_id: parentObserveId,
      lifecycle,
      disposition,
      exclude_reason: excludeReason,
      support,
      required_check_count: requiredCheckCount,
      verify_unusable_reason: verifyUnusableReason,
      status,
      reason,
      violation_types: violationTypes,
      attempt_seq: attemptSeq,
      ttl_seconds: eventTtlSeconds,
    })
  }

  function appendEvent(event) {
    try {
      store.append(event)
      warned = false
    } catch (error) {
      // 账本是旁路。写不进去就留在内存 pending 里，绝不影响工具返回值。
      warnOnce(error)
      store.invalidate()
    }
    return event
  }

  function settleExpired() {
    const current = nowMs()
    for (const [contextId, info] of [...pending.entries()]) {
      if (current - info.createdAt < info.ttlSeconds * 1000) continue
      pending.delete(contextId)
      expiredContexts.add(contextId)
      appendEvent(makeEvent({
        kind: 'expired',
        contextId,
        attemptSeq: info.attemptSeq,
        lifecycle: 'expired',
        disposition: 'included',
        reason: 'ttl',
        support: info.support,
        requiredCheckCount: info.requiredCheckCount,
        parentObserveId: info.observeId,
        eventTtlSeconds: info.ttlSeconds,
      }))
    }
  }

  function evictCapacity() {
    while (pending.size > maxPending) {
      const oldest = pending.keys().next()
      if (oldest.done) break
      const contextId = oldest.value
      const info = pending.get(contextId)
      pending.delete(contextId)
      capacityContexts.add(contextId)
      appendEvent(makeEvent({
        kind: 'capacity',
        contextId,
        attemptSeq: info.attemptSeq,
        lifecycle: 'pending',
        disposition: 'unobserved',
        excludeReason: 'capacity',
        reason: 'capacity',
        support: info.support,
        requiredCheckCount: info.requiredCheckCount,
        parentObserveId: info.observeId,
        eventTtlSeconds: info.ttlSeconds,
      }))
    }
  }

  function recordContext(value, cycle = cycleRef) {
    if (!on || cycle !== cycleRef) return null
    settleExpired()
    if (value === null || typeof value !== 'object' || value.kind !== 'context') return null
    const contextId = typeof value.context_id === 'string' ? value.context_id : ''
    if (contextId === '') return null

    const checks = buildRequiredChecks(value)
    const observeId = typeof value.observe_id === 'string' ? value.observe_id : null
    const attemptSeq = Math.max(0, (seqByContext.get(contextId) ?? -1) + 1)
    seqByContext.set(contextId, attemptSeq)
    contextIds.add(contextId)
    observeById.set(contextId, observeId)

    const event = appendEvent(makeEvent({
      kind: 'context',
      contextId,
      attemptSeq,
      lifecycle: 'pending',
      disposition: 'included',
      support: checks.support,
      requiredCheckCount: checks.count,
      parentObserveId: observeId,
      eventTtlSeconds: ttl,
    }))

    pending.set(contextId, {
      createdAt: nowMs(),
      ttlSeconds: ttl,
      attemptSeq,
      support: checks.support,
      requiredCheckCount: checks.count,
      observeId,
    })
    evictCapacity()
    return event
  }

  function recordVerify(contextId, value, cycle = cycleRef) {
    if (!on || cycle !== cycleRef) return null
    if (typeof contextId !== 'string' || contextId === '') return null
    settleExpired()

    const scan = scanRows(store.readAllRows())
    const status = typeof value?.status === 'string' ? value.status : ''
    const effective = EFFECTIVE_STATUSES.has(status)
    const unusableReason = effective
      ? null
      : (VERIFY_UNUSABLE_REASONS.includes(status) ? status : 'exec_failed')
    const eventStatus = effective ? status : unusableReason
    const violationTypes = asArray(value?.violations)
      .map((item) => (item && typeof item === 'object' ? item.type ?? item.rule : null))
      .filter((type) => typeof type === 'string' && RULE_FAMILIES.includes(type))

    const seqBase = Math.max(seqByContext.get(contextId) ?? 0, scan.seqByContext.get(contextId) ?? 0)
    const attemptSeq = seqBase + 1
    seqByContext.set(contextId, attemptSeq)

    const hasContext = scan.contexts.has(contextId) || contextIds.has(contextId)
    const isExpired = scan.expired.has(contextId) || expiredContexts.has(contextId)
    const isUnobserved = scan.unobserved.has(contextId)
    const observeId = scan.observeById.get(contextId)
      ?? observeById.get(contextId)
      ?? pending.get(contextId)?.observeId
      ?? null
    const support = scan.contexts.get(contextId)?.support ?? pending.get(contextId)?.support ?? null
    const requiredCheckCount = scan.contexts.get(contextId)?.requiredCheckCount
      ?? pending.get(contextId)?.requiredCheckCount
      ?? 0
    const eventTtlSeconds = pending.get(contextId)?.ttlSeconds ?? ttl

    let reason = null
    if (isExpired && effective) reason = 'late_verify'
    else if (!effective) reason = 'verify_unusable'
    else if (isUnobserved) reason = 'unobserved_context'
    else if (!hasContext) reason = 'unlinked'

    const lifecycle = isExpired
      ? 'expired'
      : effective
        ? 'completed'
        : scan.terminal.has(contextId)
          ? (scan.expired.has(contextId) ? 'expired' : 'completed')
          : 'pending'
    const disposition = isUnobserved ? 'unobserved' : 'included'
    const excludeReason = isUnobserved ? scan.unobserved.get(contextId) ?? null : null

    const event = appendEvent(makeEvent({
      kind: 'verify',
      contextId,
      attemptSeq,
      lifecycle,
      disposition,
      excludeReason,
      support,
      requiredCheckCount,
      verifyUnusableReason: unusableReason,
      status: eventStatus,
      reason,
      violationTypes,
      parentObserveId: observeId,
      eventTtlSeconds,
    }))

    if (effective && !isExpired && !isUnobserved && hasContext && pending.has(contextId)) {
      pending.delete(contextId)
    }
    return event
  }

  function stats({ days = 7 } = {}) {
    if (!on) return disabledStats(days)
    settleExpired()
    const daysNum = clampDays(days)
    const cutoff = nowMs() - daysNum * 86400000
    const scan = scanRows(store.readAllRows())

    // 文件写失败时，当前进程仍要看得见内存里的 pending。
    for (const [contextId, info] of pending.entries()) {
      if (scan.contexts.has(contextId)) continue
      scan.contexts.set(contextId, {
        contextId,
        ts: stamp(info.createdAt),
        bootRef: currentBootRef,
        support: info.support,
        requiredCheckCount: info.requiredCheckCount,
        observeId: info.observeId,
        disposition: 'included',
        lifecycle: 'pending',
      })
      scan.observeById.set(contextId, info.observeId)
    }

    function inWindow(row) {
      const parsed = Date.parse(String(row?.ts ?? ''))
      return Number.isFinite(parsed) ? parsed >= cutoff : true
    }

    const contextEntries = [...scan.contexts.values()].filter(inWindow)
    const unobservedInWindow = contextEntries.filter((info) => scan.unobserved.has(info.contextId))
    const includedContexts = contextEntries.filter((info) => !scan.unobserved.has(info.contextId))
    const requiredContexts = includedContexts.filter((info) => info.requiredCheckCount > 0)
    const groupContexts = requiredContexts.filter((info) => RISK_SUPPORTS.has(info.support))
    const effectiveRows = scan.effectiveVerifyRows.filter(inWindow)
    const effectiveByContext = new Set(effectiveRows.map((row) => row.context_id).filter(Boolean))
    const unusableRows = scan.unusableRows.filter(inWindow)
    const lateRows = scan.lateRows.filter(inWindow)

    const triggerNumerator = requiredContexts.filter((info) => effectiveByContext.has(info.contextId)).length
    const groupNumerator = groupContexts.filter((info) => effectiveByContext.has(info.contextId)).length
    const discoveryNumerator = effectiveRows.filter((row) => row.status === 'violations_found').length
    const coverageNumerator = includedContexts.filter((info) => scan.terminal.has(info.contextId)).length

    const excludedContextSamples = { restart_not_observed: 0, capacity: 0 }
    for (const info of unobservedInWindow) {
      const reason = scan.unobserved.get(info.contextId)
      if (reason === 'restart_not_observed') excludedContextSamples.restart_not_observed += 1
      else if (reason === 'capacity') excludedContextSamples.capacity += 1
    }
    const excludedVerifyCalls = { context_missing: 0, context_expired: 0, context_corrupt: 0, exec_failed: 0 }
    for (const row of unusableRows) {
      const reason = row.verify_unusable_reason
      if (Object.prototype.hasOwnProperty.call(excludedVerifyCalls, reason)) {
        excludedVerifyCalls[reason] += 1
      }
    }

    const triggerExcludedContexts = unobservedInWindow.filter((info) => info.requiredCheckCount > 0)
    const groupExcludedContexts = triggerExcludedContexts.filter((info) => RISK_SUPPORTS.has(info.support))
    const triggerReasons = triggerExcludedContexts.map((info) => scan.unobserved.get(info.contextId))
    const coverageReasons = unobservedInWindow.map((info) => scan.unobserved.get(info.contextId))
    const discoveryReasons = unusableRows
      .map((row) => row.verify_unusable_reason)
      .concat(lateRows.length > 0 ? ['late_verify'] : [])

    const triggerMetric = metric(
      triggerNumerator,
      requiredContexts.length,
      triggerExcludedContexts.length,
      triggerReasons,
    )
    triggerMetric.groups = {
      partial_insufficient: metric(
        groupNumerator,
        groupContexts.length,
        groupExcludedContexts.length,
        groupExcludedContexts.map((info) => scan.unobserved.get(info.contextId)),
      ),
    }

    return {
      state: 'ok',
      observe_enabled: true,
      window: { days: daysNum, since: stamp(cutoff) },
      message: '',
      metrics: {
        required_check_verification_trigger_rate: triggerMetric,
        effective_verify_violation_discovery_rate: metric(
          discoveryNumerator,
          effectiveRows.length,
          unusableRows.length + lateRows.length,
          discoveryReasons,
        ),
        observation_coverage: metric(
          coverageNumerator,
          contextEntries.length,
          unobservedInWindow.length,
          coverageReasons,
        ),
      },
      assertion_measurement: {
        state: 'unavailable',
        assertion_count: null,
        reason: 'contract_unavailable',
        note: '冻结契约无法可靠计数；不写 0、不写推断值、不展示百分比',
      },
      convergence: computeConvergence(effectiveRows),
      excluded: {
        context_samples: excludedContextSamples,
        verify_calls: excludedVerifyCalls,
        late_verify: lateRows.length,
      },
    }
  }

  function clear() {
    cycleRef += 1
    pending.clear()
    seqByContext.clear()
    contextIds.clear()
    observeById.clear()
    expiredContexts.clear()
    capacityContexts.clear()
    try {
      store.clear()
      warned = false
    } catch (error) {
      warnOnce(error)
      store.invalidate()
    }
  }

  function setEnabled(next) {
    const was = on
    on = next !== false
    if (was === false && on === true) {
      // 重新开启 = 新观察周期。旧周期里还没落盘的异步事件一律作废。
      cycleRef += 1
      pending.clear()
      seqByContext.clear()
      contextIds.clear()
      observeById.clear()
      expiredContexts.clear()
      capacityContexts.clear()
    }
  }

  const initial = scanRows(store.readAllRows())
  for (const [id, seq] of initial.seqByContext) seqByContext.set(id, seq)
  for (const id of initial.contexts.keys()) contextIds.add(id)
  for (const [id, value] of initial.observeById) observeById.set(id, value)
  for (const id of initial.expired) expiredContexts.add(id)
  for (const id of initial.capacityRows) capacityContexts.add(id)

  return {
    recordContext,
    recordVerify,
    stats,
    governanceStats: stats,
    setEnabled,
    enabled: () => on,
    clear,
    pendingSize: () => pending.size,
    cycle: () => cycleRef,
    bootRef: () => currentBootRef,
  }
}
