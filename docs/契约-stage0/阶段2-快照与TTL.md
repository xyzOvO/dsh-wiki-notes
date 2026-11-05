# 阶段 2（仅 F4）：context 快照 + TTL

> 范围：只做 F4。F3（support_reason）、F5（子查询漂移）、别名补齐都没动。
> 依据：用户 2026-11-05 的六条回归要求 + 一条接口细节（context_id 与 observe_id 分开）。

## 1 为什么必须先有快照

`wiki_verify` 的输入是 `context_id`，不是「重新检索一遍」。如果核验时重建上下文，
会出现两种恶性情况：

- 页面改了 → 拿新证据判旧回答，回答被「事后判错」；
- 检索抖了（子查询漂移、引擎降级）→ 同一份回答两次核验结论不同，不可复现。

所以核验只能对着**当初交给 LLM 的那份证据**做。快照就是这个「当初」。

## 2 交付物

| 文件 | 说明 |
| --- | --- |
| `<你的库根目录>\工具-tools\context_snapshot.py` | 新增：save / load / verify_answer / purge_expired + CLI |
| `<你的库根目录>\工具-tools\answer_policy.py` | `check_answer()` 现在同时返回 `notices`（原有数值判据的提示不再被吞掉） |
| `_tools\eval\eval_snapshot.py` | 新增：12 条验收（六条要求 × 细分） |
| `docs\契约-stage0\knowledge-gateway.v1.schema.json` | 新增 `E_CONTEXT_CORRUPT` 与 `verify.status=context_corrupt` |
| `docs\契约-stage0\samples\verify.context-expired.json` / `verify.context-corrupt.json` | 两份真实输出样例 |

## 3 快照里存什么

```json
{"snapshot_version":"1","contract_version":"1.0","context_id":"ctx_…",
 "created_at":"…","expires_at":"…","ttl_seconds":1800,
 "query":"重庆 申论 考几道题","root":"<你的库根目录>\\知识层-wiki",
 "payload_sha256":"…","pages":{"概念-concepts/重庆申论考情.md":"a1b2…"},
 "payload":{ /* 完整 context，原样 */ }}
```

- `payload` 是整份 context 的深拷贝，**不做裁剪**——证据、`matched`（检索层级）、`provenance`（哪个引擎、第几名、哪个查询单元）、`supports`（槽位、引文、是否需要复核）全部保留。
- `payload_sha256` 是规范化 JSON 的 sha256，读回时校验；对不上就是 `corrupt`，绝不「尽量用」。
- `pages` 记录每张证据页当时的指纹。页面后来变了，核验仍按快照执行，但会带一条 `snapshot.page_changed` 提示——不静默，也不推翻结论。

## 4 四种状态，各有各的话

| 状态 | error.code | 含义 | retryable |
| --- | --- | --- | --- |
| `ok` | — | 正常核验 | — |
| `violations_found` | — | 核验完成，有违规 | — |
| `context_missing` | `E_CONTEXT_NOT_FOUND` | 没这个 id | false |
| `context_expired` | `E_CONTEXT_EXPIRED` | 超时，需重新取上下文 | **true** |
| `context_corrupt` | `E_CONTEXT_CORRUPT` | 文件坏了或被改过 | false |

损坏与丢失分开：文件不见了可能是清理；文件在但校验失败说明**有人动过**，这两件事的处置完全不同。

## 5 并发与原子性

- `context_id = "ctx_" + uuid4().hex[:16]`，冲突概率可忽略；
- 写入走 `mkstemp` + `os.replace`，读的人只会看到「没有」或「完整」，看不到半个文件；
- 读路径无全局缓存、无共享状态，纯函数式读盘。

## 6 接口细节：context_id 与 observe_id

按用户的判断落地：**`context_id` 是快照的唯一引用**（本次核验凭这个找回证据），`observe_id` 是观察日志的编号（阶段 3 自动观察时生成）。契约里两个字段本来就有，这次只是让上下文侧真的产出 `context_id`，没有改字段名，也没有把两者合并。

## 7 验收（12/12，全部实跑）

| # | 要求 | 用例 | 结果 |
| --- | --- | --- | --- |
| 1 | 快照后另一个进程核验，结果与原上下文一致 | 进程 A 保存，进程 B 核验，与本地 `check_answer` 比 violations 集合 | ✓ |
| 2 | 重启进程后仍能验证未过期快照 | 再起进程 C，结果与 B 逐字段相同 | ✓ |
| 3 | 过期 / 丢失 / 损坏分别明确 | 3a 随机 id→missing；3b ttl=1→expired（带过期时间文案）；3c 改 payload→corrupt；3d 半截 JSON→corrupt | ✓✓✓✓ |
| 4 | 验证不重新检索、不重建上下文 | 把 `context_builder.build` 换成抛异常的桩，核验照常通过、调用计数 0 | ✓ |
| 5 | 证据 / 范围 / provenance 不丢不改 | payload 与原 ctx 深度相等；provenance/matched/supports 均在；核验前后快照字节不变 | ✓ |
| 6 | 并发不串用 | 4 份内容不同的快照 × 4 线程 = 16 次核验，各自判定互不污染 | ✓ |

同时回归：`eval_answer_policy` 8/8、`eval_numeric_claim` 13/13、`eval_support` 3/3、`eval_engine_state` 6/6、`eval_4d` 7/7、`e2e` 8 题漂移 0、`protect` 35 条漂移 0。

## 8 已知局限

1. **过期快照不自动删**：`purge_expired()` 要显式调用（或由插件定时调）。没清理的过期快照仍占磁盘，但不会误用——状态是 `expired`。
2. **TTL 固定 30 分钟起**：`save_context(ttl_seconds=…)` 可调，但没有「滑动续期」。一次核验窗口内够用，长期会话需要重新取上下文。
3. **不做快照加密与权限隔离**：目录是普通文件，同一台机器上的其他进程可读。当前场景（本机个人库）可接受，多用户场景必须另做。
4. **`snapshot.page_changed` 只是提示**：页面变了不改变核验结论，只多一条 notice。要不要据此降级为「需复核」，留给阶段 3 决定。

## 9 下一步（按用户定的顺序）

F3 support_reason → 考试类型别名 → F5 子查询漂移。本轮未动其中任何一项。
