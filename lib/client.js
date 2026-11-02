/**
 * dsh-wiki-notes —— 浏览器半侧（手写 __ModuleLoader__ bundle，不需要构建工具）。
 *
 * 在设置页里加一个「知识库」入口，可以：
 *   - 看到当前生效的库路径，以及它是从哪一层来的（config > 环境变量 > 配置文件 > 默认）；
 *   - 先「测试」一个候选路径能不能扫出页面，再决定要不要「保存」；
 *   - 看库的规模与红链数量，随时重扫。
 *
 * 与宿主半侧只走同源 HTTP（/api/wiki-notes/*），不碰 RPC：失败模式最少。
 * 改完用 `node --check lib/client.js` 验语法（它是表达式不是语句）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-wiki-notes',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useState = React.useState

    var API = '/api/wiki-notes'

    /* ------------------------------ HTTP ------------------------------ */

    function readJson(res) {
      return res.text().then(function (text) {
        var data = null
        try {
          data = text === '' ? null : JSON.parse(text)
        } catch (error) {
          data = null
        }
        if (!res.ok) {
          var message = data && data.error ? data.error : 'HTTP ' + res.status
          var failure = new Error(message)
          failure.status = res.status
          throw failure
        }
        return data
      })
    }

    function apiGet(path) {
      return fetch(API + path, { cache: 'no-store' }).then(readJson)
    }

    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }

    /* ------------------------------ 小组件 ------------------------------ */

    function Stat(props) {
      return h(
        'div',
        { className: 'wn-stat' + (props.tone ? ' wn-stat-' + props.tone : ''), title: props.hint || undefined },
        h('div', { className: 'wn-stat-value' }, props.value),
        h('div', { className: 'wn-stat-label' }, props.label),
      )
    }

    function Notice(props) {
      if (!props.message) return null
      var tone = props.tone || 'info'
      var mark = tone === 'ok' ? '✓' : tone === 'err' ? '!' : tone === 'warn' ? '!' : 'i'
      return h(
        'div',
        { className: 'wn-notice wn-notice-' + tone },
        h('span', { className: 'wn-notice-mark' }, mark),
        h('span', { className: 'wn-notice-text' }, props.message),
      )
    }

    function sourceTone(source) {
      if (source === 'env') return 'warn'
      if (source === 'default') return 'muted'
      if (source === 'unset') return 'warn'
      return 'ok'
    }

    /* ------------------------------ 设置页 ------------------------------ */

    function WikiNotesSection(props) {
      var stateTuple = useState(null)
      var state = stateTuple[0]
      var setState = stateTuple[1]

      var draftTuple = useState('')
      var draft = draftTuple[0]
      var setDraft = draftTuple[1]

      var busyTuple = useState('')
      var busy = busyTuple[0]
      var setBusy = busyTuple[1]

      var noticeTuple = useState(null)
      var notice = noticeTuple[0]
      var setNotice = noticeTuple[1]

      var probeTuple = useState(null)
      var probe = probeTuple[0]
      var setProbe = probeTuple[1]

      var apply = useCallback(function (data) {
        setState(data)
        setDraft(data && typeof data.root === 'string' ? data.root : '')
      }, [])

      var refresh = useCallback(
        function () {
          setBusy('load')
          return apiGet('/state')
            .then(function (data) {
              apply(data)
              return data
            })
            .catch(function (error) {
              setNotice({ tone: 'err', text: '读状态失败：' + error.message })
            })
            .then(function () {
              setBusy('')
            })
        },
        [apply],
      )

      useEffect(
        function () {
          refresh()
        },
        [refresh],
      )

      // 统一管 busy 与异常。成功文案由各 handler 自己给 —— 早先这里塞一句通用
      // describe，会把 handler 刚写进去的「保存失败」错误提示盖成成功，必须各管各的。
      function run(kind, task) {
        setBusy(kind)
        setNotice(null)
        return Promise.resolve()
          .then(function () {
            return task()
          })
          .catch(function (error) {
            setNotice({ tone: 'err', text: error.message })
            return null
          })
          .then(function (data) {
            setBusy('')
            return data
          })
      }

      function onCheck() {
        var target = draft.trim()
        setProbe(null)
        run('check', function () {
          return apiPost('/check', { root: target }).then(function (result) {
            setProbe(result)
            if (result && result.ok === true) {
              var stats = result.stats || {}
              setNotice({
                tone: 'ok',
                text: '这条路径能扫：' + (stats.pages || 0) + ' 页 / ' + (stats.resources || 0) + ' 份资料（' + (result.ms || 0) + ' ms）',
              })
            } else {
              setNotice({ tone: 'err', text: (result && result.error) || '这个路径扫不出页面' })
            }
            return result
          })
        })
      }

      function onSave() {
        var target = draft.trim()
        run('save', function () {
          return apiPost('/save', { root: target }).then(function (data) {
            apply(data)
            setProbe(null)
            if (data && data.ok === false) {
              setNotice({ tone: 'err', text: '已保存，但这个路径读不出来：' + (data.error || '未知错误') })
            } else {
              var stats = (data && data.stats) || {}
              setNotice({ tone: 'ok', text: '已保存并生效：扫描到 ' + (stats.pages || 0) + ' 页' })
            }
            return data
          })
        })
      }

      function onRescan() {
        run('scan', function () {
          return apiPost('/rescan', {}).then(function (data) {
            // 只更新 state，不碰 draft —— 用户可能正在输入另一个路径
            setState(data)
            var stats = (data && data.stats) || {}
            setNotice({ tone: 'ok', text: '已重新扫描：' + (stats.pages || 0) + ' 页' })
            return data
          })
        })
      }

      function onReset() {
        run('save', function () {
          return apiPost('/save', { root: '' }).then(function (data) {
            apply(data)
            setProbe(null)
            setNotice({ tone: 'ok', text: '已清掉配置文件，回到上一层（环境变量或内置默认）' })
            return data
          })
        })
      }

      var stats = (state && state.stats) || {}
      var savedRoot = state && typeof state.savedRoot === 'string' ? state.savedRoot : ''
      var envRoot = state && typeof state.envRoot === 'string' ? state.envRoot : ''
      var changed = state !== null && draft.trim() !== (state.root || '')
      // 空状态：一次都没配过库路径（区别于「配了但扫不到」——那是另一条提示）
      var isUnset = state !== null && (state.source === 'unset' || state.root === '')

      return h(
        'div',
        { className: 'wn-root' },

        h(
          'div',
          { className: 'wn-head' },
          h('div', { className: 'wn-title' }, '知识库'),
          h(
            'div',
            { className: 'wn-sub' },
            '模型通过 wiki_recall 工具检索这个库（只读）。这里只改「库在哪」，不改「怎么检索」。',
          ),
        ),

        state === null
          ? h(
              'div',
              { className: 'wn-loading' },
              h('span', { className: 'wn-dim' }, busy === 'load' ? '读取中…' : '未连接宿主（插件没启动或 API 不可达）'),
              busy === 'load' ? null : h('button', { className: 'wn-btn', onClick: refresh }, '重试'),
            )
          : h(
              'div',
              { className: 'wn-statusbar' },
              h('span', { className: 'wn-dot ' + (state.watch === 'on' ? 'wn-dot-on' : 'wn-dot-off') }),
              h(
                'span',
                null,
                state.watch === 'on' ? '实时同步：改完笔记立刻可见' : '未监听目录：改完笔记最多 30 秒后生效',
              ),
              (state.stats && (state.stats.pages || 0) > 0)
                ? h(
                    'span',
                    { className: 'wn-statusbar-extra' },
                    '· 扫描 ' + state.stats.pages + ' 页 / ' + (state.stats.scannedMs || 0) + ' ms',
                  )
                : null,
            ),

        state === null
          ? null
          : h(
              'div',
              { className: 'wn-stats' },
              h(Stat, { value: stats.pages || 0, label: '页面' }),
              h(Stat, { value: stats.resources || 0, label: '资料' }),
              h(Stat, {
                value: stats.brokenPages || 0,
                label: '有红链的页',
                tone: (stats.brokenPages || 0) > 0 ? 'warn' : '',
                hint: '红链 = 笔记里提到、但库里还没有对应页面的双链。数量多说明有概念只被引用、还没成页。',
              }),
            ),

        (state !== null && state.scale) ? h('div', { className: 'wn-scale' }, state.scale) : null,

        (state !== null && Array.isArray(state.topics) && state.topics.length > 0)
          ? h(
              'div',
              { className: 'wn-topics' },
              h('div', { className: 'wn-topics-label' }, '模型每回合会看到这些主题词，沾到它们的问题它会自己来查库：'),
              h(
                'div',
                { className: 'wn-chips' },
                state.topics.map((item) =>
                  h('span', { key: item.tag, className: 'wn-chip' }, item.tag + ' \u00d7' + item.count),
                ),
              ),
            )
          : null,

        (state !== null && !isUnset && (stats.pages || 0) > 0 && !(Array.isArray(state.topics) && state.topics.length > 0))
          ? h(Notice, { tone: 'warn', message: '这些页都没有 标签 字段——模型不会自己想起查库，只能由你每次说「我笔记里」。' })
          : null,

        (state !== null && state.ok === false)
          ? h(Notice, { tone: 'err', message: '当前库读不出来：' + (state.error || '未知错误') })
          : null,

        (state !== null && !isUnset && (stats.pages || 0) === 0)
          ? h(Notice, { tone: 'warn', message: '这个路径里没扫到任何 .md 页面 —— 确认它指向的是笔记目录本身，而不是它的上一级。' })
          : null,

        (state !== null && state.scannedRoot && state.scannedRoot !== state.root)
          ? h(Notice, { tone: 'warn', message: '这个路径本身不是知识层，实际读的是它里面的：' + state.scannedRoot })
          : null,

        state === null
          ? null
          : h(
              'div',
              { className: 'wn-card' + (isUnset ? ' wn-card-empty' : '') },
              h(
                'div',
                { className: 'wn-card-head' },
                h('span', { className: 'wn-card-title' }, isUnset ? '还没配置' : '当前生效'),
                h(
                  'span',
                  { className: 'wn-badge wn-badge-' + sourceTone(state.source) },
                  state.sourceLabel || state.source || '',
                ),
              ),

              isUnset
                ? h(
                    'div',
                    { className: 'wn-steps' },
                    h('div', { className: 'wn-step' }, h('span', { className: 'wn-step-n' }, '1'), '填一个放着 .md 笔记的目录（是它本身，不是上一级）'),
                    h('div', { className: 'wn-step' }, h('span', { className: 'wn-step-n' }, '2'), '点「测试」—— 只看能扫出多少页，不会改动任何东西'),
                    h('div', { className: 'wn-step' }, h('span', { className: 'wn-step-n' }, '3'), '点「保存并生效」，之后模型就能查这个库了'),
                  )
                : h('div', { className: 'wn-path' }, state.root || '（空）'),

              h(
                'div',
                { className: 'wn-field-row' },
                h('input', {
                  className: 'wn-input',
                  value: draft,
                  spellCheck: false,
                  'aria-label': '知识库目录路径',
                  placeholder: '例如 D:\\笔记\\我的知识库 或 /home/me/notes',
                  onChange: function (event) {
                    setDraft(event.target.value)
                    setProbe(null)
                  },
                  onKeyDown: function (event) {
                    if (event.key === 'Enter' && busy === '') onCheck()
                  },
                }),
              ),

              h(
                'div',
                { className: 'wn-actions' },
                h('button', { className: 'wn-btn', disabled: busy !== '', onClick: onCheck }, busy === 'check' ? '测试中…' : '测试'),
                h(
                  'button',
                  {
                    className: 'wn-btn wn-btn-primary',
                    disabled: busy !== '' || (!changed && draft.trim() === (state.root || '')),
                    onClick: onSave,
                  },
                  busy === 'save' ? '保存中…' : changed ? '保存并生效' : '已保存',
                ),
                h('button', { className: 'wn-btn', disabled: busy !== '', onClick: onRescan }, busy === 'scan' ? '扫描中…' : '重新扫描'),
                h('span', { className: 'wn-actions-spacer' }),
                savedRoot !== ''
                  ? h('button', { className: 'wn-btn wn-btn-ghost', disabled: busy !== '', onClick: onReset }, '清掉配置')
                  : null,
              ),

              h(Notice, { tone: notice && notice.tone, message: notice && notice.text }),

              (probe && probe.ok === true && probe.stats)
                ? h(
                    'div',
                    { className: 'wn-chips' },
                    h('span', { className: 'wn-chip' }, (probe.stats.pages || 0) + ' 页'),
                    h('span', { className: 'wn-chip' }, (probe.stats.resources || 0) + ' 份资料'),
                    h(
                      'span',
                      { className: 'wn-chip' + ((probe.stats.brokenPages || 0) > 0 ? ' wn-chip-warn' : '') },
                      (probe.stats.brokenPages || 0) + ' 页有红链',
                    ),
                    h('span', { className: 'wn-chip wn-chip-dim' }, (probe.ms || 0) + ' ms'),
                  )
                : null,

              (probe && probe.ok === true && probe.hint) ? h(Notice, { tone: 'warn', message: probe.hint }) : null,

              envRoot !== ''
                ? h(Notice, { tone: 'warn', message: '环境变量 DSH_WIKI_ROOT 正在覆盖这个值（' + envRoot + '），保存也盖不过它。' })
                : null,

              h(
                'details',
                { className: 'wn-details' },
                h('summary', null, '配置来源与优先级'),
                h(
                  'div',
                  { className: 'wn-details-body' },
                  h('div', { className: 'wn-hint' }, '当前值来自：' + (state.sourceLabel || '?')),
                  h('div', { className: 'wn-hint' }, '配置文件：' + (state.configFile || '?')),
                  savedRoot !== ''
                    ? h('div', { className: 'wn-hint' }, '文件里的值：' + savedRoot)
                    : h('div', { className: 'wn-hint' }, '还没有配置文件，保存后会写一个。'),
                  h('div', { className: 'wn-hint' }, '内置默认：' + (state.defaultRoot || '（空）')),
                  h('div', { className: 'wn-hint wn-hint-dim' }, '优先级：插件 config > 环境变量 > 配置文件 > 内置默认'),
                ),
              ),
            ),

        h('div', { className: 'wn-foot' }, '只读：这个页面不会改知识库里的任何文件。'),
      )    }

    /* ------------------------------ 样式 ------------------------------ */

    var CSS = [
      '.wn-root{',
      '--wn-fg:var(--dsw-alias-label-primary,#1f1c18);',
      '--wn-muted:var(--dsw-alias-label-secondary,#6f6558);',
      '--wn-faint:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-dimmed,#8a7f6e));',
      '--wn-card:var(--dsw-alias-bg-layer-1,#fffdf8);',
      '--wn-bar:var(--dsw-alias-bg-layer-2,#f4efe4);',
      '--wn-field:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#fbf7ef));',
      '--wn-line:var(--dsw-alias-border-l2,#e3daca);',
      '--wn-line-soft:var(--dsw-alias-border-l1,#ece5d8);',
      '--wn-brand:var(--dsw-alias-brand-primary,var(--dsw-alias-button-primary-fill,#1f1c18));',
      '--wn-brand-fg:var(--dsw-alias-label-primary-foreground,#fffdf8);',
      '--wn-ok:var(--dsw-alias-state-success-primary,#2f6b46);',
      '--wn-warn:var(--dsw-alias-state-warn-primary,#8a6a2f);',
      '--wn-err:var(--dsw-alias-state-error-primary,#a83a2c);',
      "font-family:var(--dsw-font-family-sans,var(--dsw-font-family,-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif));",
      'color:var(--wn-fg);display:flex;flex-direction:column;gap:14px;padding:2px;box-sizing:border-box;max-width:100%;}',
      '.wn-title{font-size:15px;font-weight:650;letter-spacing:.2px;}',
      '.wn-sub{font-size:12.5px;color:var(--wn-muted);margin-top:5px;line-height:1.6;}',
      '.wn-dim{font-size:12.5px;color:var(--wn-faint);}',
      '.wn-stats{display:flex;gap:10px;flex-wrap:wrap;}',
      '.wn-stat{flex:1 1 96px;min-width:96px;background:var(--wn-bar);border:1px solid var(--wn-line-soft);border-radius:10px;padding:10px 12px;}',
      '.wn-stat-value{font-size:22px;font-weight:600;line-height:1.15;font-variant-numeric:tabular-nums;}',
      '.wn-stat-label{font-size:11.5px;color:var(--wn-muted);margin-top:3px;}',
      '.wn-stat-warn .wn-stat-value{color:var(--wn-warn);}',
      '.wn-scale{font-size:12px;color:var(--wn-faint);}',
      '.wn-card{background:var(--wn-card);border:1px solid var(--wn-line);border-radius:12px;padding:13px 14px;display:flex;flex-direction:column;gap:10px;}',
      '.wn-card-head{display:flex;align-items:center;gap:8px;}',
      '.wn-card-title{font-size:12.5px;font-weight:600;color:var(--wn-muted);}',
      '.wn-badge{font-size:11px;padding:2px 7px;border-radius:999px;border:1px solid var(--wn-line);color:var(--wn-muted);background:var(--wn-bar);white-space:nowrap;}',
      '.wn-badge-ok{color:var(--wn-ok);border-color:color-mix(in srgb,var(--wn-ok) 35%,transparent);}',
      '.wn-badge-warn{color:var(--wn-warn);border-color:color-mix(in srgb,var(--wn-warn) 35%,transparent);}',
      '.wn-badge-muted{color:var(--wn-faint);}',
      '.wn-path{word-break:break-all;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;background:var(--wn-field);border:1px solid var(--wn-line-soft);border-radius:8px;padding:8px 10px;}',
      '.wn-field-row{display:flex;gap:8px;}',
      '.wn-input{flex:1 1 auto;min-width:0;box-sizing:border-box;font-size:12.5px;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);color:var(--wn-fg);background:var(--wn-field);border:1px solid var(--wn-line);border-radius:8px;padding:8px 10px;outline:none;}',
      '.wn-input:focus{border-color:var(--wn-brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--wn-brand) 18%,transparent);}',
      '.wn-actions{display:flex;gap:8px;flex-wrap:wrap;}',
      '.wn-loading{display:flex;align-items:center;gap:10px;}',
      '.wn-btn{font-size:12.5px;padding:7px 13px;border-radius:8px;border:1px solid var(--wn-line);background:var(--wn-bar);color:var(--wn-fg);cursor:pointer;white-space:nowrap;}',
      '.wn-btn:hover:not(:disabled){filter:brightness(.97);}',
      '.wn-btn:disabled{opacity:.5;cursor:default;}',
      '.wn-btn:focus-visible,.wn-input:focus-visible{outline:2px solid var(--wn-brand);outline-offset:2px;}',
      '.wn-btn-primary{background:var(--wn-brand);color:var(--wn-brand-fg);border-color:transparent;}',
      '.wn-btn-ghost{background:transparent;color:var(--wn-muted);}',
      '.wn-notice{font-size:12.5px;line-height:1.55;padding:8px 11px;border-radius:8px;border:1px solid var(--wn-line-soft);background:var(--wn-bar);color:var(--wn-muted);}',
      '.wn-notice-ok{color:var(--wn-ok);border-color:color-mix(in srgb,var(--wn-ok) 30%,transparent);background:color-mix(in srgb,var(--wn-ok) 8%,transparent);}',
      '.wn-notice-err{color:var(--wn-err);border-color:color-mix(in srgb,var(--wn-err) 30%,transparent);background:color-mix(in srgb,var(--wn-err) 8%,transparent);}',
      '.wn-notice-warn{color:var(--wn-warn);border-color:color-mix(in srgb,var(--wn-warn) 30%,transparent);background:color-mix(in srgb,var(--wn-warn) 8%,transparent);}',
      '.wn-probe{font-size:12px;color:var(--wn-muted);line-height:1.6;}',
      '.wn-hint{font-size:11.5px;color:var(--wn-faint);line-height:1.65;word-break:break-all;}',
      '.wn-hint-warn{color:var(--wn-warn);}',
      '.wn-hint-dim{opacity:.75;}',
      '.wn-head{display:flex;flex-direction:column;gap:3px;}',
      '.wn-statusbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:11.5px;color:var(--wn-faint);}',
      '.wn-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;}',
      '.wn-dot-on{background:var(--wn-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--wn-ok) 16%,transparent);}',
      '.wn-dot-off{background:var(--wn-faint);opacity:.5;}',
      '.wn-card-empty{border-style:dashed;}',
      '.wn-steps{display:flex;flex-direction:column;gap:7px;margin:2px 0;}',
      '.wn-step{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;line-height:1.6;color:var(--wn-muted);}',
      '.wn-step-n{flex:0 0 auto;width:17px;height:17px;border-radius:50%;background:var(--wn-bar);border:1px solid var(--wn-line);color:var(--wn-muted);font-size:11px;line-height:15px;text-align:center;font-weight:600;}',
      '.wn-chips{display:flex;gap:6px;flex-wrap:wrap;}',
      '.wn-topics{display:flex;flex-direction:column;gap:6px;}',
      '.wn-topics-label{font-size:11.5px;color:var(--wn-muted);}',
      '.wn-chip{font-size:11.5px;padding:2px 8px;border-radius:999px;background:var(--wn-bar);border:1px solid var(--wn-line-soft);color:var(--wn-muted);}',
      '.wn-chip-warn{color:var(--wn-warn);border-color:color-mix(in srgb,var(--wn-warn) 35%,transparent);}',
      '.wn-chip-dim{color:var(--wn-faint);}',
      '.wn-actions-spacer{flex:1 1 auto;}',
      '.wn-details{border-top:1px solid var(--wn-line-soft);padding-top:9px;margin-top:2px;}',
      '.wn-details summary{font-size:11.5px;color:var(--wn-muted);cursor:pointer;user-select:none;list-style:none;}',
      '.wn-details summary::-webkit-details-marker{display:none;}',
      '.wn-details summary::before{content:"▸ ";color:var(--wn-faint);}',
      '.wn-details[open] summary::before{content:"▾ ";}',
      '.wn-details-body{display:flex;flex-direction:column;gap:4px;padding-top:8px;}',
      '.wn-notice{display:flex;gap:7px;align-items:flex-start;}',
      '.wn-notice-mark{flex:0 0 auto;font-weight:700;opacity:.85;}',
      '.wn-notice-text{flex:1 1 auto;}',
      '.wn-foot{font-size:11.5px;color:var(--wn-faint);border-top:1px solid var(--wn-line-soft);padding-top:10px;}',
      '}',
    ].join('')

    /* ------------------------------ 注册 ------------------------------ */

    function apply(ctx) {
      ctx.effect(function () {
        var id = 'dsh-wiki-notes-styles'
        if (document.getElementById(id) === null) {
          var style = document.createElement('style')
          style.id = id
          style.textContent = CSS
          document.head.appendChild(style)
        }
        return function () {
          var element = document.getElementById(id)
          if (element !== null && element.parentNode !== null) element.parentNode.removeChild(element)
        }
      }, 'dsh-wiki-notes: styles')

      // settings.section = 设置弹层左侧的一级入口
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'wiki-notes',
            order: 47,
            label: function () {
              return '知识库'
            },
          },
          function (props) {
            return h(WikiNotesSection, props !== null && props !== undefined ? props : {})
          },
        )
      })
    }

    module.exports = {
      name: 'wiki-notes',
      inject: ['slots'],
      apply: apply,
    }
    return module.exports
  },
})
