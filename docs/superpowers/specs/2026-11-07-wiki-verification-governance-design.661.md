# 证据约束机制设计（P1：Context 与 Verify 联动）

日期：2026-11-07 · 状态：**方向通过，五处定点修订已落盘，待最后一次针对性复审**（设计稿，未实现）· Q2 / Q3 / Q8 已拍板 · 复审决定与 m03601 定点修订已并入 · **实施未批准** · 规模：项目（插件侧中等改动 + 一份新测试）

> 修订说明 1：按 builder check 结论与用户三项拍板修订。实现代码冻结、不提交、不扩范围。下文凡出现「修订前 :NNN」均指 builder check 时那一版稿本的行号，用于追溯，不是当前文件行号。
> 修订说明 2（复审 m03499）：用户审完 433 行稿后给出「方向通过 / 当前稿暂不完整通过 / 待修订复审」，拍板 Q2 新旧指标并存分层、收敛诊断独立保留、其余设计原则通过，并列出**六处实现前置必修**与一条指标解释。本次只把这六处修正、两层指标、收敛命名、指标解释落进稿子；**没有推翻 A/B/C 结论、Q2/Q3/Q8 拍板、方案 A、Python Gateway v1 冻结、不新增工具**。实现代码仍冻结、不提交、不进入 writing-plans、不扩范围；本稿交用户复审确认后才算整体通过。
> 修订说明 3（m03601 定点修订）：只读兼容性核查证实「Verify 能证明逐项核验」与「断言数可确定计数」两个测量依据都不成立。按用户拍板，只改四项：必核项完成率 → 必核项 Context 核验触发率（含指标键）、`assertion_count` 标数据不可用、Verify 违规率采用 B → 有效 Verify 违规发现率、登记 `checked_rules` 契约与实现偏差。详见「用户拍板记录（m03601）」章节，**该章节优先于本稿其余表述**；其余已通过部分、Q2 / Q3 / Q8 决策、Python Gateway v1 冻结边界一律不变。实现代码、提交、范围继续冻结。
> 修订说明 4（m03712 复审后的五处定点收紧）：用户按七项清单逐行复审 657 行版后，批准且仅批准五处：① 给「有效 Verify」补正面定义；② `no_assertion` 明确定为**兼容性保留值**（不声称历史实际产生过该类样本），同步 L219 / L503 / L532；③ 清掉 L586「无可核验断言的 Verify」旧归类；④ 旧指标名称测试断言限定为现行 `governance` 指标键 / 报表展示名称 / UI 标签，历史决策记录不在检查范围内；⑤ 补全 `partial` / `insufficient` 分组的分母与分子公式。不重议 A/B/C、不重做 Q2/Q3/Q8、不改 Python 契约、不扩功能范围；实现代码、提交、范围继续冻结。

## 为什么

P0 已经把公开语料清理干净、1.4.3 发上线，但那解决的是「包里有什么」，不是「模型怎么用」。

实测四问的结论是：只有第一层有系统级硬触发，系统提示只点名 `wiki_recall`；7 个 Context 里 3 个从未核验，5 个 `partial` / `insufficient` 里仅 2 个走过 Verify；没有「未核验账目」，调用记录本身还被关过、清过；8 次 Verify 抓出多类违规，但只有一条完整收敛链。**`wiki_verify` 能发现错误（已有证据）≠ 它能持续改善最终回答（证据不足）**，这两件事不能混为一谈。

所以本轮不是再加一个工具，也不是调检索质量，而是把「应该核验」写成可执行规则，把「未核验」变成可观测事件。验收终点不是「工具正常」，而是五件事：模型知道何时必须取证 / 何时不能直接输出答案 / 插件能发现该核未核 / 能记录违规是否修正 / 能用连续实测数据判断机制有效。

## 目标

1. 四层触发提示：L1 总纲、L2 工具职责、L3 结果约束、L4 账本与指标反馈，各有明确边界。
2. `renderContext` 输出「本次回答必须核验」清单，只从本次 Context 已有的证据、缺口与适用范围中提取，不推断事实、不制造证据；清单的实际项目数量记进账本。
3. 插件侧 pending 账本：Context 创建登记、Verify 更新、TTL 结算；重启后缺结算行的样本独立排除，不补造。
4. 可见指标：每项指标独立定义有效样本群体，报告分子、分母、有效样本数、排除数量与排除原因、观察是否启用。
5. 调用账本稳定性：尊重 `calls.enabled` 的关闭意愿——关闭即破坏性清空，期间指标明确不可用而不是显示零。

## 非目标（本轮不做）

- 不新增第五个工具；`wiki_observe` 只扩返回字段。
- **不改 Python Gateway v1**：`knowledge-gateway.v1.schema.json`（只读、不改）、`wiki_context` / `wiki_verify` 对 Python 管线的调用契约、Python Context / Verify 快照结构与字段语义、Python 数值判据与证据裁决规则、`observe.py` 持久化格式及私有管线，全部冻结。
- 不改 `wiki_recall` 的分词、评分、排序；不改 `wiki_context` / `wiki_verify` / `wiki_observe` 的 parameters。
- 不实现「会话结束提前结算」：生命周期勘察已确认前提不成立（见「约束」）。
- 不做 P2–P7（槽位按需生成、Bigram、排序统一、增量索引、解析收敛、未调用审计）。
- 不为了指标强行打开 `calls.enabled`，不提供关闭后的隐式恢复机制，不重写 git 历史，不重发已发布 npm 版本。
- 不新增宿主级 pre-output 拦截能力；收敛指标只证明「观察到的核验链收敛」，不证明最终输出那版答案已被核验（见「指标与可见性」）。

## 反目标（技术上能跑也算失败）

- Context 列出「应该重要但本次没有证据」的必核项，让模型以为已经拿到了证据；或重新推断事实、制造新证据。
- Context 说要核验五项、Verify 实际只检查三项。
- **从日志缺行反推状态**：没有显式持久化证据就判 `interrupted` / `completed` / `expired`，或把 `expired` 统计成「模型确认漏查 / 确认违规」。
- 把 `unobserved / excluded` 样本悄悄从报表消失、填零、或算进分母；`disabled` 期间产生「有效观察样本」或以零违规计入统计。
- 关闭观察时显示「0 次违规、0 次漏查」；或切换勾选框不做提示就删掉用户数据。
- 覆盖率拿 Verify 总调用次数除以 Context 总调用次数；有效 Verify 违规发现率按违规条数而非 Verify 调用次数计算；把 `ok` 解释成「所有必核项都已核验」；把 `assertion_count` 未知写成 `0`。
- 账本写入完整回答、真实引文、绝对页面路径、裸会话 id、断言正文、清单正文；`error_envelope` 里塞额外键。
- **账本缺少 `required_check_count` 却照算必核项 Context 核验触发率**；把 `assertion_count` 未知误记为 `0`、拿违规条数 / `checked_rules` 冒充断言数量；把不同层级的排除原因混进同一个 `exclude_reason`；把 Verify 调用不可用当成排除整个 Context；把 `ok` 说成「所有必核项都已核验」。
- 把收敛指标命名为「最终回答正确率」「答案修正成功率」，或把 `converged` 解释成「最终输出已被证明可靠」。
- 为跨重启恢复把治理逻辑搬进 Python；或把 L1 全文复制进三份 description；或为动态指标往 system prompt 塞每步变化的数字；或用提示词制造核验器并不具备的核验能力。

## 约束（实测依据）

- 宿主 `ctx.systemPrompt.context()` 的 `text` 是函数，按每个拟议模型步骤重新求值；可承载稳定规则文本，但**不能**塞变化中的计数。工具 `description` 是静态字符串，宿主只提供 per-step 的 `when` 谓词控制工具是否出现，不改写描述文本。
- 生命周期：官方 `EVENT_API` 里没有 `session/end`、顶层 `turn/end`、`dispose`；`session/disposed` 是「已公告会话离开 store」（含 publication rollback，scope-filtered），`api-session/removed` 是离开 live Host registry，`workspace/session-stop` 只在归档准入时派发且不等待收敛，`ctx.on('dispose')` 查不到宿主发射器。持久 `turn/end` 是 `session/event` 携带的 SessionEventMap 事件，不是可直接 `ctx.on` 的顶层事件。会话 id 可由 `ctx.sessions.scopeOf(ctx)` 取得；工具 `exec` 拿不到 `turn` / `step` / 专用 `turnId`。⇒ **本阶段没有可靠的回合结束信号，TTL 到期是唯一 correctness 主路径。**
- 三层契约边界（用户 Q8 拍板，见下节）：Python Gateway v1 冻结；插件工具接口允许向后兼容的增量扩展；Prompt 与 Description 允许修改以增加治理规则，但不改变工具原有职责。
- 插件现状落点：
  - `lib/index.js:748-755` 已有 `ctx.systemPrompt?.context?.({ name:'wiki-notes:topics', order:240, interpolate:false, text: () => buildTopicText() })`；`lib/index.js:460-464` 注释明确不写页数，避免打掉前缀缓存。
  - `lib/config.js:200-213` `DEFAULT_PROMPT_CONFIG` / `PROMPT_MAX_CHARS = 600`，`prompt.enabled` / `override` / `extra` 是用户可改的主题词那一行。
  - `lib/index.js:203-227` `DESCRIPTION` 已经是一份硬触发文本模板；`lib/index.js:932-937`、`:979-983`、`:1025-1031` 三个网关 description 目前是建议句式。
  - `lib/index.js:782-824` `renderContext`；`:826-847` `renderVerify`；`:849-886` `renderObserve`。
  - `lib/index.js:889-925` `callBridge` 一处记网关三工具的调用；`:1057-1105` `wiki_recall` 自己记；`:656-675` 三条 `/calls` 路由；`:1003-1022` `wiki_verify.execute` 目前直接 `return callBridge(...)`，不读返回值。
  - `lib/calls.js:18` `CALL_FIELDS` 8 字段白名单；`:21-33` 截断 / 缓冲 / 轮转 / 尾部读取常量；`:138-244` `createCallLog`。
  - `lib/config.js:173-195` `DEFAULT_CALLS_CONFIG = { enabled: true, log: '' }`，`normalizeCallsConfig` 只认显式 `false`。
  - `lib/client.js:1405+` `WikiCallsSection` 已嵌在「知识库」页内页签（`lib/client.js:781`），不新开一级入口。
  - 契约 `docs/契约-stage0/knowledge-gateway.v1.schema.json:745-794` 给出 11 个 `violation.type`；`:299-368` `evidence_page`；`:369-415` `evidence_item`；`:416-439` `missing`；`:641-698` context 的 evidence / evidence_items / missing / unresolved / conflicts / answer；`:818-825` verify status 另含 `context_missing` / `context_expired` / `context_corrupt`。**本轮只读该文件做 CI 断言，不修改一个字符。**
  - 私有 Python 管线的 `observe.py:143-167` 只记 ID / 时间 / 状态 / 违规类型 / 计数，不记回答原文、引文、页面路径；`answer_policy.py` 与 `wiki_bridge.py` 的 `VALID_VIOLATION_TYPES` 是必核清单要对齐的规则族（**实现前人工逐项核对，见「测试」**）。
- 零运行时依赖；`engines.node >= 20.13.0`；`lib/client.js` 是手写 bundle，只能用 `React.createElement`；客户端改动要重启 DSH 才生效；CI 六格矩阵（node 20/22/24 × ubuntu/windows）不因本轮改动扩容。
- 仓库 `docs/` 整个进 npm 包：本设计稿与后续所有样例、测试查询词一律用虚构「星港缓存」语料，不写任何人的笔记主题、真实页面路径、本机绝对路径、用户名或凭据。

## 方案（用户已批准 A）

| 维度 | A 插件侧为主（选中） | B Python 侧 | C 混合 |
|---|---|---|---|
| 与现有职责边界 | 最一致：插件已掌握工具调用、调用记录、上下文渲染与状态返回 | 扩大 Python 职责 | 两侧交叉 |
| CI 可验证性 | 好：改动都在仓库内，六格矩阵覆盖 | 受私有管线限制，CI 拿不到 | 部分受限 |
| 数据隐私 | 沿用既有白名单 | 需重新审查契约 | 两侧都要审查 |
| 改动范围 | 最小 | 较大 | 最大 |
| 状态跨重启 | pending 不保留 | 可以 | 可以 |
| 长期维护 | 插件内闭环 | 双端契约要维护 | 最复杂 |

批准理由（用户原话口径）：治理逻辑应放在**实际执行工具调用、组织工具结果**的那一侧；跨重启恢复只是实现属性，不该反过来决定治理逻辑归属；现有调用日志已有追加写与轮转，优先复用。B 唯一明显优势是 pending 可随 Python 快照持久化，不足以抵消代价。C 两套都改、最复杂，也会把「不扩工具」的边界拉松。

不改 Python Gateway v1、不订阅不可靠的会话结束事件、不新增工具，是 A 的三条硬边界。

## 用户拍板记录（Q2 / Q3 / Q8，逐条照录，优先于本稿其余表述）

### Q2：指标分母口径 —— 按指标定义独立分母，不使用统一分母

> **口径沿革注记（m03601）**：本节表格与四条细则按 m03479 原始拍板逐条照录，其中「必核项完成率」「Verify 违规率」的名称，以及「成功完成、存在可核验断言的 Verify 次数」这一分母，均为当时的**历史口径**，已由 m03601 定点修订取代（现行名称、分母、分子见「用户拍板记录（m03601）」）。此处保留原文本作为历史记录，不作现行定义使用；本稿其余规范性章节已全部改用新口径。

不接受用「所有对话轮次」「所有工具调用」作为三个指标的统一分母；每项指标必须统计它真正有资格评价的样本。

| 指标类型 | 分母 | 分子 |
|---|---|---|
| 必核项完成率 | 观察启用期间，成功生成且包含必核项的有效 Context | 存在同一 `context_id` 对应的有效 Verify 完成记录 |
| Verify 违规率 | 成功完成、存在可核验断言的 Verify 次数 | 至少发现一项违规的 Verify 次数 |
| 观察覆盖率 | 观察启用期间创建的有效观察样本 | 能够得到明确生命周期结算的样本 |

四条细则：

1. `expired` 可以进入必核项完成率的分母，但**不能进入确认漏查的分子**。指标名称必须体现这是「观察到的核验完成率」，不能叫「模型合规率」。
2. `interrupted`、`unobserved`、`excluded` 不进入行为合规率分母，单独报告数量及排除原因。
3. `disabled` 期间不产生有效观察样本，不允许以零违规计入统计。
4. Verify 没有可核验断言、执行失败或上下文快照缺失时，不进入 Verify 违规率分母，必须单独统计。

**特别重要：违规率按 Verify 执行次数计算，不按违规条数计算。** 一次 Verify 出现五条违规，仍然是一轮存在违规的 Verify，而不是五次违规执行。

最终报表必须同时保留：分子、分母；有效样本数量；排除样本数量；各类排除原因；观察是否启用。**没有这些信息的百分比不应展示。**

> **注**：本段按 m03499 原始复审决定照录，指标名称沿用当时旧名；名称与分母口径以 m03601 定点修订为准，分层管理、收敛诊断独立保留等决策不变。

#### 复审决定（Q2）：两层指标，并存分层，不强行换算

用户完整审核拍板「并存，但分层管理」：

**第一层 · 正式治理指标**（P1 新机制投入使用后的正式统计口径）：以上表「三个独立分母、不使用统一分母」的原则为准，指标名称与具体分母按 m03601 定点修订更新为「必核项 Context 核验触发率」「有效 Verify 违规发现率」「观察覆盖率」。**不再直接拿旧的 4/7、1/4、2/5 代入新公式**：旧观察日志与新事件账本的数据结构、纳入条件不同，硬塞只会制造虚假的连续性。

**第二层 · 旧验收基线**（保留历史意义，不改写为新指标的当前值）：

| 旧指标 | 决定 | 后续用途 |
|---|---|---|
| Context 核验覆盖率 4/7 → ≥80% | 保留历史记录 | 不作为新指标的可比基线 |
| 违规 Context 收敛率 1/4 → ≥50% | 保留 | 转为独立收敛诊断 |
| 高风险 Context 强制核验率 2/5 → 100% | 保留 | 作为「必核项 Context 核验触发率」中的 `partial` / `insufficient` 分组（旧称「正式核验完成率」，按 m03601 改名；分组只描述触发率，不证明逐项核验完成） |

- 尤其保留 2/5 这个分组：`partial` / `insufficient` 是当前系统明确要求必须核验的样本，不能被所有 Context 的平均表现掩盖。新账本既然记录 `support`，就必须用它提供这个分组统计（见「指标与可见性」节）。
- 4/7、1/4、2/5 都是**旧观察期的历史值**；新账本开始工作后重新建立新口径基线，不把历史值改写成新指标的当前值。
- **有效 Verify 违规发现率不设「越低越好」的验收目标**：初期违规率上升也可能是核验机制终于开始发现原先漏掉的问题，必须与收敛诊断一起解释。`status:'ok'` 只表示这一轮核验没有报违规，**不等于所有应该检查的内容都已检查**，也不等于回答可靠。

### Q3：关闭观察是否破坏性清空 —— 是，采用破坏性清空

理由：`calls.enabled` 已经具有关闭观察和清空账本的既有语义。新增 pending 和指标后，不应该悄悄改变用户对关闭按钮的理解。**reviewer 曾以「无提示数据丢失」提出疑虑，用户拍板否决，维持既有语义；落实方式是把提示写进界面，而不是改变行为。**

| 数据 | 处理 |
|---|---|
| 新的调用记录 | 停止记录 |
| 历史调用账本 | 清空 |
| pending | 清空 |
| 临时统计数据 | 清空 |
| 派生指标及累计计数 | 清空 |
| Python 快照 | 不动 |

三个实现要求：

1. **先停止接收，再清理**：关闭开关后先阻断新事件进入，再清除 pending 和账本，避免并发写入导致残留。
2. **不补造历史数据**：重新开启后不得根据旧 context、残留文件或历史快照补录观察事件。
3. **区分配置状态与生命周期状态**：`disabled` 代表当前观察功能关闭，**不代表某条 context 经历了一个叫作 `disabled` 的生命周期事件**。关闭后 `wiki_observe` 应明确返回观察不可用，而不是返回三个全部为零的指标。

「用户关闭观察，就是明确放弃这段观察历史。不要提供隐式恢复机制。」重新开启后从新的观察周期开始。

### Q8：「不改契约」的边界 —— Python Gateway v1 冻结，插件侧允许向后兼容扩展

| 层 | 是否允许变化 | 边界 |
|---|---|---|
| Python Gateway v1 | **不允许** | Schema、输入输出语义、快照结构、字段含义不变 |
| 插件工具接口 | 允许增量扩展 | 必须向后兼容 |
| Prompt 与 Description | 允许修改 | 增加治理规则，不改变工具原有职责 |

不允许改动：`knowledge-gateway.v1.schema.json`；`wiki_context` / `wiki_verify` 对 Python 管线的调用契约；Python Context / Verify 的快照结构和字段语义；Python 数值判据和证据裁决规则；Python `observe.py` 的持久化格式及私有管线。

允许改动：L1 System Prompt 动态注入规则；三个工具的 Description；插件端 `renderContext` 追加必核清单；插件端 `calls.js` 扩展必要的观察状态；`wiki_observe` 追加指标和 pending 状态相关的可选返回字段。

对 `renderContext` 的特别要求：**新增必核清单只能从现有 Context 的证据、缺口和适用范围中提取，不能重新推断事实，更不能制造新的证据。**

`wiki_observe` 扩展的兼容原则：不删除旧字段；不更改旧字段的类型和含义；新字段尽可能采用可选、增量形式；数据不可用时明确表达不可用，不能伪装成数值零；不突破现有最小化隐私白名单。

> 推论（写进实现约束）：因为 `error_envelope` 是 `additionalProperties:false` 且 schema 冻结，`wiki_observe` 只在 `base.kind === 'observe'` 的成功返回上合并 `governance`；失败路径原样返回 `base`，「观察不可用」改由 `renderObserve` 与 `GET /calls` 明确表达，不给错误信封塞任何额外键。这替代了修订前「同层返回独立 governance 对象」的写法。

### 最终决策记录

| 问题 | 最终决定 |
|---|---|
| Q2 分母 | 每个指标独立定义有效样本群体，报告分子、分母和排除项 |
| Q3 关闭观察 | 破坏性清空账本、pending 和派生指标 |
| Q8 不改契约 | Python Gateway v1 冻结，插件端允许向后兼容的增量扩展 |
| `interrupted` | 只接受显式持久化中断证据 |
| `unobserved` | 独立排除，不推导为任何生命周期状态 |
| `expired` | 仅表示 TTL 到期且未观察到，不代表确认漏查 |

## 用户拍板记录（m03601）：测量依据定点修订（**优先于本稿其余表述**）

用户复审 m03533 后，针对「必核项完成率的分子」做了一次**只读**兼容性核查，结论是两个测量依据都不成立；用户 m03601 据此正式拍板四项决策。**这只是设计稿定点修订授权，不是实施批准，也不意味着可以提交代码。**

> 核查结论（只读，未改任何已通过部分）：冻结契约的 verify 返回体只有聚合结果，检查通过的项目完全不出现，`status:'ok'` 且 `violations` / `notices` 为空时无法区分「跑了若干规则全过」与「根本没跑」；`violations[].rule` 只列报违规的规则、是管线内部名，与槽位 id / `evidence_id` 没有一一映射。`checked_rules` 语义是「规则条数」不是「可核验断言数」，且冻结实现恒为 `null`（`answer_policy.py:219` 的 `check_answer` 返回体只有 `ok` / `violations` / `notices`，`context_snapshot.py:228` 取到 `None`，`wiki_bridge.py:275-318` 不补）；样例里的 `10` 是理想化占位。`numeric_claim.py` 的 `judged[]` 被 `answer_policy.py` 丢弃、只覆盖数值一维、还带回答原文，不能作映射。**结论：当前冻结契约能支持哪些观测，不是我们希望它支持哪些观测；不能为了保留指标名称假装系统具备尚不存在的测量能力。**

### 四项决策（逐条照录）

| 项目 | 决策 | 具体要求 |
|---|---|---|
| 必核项完成率 | **接受改名** | 改为「必核项 Context 核验触发率」 |
| `assertion_count` | **数据不可用** | 不计算断言数量，不展示相关百分比 |
| Verify 违规率 | **选择 B** | 改为「有效 Verify 违规发现率」 |
| `checked_rules` 偏差 | **只登记，不修复** | 后续另行立项，不纳入本次治理设计 |

「只是决策拍板，不等于整个设计稿已经获得实施批准」的口径继续有效；**其他已通过的五项修正、Q2 / Q3 / Q8 决策、Python Gateway v1 冻结边界，全部保持不变**。

### 1. 必核项 Context 核验触发率（原「必核项完成率」）

- **分母**：观察启用期间成功生成、且 `required_check_count > 0` 的有效 Context。
- **分子**：上述 Context 中，**至少发生过一次有效 Verify** 的 Context 数量。
- `partial` / `insufficient` 分组继续保留，但**它们只能描述 Verify 的聚合结果，不能证明必核项逐项完成**。
- 原来的 `required_check_completion` 及其下属指标键，同步调整为准确表达新语义的名称（见「指标与可见性」：`required_check_verification_trigger_rate`）。
- **这个指标衡量的是核验触发情况，不是核验完成情况，更不是回答可靠率。** 存在有效 Verify ≠ 全部必核项都核验：5 项必核、模型只核 A/B、Verify 返回 `ok`，分子仍然 +1，账本只能证明「触发过核验」。

### 2. `assertion_count`：数据不可用

当前冻结契约无法提供可靠的断言数量，因此：

- 不记录伪造的 `0`；
- 不用 `violations.length + notices.length` 代替；
- 不从 `checked_rules` 推断断言数量；
- 不读取 Python 快照内部数据绕过契约；
- 不修改 Python Gateway v1 来补字段。

**`assertion_count === 0` 与「无法确定」不是一回事**：前者是确定没有可核验断言，后者是缺少测量依据，不能混用。报告应明确显示「**数据不可用**」，而不是 `0%`、`0 次` 或一个看似正常的统计值。本阶段账本**不写** `assertion_count` 字段；`governance` 用 `assertion_measurement: { state:'unavailable', assertion_count: null, reason:'contract_unavailable' }` 显式表达（见「指标与可见性」）。

### 3. 有效 Verify 违规发现率（原「Verify 违规率」，采用 B）

> **「有效 Verify」的正面定义**：本稿所称「有效 Verify」，仅指 Verify 执行成功且返回状态属于 `ok` / `violations_found`，因此可以纳入本阶段的调用次数统计。它不表示已经证明实际检查了至少一条断言，也不表示具备断言覆盖率或逐项核验能力。「有效」是统计样本的可用性定义，不是核验充分性的评价。

- **分母**：成功完成的 Verify 次数，即 `status ∈ { ok, violations_found }`。
- **分子**：其中 `status = violations_found` 的 Verify 次数。
- **计算单位**：Verify **调用次数**，不是违规条数。一次 Verify 出现五条违规仍是一轮发现违规的 Verify。
- **不可用调用**：执行失败、快照缺失、过期、损坏、无可核验断言等，不进入分母，分别统计原因。当前冻结契约下「无可核验断言」无法可靠判定（见第 2 条），因此本阶段不据此排除任何调用，也不得把「无法计数」写成 `no_assertion`。

它回答的是：**成功完成的核验调用中，有多大比例发现了违规？**

它**不**回答：

- 有多少断言被检查；
- 所有必核项是否都被检查；
- 没发现违规是否意味着回答可靠；
- 违规发现率越低，系统就越好。

**尤其不能把 `ok` 理解成「所有应该检查的内容都已检查」。** 不设「越低越好」的验收目标；初期上升也可能是机制终于发现原先漏掉的问题，必须与收敛诊断一起解释。

### 4. 已知契约与实现偏差：`checked_rules`（只登记，不修复）

> **已知契约与实现偏差：schema 描述了 `checked_rules`，但当前运行时实现未提供有效计数。**

理由：契约中的 `checked_rules` 描述「实际参与核验的规则条数」；当前实现实际返回 `null`；它既不能作为断言数量，也不能证明逐项核验；Python Gateway v1 已冻结，P1 不应借此改变 Python 实现或契约。**后续是否修复，另行立项，不纳入本次治理设计。** 本轮维持 Q8 冻结边界：`knowledge-gateway.v1.schema.json` 一个字符都不改，CI 只做文件哈希不变的只读断言。

### 5. 允许修改的范围（本次授权边界）

只批准以下四项进入设计稿：

1. 必核项完成率改名为「必核项 Context 核验触发率」，同步调整指标键；
2. `assertion_count` 明确标记为数据不可用；
3. Verify 违规率采用 B，改名为「有效 Verify 违规发现率」，修改分母、分子和解释；
4. 登记 `checked_rules` 契约与实现偏差。

其余五项已通过修正、Q2 / Q3 / Q8 决策、Python Gateway v1 冻结边界全部保持不变。**实现代码、提交和范围扩展继续冻结；本稿仍需完整复审通过才算实施批准。**

### 复审重点（用户 m03601 列出，修订后逐条自检）

- [ ] 新指标名称是否与实际测量能力一致；
- [ ] 所有旧的「必核项完成率」表述是否已清理，历史数据是否明确标记为旧口径；
- [ ] `assertion_count` 是否彻底避免将未知误记为 `0`；
- [ ] Verify 违规发现率是否严格按调用次数计算；
- [ ] `ok` 是否没有被描述成全面核验通过；
- [ ] `checked_rules` 偏差是否登记，但没有借机改变冻结契约；
- [ ] Q2 的分子、分母、排除样本和时间窗口是否仍然自洽。

## builder check 与必须修正项（已坐实，不进 my call）

独立 reviewer 判定：**「重启缺行归 `interrupted`」不是一处措辞错误，状态模型、账本恢复、指标分母、payload 形状、测试断言五处都带着同一个误判**；只改一句话，统计口径仍会把未观察样本算成「已中断 / 已进分母 / 零违规」。下列位置指修订前稿本行号：

| 修订前位置 | 问题 |
|---|---|
| `:164` | 判据全是「boot_ref 之外 + 无后续 + 无结算」等否定条件；boot_ref 变了只证明换了进程，正常退出也算 |
| `:167` | 容量淘汰记 `interrupted(reason:'capacity')` —— 淘汰是主动停止观察，不是进程中断 |
| `:149-157` | 把 `pending` 当第 5 状态、`interrupted` 不要求显式证据、无独立 disposition 维度；`:156` 把生命周期状态与统计结论揉进一格 |
| `:204` | coverage 分母「全部不同 context_id」会把 excluded 算进分母 |
| `:192-196` | `excluded` 是扁平 bucket，混了生命周期名 `interrupted` 与配置名 `disabled`，不是每样本的正交标记 |
| `:187-190` | metrics 里一个 excluded 字段都没有，与 `:208`「所有指标必须带分母 / 排除数 / 排除原因」自相矛盾 |
| `:194` | excluded 示例里 `interrupted:1` 就是那条伪事实 |
| `:231` | 测试断言「旧 boot_ref 标 interrupted」把误判固化进 CI |
| `:250`(#4)、`:254`(#8) | my call 里继续靠缺行与淘汰补造 `interrupted` |

还查出同源第二处：`:167` 容量淘汰。两处一并修正。

**兼容性核对结论（已通过，不需再答）**：`wiki_observe` 只加 `governance` 不破坏旧调用——`lib/index.js:1025-1045` 入参仍是 `{days,limit}`，`lib/bridge.js:47-55` 的 Python 完全不经手，只是返回体多一个可选键；`tests/gateway.mjs:159/:185` 只逐字段比对 context / verify，`tests/api.mjs:214-231` 只读 `/calls` 已知字段，`lib/client.js:1430-1456` 忽略未知键；schema 的 `observe_stats` 顶层无 `additionalProperties:false`。**Python 契约一行不用改。**

## 怎么实现

### 1. 四层触发提示（交付 1）

四层是**提示与反馈的分层**，不是四个新子系统：

| 层 | 位置 | 写什么 | 不写什么 |
|---|---|---|---|
| L1 | 新增独立 `systemPrompt.context` 段 `wiki-notes:governance`（`order: 241`，`interpolate:false`，静态 `text`） | 完整触发总纲、跳过条件、检索后行为纪律、候选答案 → Verify → 修正 → 再 Verify → 输出的流程、修正轮次上限与披露义务 | 页数、pending 数、指标、任何每步变化的数字 |
| L2 | `DESCRIPTION` 与三个网关 description（静态字符串，共覆盖四个工具的职责） | `wiki_recall`：适用场景 + 核心名词查询规范；`wiki_context`：何时取证据上下文 + 必须遵守证据边界；`wiki_verify`：何时核验 + 不得绕过违规结果；`wiki_observe`：只读诊断 + 指标不可用时要说明没数据 | 不复制 L1 全文，不退化成「可以 / 建议」 |
| L3 | `renderContext` / `renderVerify` / `renderObserve` | 本次真实状态、缺口、证据与违规信息；必核清单；违规逐条；指标与分母 | 不替模型下结论，不把 `support` 与 `degraded` 混为一谈，不推断事实 |
| L4 | `calls.js` 账本 + 新事件账本 + `GET /calls` + 设置页「调用记录」页签 | 已发生的调用、pending 结算、指标、`enabled` 状态 | 不进 system prompt，不生成新的每轮注入文本 |

L1 要点（稳定文本，实现时文案可微调，语义不可减）：

- 命中库线索、要引用笔记原文、要下结论 → 先 `wiki_recall`；需要证据包或判断依据够不够 → `wiki_context`；候选答案含数字、引文或未填槽位 → **输出最终答案之前必须** `wiki_verify`；涉及多页 / 多来源证据时，必须在答案里披露证据边界与来源独立性（这部分由 `renderContext` 的证据信息提供，核验器只覆盖已实现的规则族，**不承诺检查一般性的跨页综合推导**）。
- 流程：`Context → 生成候选答案 → Verify → 修正 → 再 Verify → 输出最终答案`。超过允许的修正轮次仍有违规，**必须披露剩余问题**，不能假装核验通过。
- 跳过条件：**纯通用常识且回答不依赖本地知识库时，可以跳过检索。凡涉及本地知识、笔记原文或需要引用库内依据的内容，应先检索。检索无结果不代表知识库不存在对应内容。** 库未配置或工具报错时明确告知，不编答案；`status.degraded === true` 时不得把 `status.support` 当结论。
- 纪律：不得绕过 `violations_found`；`partial` / `insufficient` 必须走 Verify。

**复审修正（问题 4 · L1 跳过条件与跨页结论）**：原稿跳过条件写「纯通用常识且确认库里没有对应内容」，与同段「不得把『这次没查到』写成『库里没有』」自相矛盾，已按上面加粗文本改写，判定条件统一为「回答不依赖本地知识库」。另外，原 L1 把「跨页结论」列为 Verify 硬触发，但必核清单映射表里 `duplicate_as_independent` 只检查「单页多引擎被当成两个独立来源」这一特定情形，不等于核验所有跨页推导。二选一里采用**缩小 L1 触发描述**：L1 不再承诺核验器具备一般性跨页综合结论检查能力，改为「多页 / 多来源须披露证据边界与来源独立性」，由 L3 的 `renderContext` 证据信息提供，核验器只覆盖已实现的规则族。**不用提示词制造不存在的核验能力**；映射表同步加注（见交付 2）。

L2 用抽出的常量（`RECALL_TRIGGERS` / `CONTEXT_TRIGGERS` / `VERIFY_TRIGGERS` / `OBSERVE_TRIGGERS`）注册，测试直接断言常量内容与注册引用，不靠正则扫自由文本。契约测试覆盖**四个工具**的职责描述（`DESCRIPTION` 对应 `wiki_recall`，三个网关 description 对应 `wiki_context` / `wiki_verify` / `wiki_observe`），每个必须含至少一条「必须 / 不得 / 先…再…」硬触发、且不得只剩「可以 / 建议」；并额外验证 `DESCRIPTION` 常量确实被 `wiki_recall` 注册引用、没有被别的工具误用（复审问题 5：把「三个 description」改成覆盖四个工具，补注册 / 引用关系断言）。

`prompt.enabled=false` 只关 `wiki-notes:topics` 那行主题词，不关治理总纲；`prompt.override` 也不能无声覆盖治理总纲。这是把总纲独立成第二个 context 段的原因。

### 2. `renderContext` 必核清单（交付 2）

清单标题固定「本次回答必须核验」，**只从 context 返回里真实存在的字段派生**：`evidence` / `evidence_items` / `missing` / `unresolved` / `conflicts` / `status` / `answer.constraints`。每条必须绑定契约允许的 `violation.type`，且能对应到 Verify 侧实际存在的规则。**不重新推断事实，不制造新证据；没有对应证据的规则族不列。**

| 规则族（schema `violation.type`） | 生成条件（本次真实存在才列） | Verify 侧对应 rule |
|---|---|---|
| `unsupported_numeric_claim` / `numeric_check_failed` | 有 numeric 槽的证据单元，或 `supports[].values` 有数值 | `numeric.claim_not_supported` / `numeric.check_failed` |
| `conditional_limit_missing` | 有 `quote_support === 'conditional'` 的支撑 | `conditional.limit_not_with_claim` |
| `fabricated_quote` | `evidence_items[].quote` 非空 | `provenance.fabricated_quote` |
| `gap_not_disclosed` / `answered_unfilled_slot` | `missing` 非空，或 `status.support ∈ {partial, insufficient}` | `missing.not_disclosed_in_answer` / `insufficient.answered_unfilled_slot` |
| `duplicate_as_independent` | 存在 `page_count === 1 && engine_count >= 2` 的证据单元（**仅此特定情形**：单页多引擎被当成两个独立来源；不覆盖一般跨页综合推导，见交付 1 的复审修正） | `provenance.duplicate_as_independent` |
| `review_flag_missing` | 某槽位的支撑全部 `needs_review` | `weak_evidence.review_flag_missing` |
| `unresolved_disclosure_missing` / `unresolved_arbitrated` | `unresolved` 或 `conflicts` 非空 | `recorded_unresolved.*` |
| `conclusion_without_evidence` | `status.support === 'insufficient'` 且证据单元为空 | `insufficient.conclusion_without_evidence` |

**输出示例作废并重做**：修订前 `:115-122` 那段「2 条证据单元：E001、E003 / 未填槽位 2 项（not_found ×1、recorded_unresolved ×1）」出自另一份语料，与本节指定的 fixture 对不上。以 `docs/契约-stage0/samples/context.sample-cache.json` 的**实际内容**为准重写期望输出（该样例 `status.support:'partial'`、`missing` / `unresolved` / `conflicts` 全空、`evidence_items` 是 E001–E004 共 4 条 numeric 槽、`supports[].values` 全 null）。另补一份覆盖 `missing` 的虚构 fixture，让「missing 不被写成已有证据」有测试可测。

硬规则：

- 不复制具体数值、引文正文、页面路径、页面标题；只写槽位 id、`evidence_id`、计数、规则族。具体数值由模型写进候选答案，再由 Verify 拿快照核对。
- `missing` 只列「不得填补 + 必须披露」，不把缺口伪装成已有证据。
- **Context 创建时把本次清单的实际项目数量写进账本 `required_check_count`（只记整数、不记项目内容）**。`0` 表示本次没生成必核项，该 Context 不进「必核项 Context 核验触发率」分母；`support: 'sufficient'` 的 Context 也可能 > 0（数字证据、引文、条件限制都算），因此**不能用 `support` 反推有没有必核清单**（复审问题 1）。这个数量只用于界定分母，**不能**当作「逐项核验完成」的证明（m03601）。
- 「输出不含具体数值 / 引文 / 页面路径 / 真实主题词」**只约束新增清单段**，不重写整段 `renderContext`（现 `lib/index.js:790/804/813/818` 会打印 `value.query`、`page.title ?? page.page`、`value.answer.contract_text`，整段重写会削掉模型现有可见信息量，越出 L3 边界）。
- 插件侧维护 `RULE_FAMILIES` 常量。**测试分两层（复审问题 5）**：CI 只读 `docs/契约-stage0/knowledge-gateway.v1.schema.json` 的 `violation.type.enum`，断言 `RULE_FAMILIES` 是其子集、且映射表每一行都有对应常量与引用关系——这**只能证明「插件用的类型属于 Schema 枚举」，不能证明 Python 实现里真有对应检查规则**；**实现前兼容性审核**另做人工逐项核对，对照冻结版 `answer_policy.py`、`wiki_bridge.py` 的 `VALID_VIOLATION_TYPES` / `RULES_TO_TYPE` 确认每个规则族确有实际核验规则，不修改 Python、不把私有管线接进 CI。两层都过了，才允许把「Context 说五项、Verify 只查三项」这类分叉判为被挡住。

### 3. pending 账本与生命周期（交付 3）

**pending 是内存里的短期关联状态，不跨重启；落盘的是「已观察到的事实」组成的最小化事件账本。** 这既符合 A 方案的职责边界，也避免为持久化把治理逻辑搬去 Python。

新增 `lib/governance.js`（新文件，不是新工具），把 `lib/calls.js` 的追加写 / 尾部读 / 轮转抽成公共 `createJsonlStore`，`createCallLog` 与事件账本共用；不新增依赖。事件账本文件 `governance.jsonl`，加进 `.gitignore`。沿用 `MAX_LINES = 5000` / `KEEP_LINES = 2500` / `TAIL_BYTES = 262144`。

#### 三个维度正交，互不推导

| 维度 | 取值范围 | 含义 |
|---|---|---|
| **生命周期状态**（每样本） | `pending`（初始）/ `completed` / `expired` / `interrupted` | 这条记录经历了什么 |
| **观察配置**（全局，不是样本状态） | `enabled` / `disabled` | 观察功能当前是否开启 |
| **样本处置**（每样本，正交） | `included` / `unobserved`（= `excluded`，带 `reason`） | 这条记录是否具备进入统计的条件 |

- `completed` = **观察到预期后续事件**（至少一次有效 Verify 成功关联）。
- `expired` = **本进程 TTL 到期结算**，语义固定为「超时，未观察到预期后续事件」。仅此而已，**不代表确认漏查，不计入确认漏查分子、不计入违规**。
- `interrupted` = **有显式、持久化的中断证据**。本阶段 `ctx.on('dispose')` 不可靠、会话结束事件未确认，因此**不写任何中断标记，此状态保留但无生产者**；所有「旧 boot_ref / 容量淘汰 / 无结算行」的样本一律走下面的 `unobserved`。
- `disabled` **不是生命周期状态，也不是样本排除原因**，是全局配置；`disabled` 期间不产生有效观察样本。
- `unobserved / excluded` = 缺少足够信息，不能可靠分类或纳入指标。**不统计成零违规、不悄悄从报表消失**，展示排除数量与原因。它不是第五种生命周期状态。

**重启恢复原则：没有持久化的中断标记，就只能排除，不能补造中断事实。** 如果未来无法可靠写入中断标记，保留 `unobserved` 比强行恢复状态更诚实。这一条必须贯穿状态定义、账本恢复、指标分母三处，不能只改措辞。

#### 字段白名单（只增这些，均为 ID / 时间 / 状态 / 类型 / 关联 / 计数，全部是枚举或整数，不含内容）

```
ts, boot_ref, session_ref, event_id, kind, context_id, parent_observe_id,
lifecycle, disposition, exclude_reason, support,
required_check_count, verify_unusable_reason,
status, reason, violation_types, attempt_seq, ttl_seconds
```

- `lifecycle` ∈ `pending | completed | expired | interrupted`；`disposition` ∈ `included | unobserved`。
- **排除原因按层级分开，不混进一个字段（复审问题 2）**：

  | 层级 | 字段 | 取值 |
  |---|---|---|
  | Context 样本排除 | `exclude_reason` | `restart_not_observed` / `capacity`（只这两个，样本级；`unobserved` 样本专用） |
  | Verify 调用不可用 | `verify_unusable_reason` | `context_missing` / `context_expired` / `context_corrupt` / `exec_failed` / `no_assertion`（调用级；**不改所属 Context 的 `disposition`**）。`no_assertion` 是**兼容性保留值**：当前冻结契约下无法可靠判定「无可核验断言」，因此本阶段不可产生该类样本，不生成该类计数，也不在报表中展示这一分类。不得把无法判断的调用归入 `no_assertion`。整体断言测量能力缺失统一由 `assertion_measurement.state = 'unavailable'` 表达（m03601 第 2 条） |
  | 全局观察状态 | `observe_enabled` | `enabled` / `disabled`（全局配置，不是样本字段，**不出现在任何 `exclude_reason`**） |

  Verify 调用不可用**不把所属 Context 整体排除**：一个 Context 可以先经历一次失败 Verify，随后又完成一次有效 Verify；两级独立统计。
- `required_check_count`（整数）：`kind:'context'` 时写入本次 `renderContext` 必核清单的**实际项目数量**，只记数量不记内容（复审问题 1）。`0` = 本次没有生成必核项 → 不进「必核项 Context 核验触发率」分母；`sufficient` Context 也可能 > 0，所以不能用 `support` 反推。**它只界定分母，不证明任何一项已被逐个核验**（m03601）。
- **`assertion_count`：本阶段数据不可用，不记账（m03601 第 2 条）**。只读兼容性核查确认冻结契约的 verify 返回体既没有断言集合、也没有可用的断言计数（`checked_rules` 在实现里恒为 `null`），`violations.length + notices.length` 只覆盖出问题的项、且被用户明确排除。因此白名单里**删掉** `assertion_count`：账本不写该字段、不写 `0`、不写任何推断整数；`governance` 用 `assertion_measurement: { state:'unavailable', assertion_count: null, reason:'contract_unavailable' }` 显式表达，界面显示「数据不可用」，不展示 `0%` / `0 次` / 任何百分比。**`assertion_count === 0`（确定没有断言）与「无法确定」（缺少测量依据）是两回事，绝不混用。**
- 不许改的取值来源（逐条写死）：不从 `checked_rules` 推断；不读 Python 快照内部；不用违规条数、违规类型数量、Context 必核项数量、Verify 调用次数代替；不改 Python Gateway v1 补字段。后续是否另行立项修复，不在本轮范围。
- `support` ∈ `sufficient | partial | insufficient`（仅 `kind:'context'`，让 `partial` / `insufficient` 分组能从账本重建；不含内容，隐私断言同步更新）。
- `status` 记 **verify 返回状态**（`ok` / `violations_found` / `context_missing` / `context_expired` / `context_corrupt`），与生命周期 `expired` 用字段名与前缀消歧，避免同名混淆。
- `context_id` 是唯一追踪对象；任何按 context 去重的口径都用它。
- `session_ref` = `sha256(ctx.sessions.scopeOf(ctx) ?? 'unscoped').slice(0, 12)`，不落裸会话 id，用来隔离不同会话，避免串账。
- `boot_ref` = 每次 `apply()` 生成一次随机短 id。**只用于识别「换了进程」，不再用于推断任何状态**；boot_ref 变了不证明中断，正常退出也算。
- `event_id` = `evt_` + `sha256(context_id + '|' + kind + '|' + attempt_seq + '|' + ts).slice(0, 12)`；读取时按 `event_id` 去重，同一事件重放不重复计数。`attempt_seq` 在同一 `context_id` 内单调递增；**重启后内存 Map 清空，必须扫账本按 context 取 max 恢复**，否则重放冲突、去重失效。
- 不写 `answer` / `quote` / `page` / `path` / 文件正文 / 断言正文 / 清单正文；`query` 不新增（调用账本里已有的 120 字截断语义不扩大）。

#### 生命周期

1. `wiki_context` 成功返回 `context_id` → 记 `kind:'context'`，带 `support` 枚举与 `required_check_count`，内存 Map 登记 `lifecycle:'pending'` / `disposition:'included'`，写 `created_at` / `ttl_seconds`。
2. `wiki_verify` 返回 → 记 `kind:'verify'`，带 `violation_types` 与 `attempt_seq`（**不记 `assertion_count`**，见上）；**只有成功关联且 `status ∈ { ok, violations_found }` 的 Verify** 才把同 `context_id` 的 pending 标 `completed`、计入「必核项 Context 核验触发率」分子与「有效 Verify 违规发现率」的分母 / 分子。**这只证明「发生过一次有效 Verify」，不证明必核项逐项完成；`ok` 不等于全面核验通过**（m03601）。
   - `context_missing` / `context_expired` / `context_corrupt`、执行失败：**调用级**记 `verify_unusable_reason`，不进任何分子、不标 `completed`、不进「有效 Verify 违规发现率」分母、**不把所属 Context 标 `unobserved`**，但推进 `attempt_seq`（调用确实发生过）。所属 Context 仍可等后续有效 Verify 完成。当前冻结契约下「无可核验断言」不可判定，因此不以此为由排除调用（m03601）。
   - 重复 Verify 归入同一 context，不重复计入按 context 去重的分母。
3. TTL 到期 → 记 `kind:'expired'`，`lifecycle:'expired'`，语义固定为「超时，未观察到预期后续事件」；`required_check_count > 0` 的样本可留在「必核项 Context 核验触发率」分母，不进确认漏查分子。
4. 重启 → 内存 pending 清空，**不补造历史行**。账本里当前 `boot_ref` 之外、没有结算事件、也没有任何显式中断标记的 context，一律 `disposition:'unobserved'`、`exclude_reason:'restart_not_observed'`，生命周期保持 `pending` 不推导；不算 `completed`、不算 `expired`、不算 `interrupted`、不算漏查。
5. 容量淘汰 → `disposition:'unobserved'`、`exclude_reason:'capacity'`（**主动停止观察，不是中断**）。
6. 会话结束事件：本阶段**不订阅**。勘察已确认 `session/disposed` / `api-session/removed` / `workspace/session-stop` / `ctx.on('dispose')` 都不是可靠的「用户回合结束」。将来若 DSH 回合生命周期钩子经实测确认可靠，只需补一个 `settleOnReliableEnd()` 调用点，账本结构不变；`session/event` 的 `turn/end`、`agent/turn-stopping`、`session/flush` 在本阶段只作为未来候选，不进入正确性主路径。

#### TTL 与统计窗口边界（复审问题 3）

**事件顺序固定**（每次 `record` / `read` / `wiki_observe` 入口都先走一遍）：

```
收到新事件 → 先结算已到期的 pending → 再处理当前事件 → 记录本次观察事实 → 计算指标
```

三个明确判据：

1. **Verify 到达时 Context 已超 TTL、但还没执行惰性扫描**：按上面的顺序，先结算 `expired`，再处理这条 Verify——「先结算已到期」优先，不因为收到 Verify 就跳过到期结算。
2. **已 `expired` 的 Context 后来又出现有效 Verify**：`expired` 是终态，**不回退**成 `completed`；这条迟到 Verify 仍记一条 `kind:'verify'` 事实（账本记真实发生的事），但**不计入「必核项 Context 核验触发率」分子**（分子只统计 TTL 窗口内观察到的核验触发），单列 `late_verify` 诊断计数，避免「过期后补核」把超时样本洗成已核验。此项已由用户 m03533 复审**通过**，不再是待确认项。
3. **`days` 统计窗口按什么筛选**：三项分母各自锁定自己的时间轴，不按「每条事件发生时间」混筛——

   | 指标 | 样本群体时间轴 |
   |---|---|
   | 必核项 Context 核验触发率 | **Context 创建时间** |
   | 有效 Verify 违规发现率 | **Verify 发生时间** |
   | 观察覆盖率 | **Context 创建时间** |

   这样三个分母不会因为时间窗口而发生隐蔽的交叉统计。

工程约束：TTL 结算用**惰性扫描**（每次 `record` / `read` / `wiki_observe` 时顺手做），不新增 `setInterval` / `setTimeout`。P0 已经踩过 Linux 上 recursive `fs.watch` 把进程钉住的坑（`lib/index.js:368` 的 `persistent:false`），本轮不再引入任何常驻句柄。`PENDING_MAX = 512`。

### 4. 指标与可见性（交付 4）

`wiki_observe` 的 `execute` 先拿既有 Python 统计，再**只在成功返回上**合并插件侧一个命名空间；失败路径原样返回 `base`：

```js
const base = await callBridge('observe', { days: args?.days, limit: args?.limit })
if (!base || base.kind !== 'observe') return base   // error_envelope 不带任何额外键
return { ...base, governance: governanceStats({ days: args?.days }) }
```

不改 `kind` / `contract_version` / `totals` / `revision` / 任何既有字段，只加可选 `governance`；既有调用者不受影响。`renderObserve` 末尾追加指标；`GET /calls` 返回体也带同一个 `governance` 对象；设置页「知识库 → 调用记录」页签内加一块指标面板，**不新开页签、不新开一级入口**。失败 / 关闭 / 不可用时由 `renderObserve` 与 `GET /calls` 明确表达「观察不可用」，不伪装成数值零。

#### 口径（Q2 拍板 + 复审决定，优先于本稿其余表述）

三项指标**各自独立定义有效样本群体**，不使用统一分母：

| 指标 | 分母 | 分子 | 排除 |
|---|---|---|---|
| **必核项 Context 核验触发率**（不得叫「必核项完成率」/「模型合规率」/「最终回答正确率」） | 观察启用期间、成功生成且 `required_check_count > 0` 的有效 Context（按 **Context 创建时间** 筛选）；`expired` **可进分母** | 上述 Context 中**至少发生过一次有效 Verify** 的 Context 数量 | `interrupted` / `unobserved` 样本不进分母，单列数量与原因；`partial` / `insufficient` 另出分组（承接 2/5 基线） |
| **有效 Verify 违规发现率**（原「Verify 违规率」，采用 B） | `status ∈ { ok, violations_found }` 的**成功完成 Verify 次数**（按 **Verify 发生时间** 筛选），**不依赖 `assertion_count`** | 其中 `status = violations_found` 的 **Verify 次数** | `context_missing` / `context_expired` / `context_corrupt` / 执行失败 → **调用级** `verify_calls` 分组，不进分母、不排除所属 Context；「无可核验断言」当前不可判定，不产生排除 |
| **观察覆盖率** | 观察启用期间创建的有效观察样本（按 **Context 创建时间** 筛选） | 能够得到明确生命周期结算的样本 | `disabled` 期间无有效样本；`unobserved` 单列 |

- **有效 Verify 违规发现率按 Verify 调用次数算，不按违规条数算**：一次 Verify 出现五条违规 = 一轮发现违规的 Verify。`ok` 只表示这一轮没有报违规，**不表示所有应该检查的内容都已检查**，也不表示回答可靠；不设「越低越好」的验收目标。
- `expired` 不进确认漏查分子；`unobserved` 样本不进分母；`disabled` 期间不允许以零违规计入统计；排除数量与原因按 `context_samples` / `verify_calls` 两层分别展示。
- **`partial` / `insufficient` 分组公式（承接 2/5 历史基线，复审补充）**：分组分母 = `support ∈ { partial, insufficient }` 且 `required_check_count > 0` 的有效 Context；分组分子 = 其中在 TTL 窗口内至少发生过一次有效 Verify 的 Context 数量。分组描述的是**核验触发情况**，不证明必核项逐项完成。
- **收敛诊断独立保留（用户复审决定，不并入上表三项）**：它回答的是另一个问题——「模型发现自己的回答有问题之后，最终有没有修正到合规？」有效 Verify 违规发现率衡量核验过程发现问题的频率，收敛诊断衡量问题是否得到处理，两者不能互相代替。

  | 状态 | 判定 |
  |---|---|
  | `converged` | 首次发现违规后，**最后一次有效 Verify** 为 `ok` |
  | `unresolved` | 最后一次有效 Verify 仍为 `violations_found` |
  | `not_rechecked` | 首次发现违规后，没有后续有效 Verify |

  补两条规则：`context_missing` / `context_expired` / `context_corrupt` 等**不可用 Verify 不算有效复核**；`not_rechecked` 不代表模型拒绝修正，只表示没有观察到后续有效复核。仪表盘的收敛指标固定命名为「**观察到的核验链收敛率**」，**不得叫「最终回答正确率」「答案修正成功率」**。
- **指标解释（必须随报表展示，复审第四节）**：`converged` ≠ 最终用户看到的回答已被证明可靠。本轮没有宿主级 pre-output 拦截能力：模型提交候选答案 A → Verify 发现违规 → 改成 B → Verify 返回 `ok` → 模型在最终输出前又改成 C；账本能证明 B 通过核验，不能证明 C 与 B 一致。收敛链只说明「观察到的核验链收敛」，与「不新增 pre-output 拦截」的范围一致。
- **基线分层（复审决定）**：4/7、1/4、2/5 是旧观察期的历史值，不强行换算成新分母；新账本重新建立新口径基线。2/5 的 `partial` / `insufficient` 分组由 `support` 字段在「必核项 Context 核验触发率」里继续提供分组统计，目标仍为 100%（**注意：分组描述的是触发率，不证明逐项核验完成**）；1/4 转为独立收敛诊断的历史基线、目标仍为 50%；4/7 只留历史记录、不作可比基线。有效 Verify 违规发现率不设「越低越好」验收目标，与收敛诊断一起解释。

#### `governance` 结构（形状示意，数字非实测）

每项指标必须自带分子、分母、有效样本数、排除数与排除原因；**缺少任一项时不展示百分比**（`value: null`）。指标键按 m03601 改名：`required_check_verification_trigger_rate`（带 `partial` / `insufficient` 分组）、`effective_verify_violation_discovery_rate`；`observation_coverage` 不变。`assertion_measurement` 固定表达「数据不可用」，`assertion_count` 恒为 `null`，绝不写 `0` 或整数。

```json
{
  "state": "ok",
  "observe_enabled": true,
  "window": { "days": 7, "contexts": 7, "verifies": 8, "boot_ref": "boot_ab12" },
  "metrics": {
    "required_check_verification_trigger_rate": {
      "numerator": null, "denominator": null, "value": null,
      "effective_samples": null, "excluded_count": null, "exclude_reasons": {},
      "groups": { "partial_insufficient": { "numerator": null, "denominator": null, "value": null } }
    },
    "effective_verify_violation_discovery_rate": {
      "numerator": null, "denominator": null, "value": null,
      "effective_samples": null, "excluded_count": null, "exclude_reasons": {}
    },
    "observation_coverage": {
      "numerator": null, "denominator": null, "value": null,
      "effective_samples": null, "excluded_count": null, "exclude_reasons": {}
    }
  },
  "assertion_measurement": {
    "state": "unavailable",
    "assertion_count": null,
    "reason": "contract_unavailable",
    "note": "冻结契约无法可靠计数；不写 0、不写推断值、不展示百分比"
  },
  "convergence": {
    "metric": "观察到的核验链收敛率",
    "converged": null, "unresolved": null, "not_rechecked": null
  },
  "excluded": {
    "context_samples": [
      { "reason": "restart_not_observed", "count": 0 },
      { "reason": "capacity", "count": 0 }
    ],
    "verify_calls": [
      { "reason": "context_missing", "count": 0 },
      { "reason": "context_expired", "count": 0 },
      { "reason": "context_corrupt", "count": 0 },
      { "reason": "exec_failed", "count": 0 }
    ],
    "late_verify": 0
  }
}
```

`excluded` **按层级分成两组**（复审问题 2），不再把生命周期名、配置名、调用级失败混成扁平 bucket：`context_samples` 只放样本级 `exclude_reason`（`restart_not_observed` / `capacity`），`verify_calls` 只放调用级 `verify_unusable_reason`；`disabled` 是全局配置，只由 `observe_enabled` / `state` 表达，**不作为任何样本的排除原因**。`no_assertion` 是**兼容性保留值**：当前冻结契约下不可产生该类样本、不生成该类计数、报表不展示该分类；不得把无法判断的调用归入它，整体断言测量能力缺失统一由 `assertion_measurement.state = 'unavailable'` 表达（m03601 第 2 条）。关闭或不可用时返回 `state: 'disabled'`（或 `'unavailable'`），`observe_enabled: false`，`metrics` 各值 `null`，文案固定「观察未启用，因此没有数据」。**`0 次违规` 与 `没有启用观察，因此没有数据` 必须是两种界面状态**，前端与 `wiki_observe` 都要能区分。`assertion_measurement.state = 'unavailable'` 时界面固定显示「断言数量：数据不可用」，不显示 `0` 或百分比。

### 5. `calls.enabled` 的稳定性（交付 5）

按 Q3 拍板，**不为了指标强行打开，也不悄悄改变关闭按钮的既有语义**：

| 动作 | 行为 |
|---|---|
| 开启（默认 `true`） | 正常记录调用、事件、pending 与指标 |
| 关闭 | **先 `setEnabled(false)` 阻断新事件进入，再清空** `calls.jsonl` 内存缓冲与文件、`governance.jsonl`、内存 pending、临时统计数据与派生指标累计计数；**Python 快照不动**；`POST /calls/config` 返回 `{ enabled:false, cleared:true, governance_state:'disabled' }` |
| 关闭期间 | `observe_enabled:false`、指标 `state:'disabled'` 且 `value: null`，不显示「0 漏查 / 0 违规」；设置页勾选框旁写明「关闭会清空现有记录与待核验状态，期间指标不可用」 |
| 重新开启 | 从新的观察周期开始，`window` 归零，分母从 0 起；**不根据旧 context、残留文件或历史快照补录任何观察事件，不提供隐式恢复机制** |

- 「先停止接收，再清理」是并发安全要求：`lib/calls.js:182-189` 现实现关闭时 `record()` 仍往内存 buffer 推（只是不 append 文件），实现时要一并修掉，否则清空后会有残留。
- **并发安全（复审问题 6）**：只验证「先停再清」的顺序不够，还要保证**关闭操作完成后，旧观察周期不能再有任何记录落盘**。实现手段二选一（归实现期，不新增后台任务或依赖）：串行化 `record` 写入（单写者队列，清理排在队列尾部），或给每次调用带 `cycle_ref`（观察周期标识），关闭并换周期后旧 `cycle_ref` 的写入直接丢弃。测试必须覆盖三类竞态（见「测试」节）。
- 清理必须命中 `DSH_WIKI_CALLS_LOG` / `calls.log` 覆盖的文件与 `governance.jsonl` 的环境变量覆盖路径；测试要隔离，否则 CI 会写进正式日志。
- `disabled` 是**全局观察配置**，不是某条 context 的生命周期事件，也不是样本排除原因；状态机里不给样本打 `disabled`。
- `normalizeCallsConfig` 只认显式 `false` 的既有语义保留（拼错字符串不该让审计悄悄停工）；`DEFAULT_CALLS_CONFIG` 仍是 `{ enabled: true, log: '' }`。解决的是「无声停记」：关闭是用户明确动作，界面与返回体必须同时说清。
- `/calls/clear` 与 `/calls/config` 的关闭路径共用同一条清理实现，避免两处语义漂移。

## 测试（CI 可验证，不依赖私有管线）

新增 `tests/governance.mjs` 并挂进 `npm test`；`tests/contract.mjs` 与 `tests/api.mjs` / `tests/client.mjs` 补断言。用 `docs/契约-stage0/samples/context.sample-cache.json`（虚构语料）做输入，不碰真实库。

- 四层触发：**四个工具**的职责描述（`DESCRIPTION` + 三个网关 description）都含硬触发常量、不是纯建议句式；额外验证 `DESCRIPTION` 常量的注册与引用关系；L1 总纲是稳定文本且不含页数 / 计数 / 动态数字；`prompt.enabled=false` 不影响治理总纲；L1 跳过条件与「检索无结果 ≠ 库里没有」不矛盾；L1 不承诺核验一般性跨页推导。
- 必核清单：只列真实命中的规则族；`duplicate_as_independent` 只覆盖单页多引擎特定情形；`required_check_count` 与实际清单项数一致（`sufficient` Context 也可 > 0）；输出不含具体数值、引文、页面路径、真实主题词；`missing` 不被写成已有证据；期望输出以样例实际内容为准，另补覆盖 `missing` 的虚构 fixture。**规则族门禁分两层（复审问题 5）**：CI 断言 `RULE_FAMILIES ⊆ schema.violation.type.enum`、映射表每行都有常量与引用；另有一份「实现前兼容性审核」清单，对照冻结版 `answer_policy.py` / `wiki_bridge.py` 逐项确认实际核验规则存在（人工，不改 Python、不接私有管线进 CI）。CI 断言本身**不宣称**证明 Python 实现有对应规则。
- pending 三维度：`lifecycle` / `observe_enabled` / `disposition` 正交互不推导；Context 登记 / Verify 更新 / 重复 Verify 不重复计按 context 去重的分母 / `event_id` 重放去重 / 不同 `session_ref` 不串账 / TTL 到期标 `expired` / **旧 `boot_ref` 与容量淘汰一律 `unobserved`，断言方向反过来** / `attempt_seq` 重启后扫账本取 max / 无定时器。
- **TTL 与窗口边界（复审问题 3）**：先结算到期再处理事件、迟到 Verify 不回退不进分子、`days` 三项各自按 Context 创建 / Verify 发生时间筛选、不交叉统计。
- Verify 失败路径：`context_missing` / `context_expired` / `context_corrupt` / 执行失败不进任何分子、不标 `completed`、**不改变所属 Context 的 `disposition`**、推进 `attempt_seq`、单列 `verify_calls` 分组；**不记 `assertion_count`**（数据不可用），断言「未知不写成 0」；`error_envelope` 不带 `governance`。
- 指标：三项各自独立分母；报表同时带分子、分母、有效样本数、排除数、排除原因、观察是否启用，缺任一项 `value` 为 `null`；指标键与名称按 m03601（**只对现行 `governance` 指标键、报表展示名称及 UI 标签**断言不得出现旧名 `required_check_completion` / `verify_violation_rate` /「必核项完成率」；历史决策记录与明确标注的历史口径不在此检查范围内）；另断言当前实现不会产生 `no_assertion` 样本、报表不展示该分类；有效 Verify 违规发现率严格按 Verify 调用次数（`status ∈ { ok, violations_found }` 为分母、`violations_found` 为分子）、不按违规条数；`ok` 不得被描述成全面核验通过；`assertion_measurement.state` 固定 `unavailable`、`assertion_count` 恒 `null`，不出现 `0`；`expired` 不进确认漏查分子；`unobserved` 样本不进分母；排除按 `context_samples` / `verify_calls` 两层分开；`partial` / `insufficient` 分组单列；收敛诊断独立，`converged` 只看最后一次**有效** Verify，不可用 Verify 不算有效复核，`not_rechecked` 不算收敛也不算 `unresolved`；收敛指标名为「观察到的核验链收敛率」，不出现「最终回答正确率 / 答案修正成功率」。
- 账本稳定性：关闭时先停接收再清空两个账本与 pending；重新开启不补历史；`GET /calls` 与 `wiki_observe` 都能区分 `disabled`；`calls.jsonl` / `governance.jsonl` 的 env 覆盖路径都被清理。**并发三类竞态（复审问题 6）**：关闭过程中已开始的异步写入 / 清理完成后旧异步调用尝试写入 / 关闭后立即重新开启旧事件是否进入新周期；核心断言「关闭完成后旧观察周期无任何记录落盘」。
- 隐私：新增字段全在白名单（`lifecycle` / `disposition` / `exclude_reason` / `support` / `required_check_count` / `verify_unusable_reason` 都是枚举或整数；**`assertion_count` 不在白名单、不记账**）；排除原因按层级分离；账本不含 `answer` / `quote` / `page` / `path`、不含断言正文与清单正文；设计稿与样例 tarball 逐文件敏感词扫描沿用 P0 门禁。
- 兼容性：`wiki_observe` 旧字段不删、类型不改；`knowledge-gateway.v1.schema.json` 文件哈希不变（只读断言，**不为 `checked_rules` 偏差补字段、不改契约**）；Python 管线调用入参不变；`checked_rules` 偏差只登记在「风险与残余风险」，无对应实现改动。
- 既有 18 个测试文件 + `node tests/gateway.mjs`（CI 降级路径 11/11）保持全绿；CI 六格矩阵不变。

## 风险与残余风险（延续 P0 的登记方式，不假装删干净）

1. **插件不能从宿主侧阻断最终消息**。L1/L2 是硬触发文本，L3 给「输出前必须核验」的约束，L4 让未核验可见；但本轮没有 pre-output 拦截钩子。因此 `converged` 只能证明「观察到的核验链收敛」，不能证明最终输出的那版答案通过核验（A → Verify 报违规 → B → Verify 返回 `ok` → 最终输出前又改成 C，账本证明 B 通过，不能证明 C 与 B 一致）。收敛指标固定命名「观察到的核验链收敛率」，不用「最终回答正确率 / 答案修正成功率」。若将来 `agent/turn-stopping` 被实测确认可作为可靠边界，再单独评估是否加拦截——那是另一个请求，不在 P1 范围。P1 证明的是「能发现、能记录、能连续实测」，不是「保证每个回答都核验过」。
2. **TTL `expired` 不是漏查判定**。没有可靠回合结束信号，超时只能说明「在规定时间内没有观察到后续事件」。
3. **重启后 `unobserved` 会累积**。没有持久化中断标记就一律排除，报表要如实展示排除数量与原因；这比补造 `interrupted` 诚实，但会让长周期观察的有效样本变少。
4. **关闭观察是破坏性动作**。用户拍板维持既有语义；实现必须靠界面文案与返回体说清，不能变成无提示数据丢失。
5. **双日志源**。Python 私有管线的观察日志与插件事件账本并存；`governance` 命名空间隔离，指标以插件侧为准，Python 原 `totals` / `revision` 保留但不混算。
6. **旧发布物残余风险**沿用 P0：npm 1.4.0/1.4.1/1.4.2 与旧 Release 资产里的早期演示语料不会自行消失，已 `deprecated`；git 历史 `36cfe85` 不重写。P1 不重新打开这个议题。
7. **模型仍可能不守提示**。这是本设计要量化暴露的对象，不是靠加一句更凶的提示就能消灭；指标与 `not_rechecked` 就是用来连续观察它的。
8. **测量能力边界（m03601 只读核查结论）**。冻结契约的 verify 返回体只有聚合结果：检查通过的项目不出现，`status:'ok'` 无法区分「跑了若干规则全过」与「根本没跑」；`violations[].rule` 只列报违规的规则、与槽位 id / `evidence_id` 没有一一映射。因此「必核项逐项核验完成」与「断言数量」**两项都测不了**，只能诚实改名为「必核项 Context 核验触发率」、把 `assertion_count` 标为数据不可用。若把这两项写成可测，仪表盘数字会「在变化但表达的不是我们以为的东西」——这比暂时没有仪表盘更危险。
9. **已知契约与实现偏差：`checked_rules`**。schema 描述「本次实际参与核验的规则条数」，但 `answer_policy.py:219` 的 `check_answer` 返回体只有 `ok` / `violations` / `notices`，`context_snapshot.py:228` 取到 `None`，`wiki_bridge.py:275-318` 不补 → 运行时恒为 `null`；样例里的 `10` 是理想化占位。它既不能作为断言数量，也不能证明逐项核验。**P1 只登记、不修复**：Python Gateway v1 已冻结，后续是否修复另行立项。CI 只做 schema 文件哈希不变的只读断言，不借机改契约。

## 我替你定的小决定（my call，修订版，待完整审核）

| # | 内容 | 状态 |
|---|---|---|
| ① | 四层 = L1 总纲 / L2 四工具 description / L3 结果约束 / L4 账本与指标；前三进模型上下文，L4 不进 system prompt | 不变 |
| ② | 治理总纲独立成第二个 `systemPrompt.context` 段（order 241），不进用户可 override 的主题词配置 | 不变 |
| ③ | 必核清单只列槽位 id / `evidence_id` 数 / 规则族，不推断事实；规则族测试按复审问题 5 分「CI 只读枚举断言 + 实现前人工兼容审核」两层 | 不变（按 Q8 补「只读不改」、按复审补两层） |
| ④ | ~~`expired` 外标签 `unconfirmed`，旧 `boot_ref` 未结算标 `interrupted`~~ | **作废**（就是那处必须修正的错误） |
| ⑤ | 修正轮次上限 4；超过 4 次仍有违规必须披露剩余问题 | 不变 |
| ⑥ | 不订阅会话结束事件、不新增定时器 / watcher；`boot_ref` 只用于识别「换了进程」，**不再用于推断任何状态** | 改写 |
| ⑦ | `session_ref` 用会话 id 短哈希；`event_id` 用 `context_id` + 工具 + `attempt_seq` + 时间戳哈希去重；重启后扫账本取 `attempt_seq` 的 max | 不变（补重启恢复） |
| ⑧ | ~~pending 内存态不跨重启，落盘最小化事件账本，重启后把无结算旧 context 归 `interrupted`~~ → **pending 内存态不跨重启；落盘只记已观察到的事实；重启后缺结算行且无显式中断标记的样本一律 `unobserved / excluded`，不补造、不回推** | 改写 |
| ⑨ | `wiki_observe` 只加 `governance` 一个可选命名空间；设置页只在「调用记录」页签内加指标块 | 不变 |
| ⑩ | 默认 TTL 1800 秒、`PENDING_MAX = 512`、账本 5000/2500 轮转、CI 六格不变、只把 `tests/governance.mjs` 挂进 `npm test` | 不变 |

### 本阶段不生产 `interrupted`（并入 my call ⑥ / ⑧ 的明确说明，不新增第 11 条）

`ctx.on('dispose')` 不可靠、会话结束事件未确认 ⇒ 不写任何中断标记，`interrupted` 状态位保留但无生产者。所有「旧 boot_ref / 容量淘汰 / 无结算行」样本一律 `disposition:'unobserved'`。合用户口径「保留 `unobserved` 比强行恢复状态更诚实」。这是 my call ⑥（boot_ref 不推断状态）与 ⑧（重启只排除、不补造）的合并结论，不单列为新的待审事项。

### 被用户拍板否决的 my call（如实登记）

- 我曾推荐 Q3「保留非破坏性语义（只停新增、历史与 governance 保留）」、Q8「允许给 schema 的 `observe_stats` 补 `governance` 声明」——**两条均被否决**。现按 Q3 破坏性清空、Q8 schema 冻结执行，不留在方案里当备选。

## 三类问题结论

### A 已答（用户口径已覆盖，照录进稿）

- 正交维度：生命周期 `completed` / `expired` / `interrupted` + 观察配置 `disabled` + 样本处置 `unobserved / excluded`，互不推导。
- `unobserved` 不填零、不悄悄消失，必须带数量与原因；`expired` 不进确认漏查分子。
- 关闭期间指标不可用而非零违规；`disabled` 不是样本生命周期事件，也不是样本排除原因。
- `not_rechecked` ≠ 模型拒绝修正；TTL 只是 pending 生命周期结算，不是漏查判定。
- 兼容性：Python Gateway v1 冻结、`wiki_observe` 不新增工具、旧字段不删不改。

### B 我可定（已并入上面各节，随 my call 一并审核）

1. 本阶段不生产 `interrupted`（见 my call ⑥ / ⑧）。
2. 快照失效 / 执行失败的 Verify：**调用级**记录 `verify_unusable_reason`，不进任何分子、不标 `completed`、不把所属 Context 标为 `unobserved`、推进 `attempt_seq`。当前冻结契约下「无可核验断言」不可判定，不产生 `no_assertion` 样本；整体断言测量能力缺失由 `assertion_measurement.state = 'unavailable'` 表达。
3. 白名单只新增枚举 / 整数字段（`lifecycle` / `disposition` / `exclude_reason` / `support` / `required_check_count` / `verify_unusable_reason`），排除原因按样本级 / 调用级 / 全局三层分开；同步更新隐私断言。**`assertion_count` 按 m03601 不记账、标数据不可用**，不写 0。
4. 必核清单期望输出以样例实际内容为准重写；补一份覆盖 `missing` 的虚构 fixture；「不含数值 / 引文 / 路径」只约束新增清单段，不重写整段 `renderContext`。
5. 收敛诊断独立保留：`converged` = 首次违规后最后一次**有效** Verify 为 `ok`；中间 ok 后又违规 → `unresolved`；违规后零次有效复核 → `not_rechecked`；`context_missing` / `context_expired` / `context_corrupt` 不算有效复核；`attempt_seq` 重启扫账本取 max。命名为「观察到的核验链收敛率」。
6. 失败路径原样返回 `base`，不给 `additionalProperties:false` 的 `error_envelope` 塞键；「观察不可用」由 `renderObserve` 与 `GET /calls` 表达（Q8 冻结契约后的必然结果，替代修订前「同层返回独立 governance 对象」）。
7. 常量与文件拆分、DOM / CSS 类名、`createJsonlStore` 形状、测试先行提交切分——reviewer 已明确跳过，归实现期。

### C 用户已拍板（Q2 / Q3 / Q8，见「用户拍板记录」；复审决定见文末，不再重复）

## 留给 builder 的

- L1 / L2 的最终中文文案（语义不可减，字数可压）；常量命名与文件拆分（`lib/governance.js` 是否再拆 `lib/jsonl-store.js`）。
- 指标面板的 DOM 与 CSS 类名，沿用 `wn-` 前缀变量。
- `createJsonlStore` 抽取时保持 `createCallLog` 的既有返回形状不变，避免波及 `/calls` 与 18 个既有测试。
- 写实现计划时把「测试先行」拆成可单独跑绿的提交。
- 关闭观察的并发手段（串行化 `record` 单写者队列 vs `cycle_ref` 观察周期标识）二选一，实现期定；不新增后台任务或依赖。
- `assertion_count` **不再有取值来源问题**（m03601 已拍板数据不可用）：本阶段不记录该字段、不从 `checked_rules` / 违规条数 / Python 快照推断，也不改契约补字段；`governance` 只返回 `assertion_measurement.state = 'unavailable'`。实现期要做的是保证 UI 不把它显示成 `0`，而不是找计数来源。

## 复审记录（m03499）与待确认项

用户审完 433 行稿后给出：**设计方向通过 / 当前稿暂不完整通过 / 待修订复审**。三项待确认问题的决定：

| 审核项 | 决定 |
|---|---|
| Q2：新指标与旧基线 | **并存，分层管理**；新三项作为正式指标，旧基线保留历史意义，不强行换算 |
| Q3：收敛诊断 | **保留为独立诊断维度**，不并入 Q2 三项 |
| Q8：其余设计 | **原则通过**，修正若干实现前置问题后整体通过 |

### 通过清单（保持原样，未推翻）

方案 A 插件侧治理 / Python Gateway v1 冻结 / 不新增第五个工具 / 四层提示与反馈架构 / 治理总纲独立于用户可覆盖的主题提示 / 必核清单只使用现有证据和缺口 / 不跨重启恢复 pending、不伪造 `interrupted` / TTL 惰性扫描不新增 watcher·timer / 关闭观察先阻断再破坏性清空 / 观察账本最小化记录 / Python 错误信封原样返回 / 不扩大 CI 六格矩阵。用户特别肯定「重启后 `unobserved`」「Python Gateway v1 不动」「关闭观察破坏性清空」三处。用户明确没有推翻 A/B/C 结论、Q2 / Q3 / Q8 拍板，也没有要求新增工具或修改 Python 契约。

### 六处必修与落点（本次已逐处修订）

| # | 问题 | 落点 |
|---|---|---|
| 1 | 字段不足以重建 Q2 指标 | 白名单加 `required_check_count`（`support` 不能反推必核清单）；三行分母表改用该字段；`governance.metrics` 加 `partial_insufficient` 分组。**按 m03601 定点修订**：原一起加的 `assertion_count` 已改为「数据不可用、不记账」，指标 #1 正式改名为「必核项 Context 核验触发率」 |
| 2 | 排除原因混合层级 | `exclude_reason`（样本级）/ `verify_unusable_reason`（调用级）/ `observe_enabled`（全局）三层分开；移除 `disabled` 样本排除；Verify 不可用不整体排除 Context；`excluded` 拆 `context_samples` / `verify_calls` |
| 3 | TTL 与统计窗口边界 | 固定事件顺序、迟到 Verify 政策、`days` 三项各自时间轴、窗口口径表 |
| 4 | L1 跳过条件矛盾 + 跨页结论 | 跳过条件改写；跨页结论采用「缩小 L1 触发描述」，映射表给 `duplicate_as_independent` 加注 |
| 5 | 测试门禁证明不了全部声明 | 规则族门禁分 CI + 实现前人工兼容审核两层；L2 测试覆盖四个工具 + `DESCRIPTION` 注册引用关系 |
| 6 | 关闭观察并发测试 | 补三类竞态用例，核心断言「关闭完成后旧周期无记录落盘」；实现手段列进「留给 builder」 |

另按复审第四节写进指标解释：收敛指标命名「观察到的核验链收敛率」，`converged` ≠ 最终回答已证明可靠（A→B→C 例，本轮无 pre-output 拦截）。

### 最终审核决定（用户收束，照录）

| 项目 | 最终决定 |
|---|---|
| Q2 新指标与旧基线 | 并存分层 |
| Q2 三项指标 | 新版正式指标 |
| 4/7 | 历史基线，不直接映射新分母 |
| 2/5 | 高风险 Context 分组历史基线，目标仍为 100% |
| 1/4 | 收敛诊断历史基线，目标仍为 50% |
| 收敛状态 | 独立保留三个分类 |
| 方案 A | 通过 |
| Python Gateway v1 冻结 | 通过 |
| 四层治理设计 | 原则通过，修正触发条件和测试覆盖 |
| 必核清单 | 原则通过，补齐核验规则映射 |
| pending 与重启处理 | 通过，补齐 TTL 边界和统计口径 |
| 隐私字段 | 原则通过，修正统计字段和层级 |
| `calls.enabled` | 通过，补齐并发测试 |
| CI 测试门禁 | 原则通过，区分自动验证与人工兼容审核 |

### 复审待确认项（我替你定的边界，请一并确认）

1. ~~迟到有效 Verify 的政策~~：**已由用户 m03533 复审通过**——`expired` 不回退、迟到 Verify 只记事实、不进「必核项 Context 核验触发率」分子、单列 `late_verify` 诊断。不再是待确认项。
2. ~~跨页结论二选一~~：**已由用户 m03533 复审通过**——采用「缩小 L1 触发描述」，`duplicate_as_independent` 限定「仅单页多引擎被当成两个独立来源」。不再是待确认项。
3. ~~`assertion_count` 取值来源~~：**已由用户 m03601 拍板**——数据不可用，不计算、不展示百分比、不记 0；`checked_rules` 偏差只登记不修复。不再是待确认项。
4. **本稿是否整体通过**：m03712 逐行复审 657 行版后给出「五项通过、一项需补定义、一项存在旧语义残留」；五处定点收紧已落盘，待用户按「最后一次针对性复审」确认；确认前仍不批准实施。

> **架构与范围：通过。Q2 / Q3 / Q8 决策：已拍板。六处必修：#2–#6 已通过，#1 经 m03601 定点修订。指标名称与测量能力：已按冻结契约收紧（核验触发率 / 违规发现率 / 断言数据不可用 / `checked_rules` 偏差登记）。m03712 五处定点收紧：已落盘，待针对性复审。实施状态：未批准——实现代码冻结、不提交、不进入 writing-plans、不扩范围。**
