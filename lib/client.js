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
    // 只为「同一时刻只允许一个操作」，真 React 一定有 useRef；测试 stub 没有时退回一个普通盒子。
    var useRef = React.useRef || function (value) {
      return { current: value }
    }

    var API = '/api/wiki-notes'

    // 请求最长等多久。宿主卡住时按钮不能永远停在「保存中…」。
    var TIMEOUT_MS = 15000
    // 扫一个库要读磁盘，给它比普通请求更长的耐心。
    var SCAN_TIMEOUT_MS = 60000

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

    /**
     * fetch + 超时。没有超时的话，宿主一旦不回话，busy 永远是 true，
     * 整个设置页所有按钮都会锁死，用户只能重开窗口。
     */
    function apiFetch(path, init, timeoutMs) {
      var ms = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : TIMEOUT_MS
      var controller = typeof AbortController === 'function' ? new AbortController() : null
      var options = {}
      Object.keys(init).forEach(function (key) {
        options[key] = init[key]
      })
      if (controller !== null) options.signal = controller.signal
      var timer =
        controller === null
          ? null
          : setTimeout(function () {
              controller.abort()
            }, ms)
      function done() {
        if (timer !== null) clearTimeout(timer)
      }
      return fetch(API + path, options).then(
        function (res) {
          return readJson(res).then(
            function (data) {
              done()
              return data
            },
            function (error) {
              done()
              throw error
            },
          )
        },
        function (error) {
          done()
          if (error !== null && error !== undefined && error.name === 'AbortError') {
            var failure = new Error('宿主 ' + Math.round(ms / 1000) + ' 秒没有响应。确认 DSH 还在运行，或稍后再试。')
            failure.timeout = true
            throw failure
          }
          throw error
        },
      )
    }

    function apiGet(path, timeoutMs) {
      return apiFetch(path, { cache: 'no-store' }, timeoutMs)
    }

    function apiPost(path, body, timeoutMs) {
      return apiFetch(
        path,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        },
        timeoutMs,
      )
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

    /** 字节数说人话：覆盖诊断里「读进来多少」比页数更能说明问题。 */
    function bytesLabel(value) {
      var bytes = typeof value === 'number' && value > 0 ? value : 0
      if (bytes === 0) return '0 KB'
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB'
      return (bytes / 1024 / 1024).toFixed(1) + ' MB'
    }

    /** ISO 时间转本机「月-日 时:分」；空值或坏值不编时间，直接给一个短横。 */
    function shortTime(iso) {
      if (typeof iso !== 'string' || iso === '') return '—'
      var date = new Date(iso)
      if (isNaN(date.getTime())) return '—'
      function pad(value) {
        return value < 10 ? '0' + value : String(value)
      }
      return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    /* ------------------------------ 设置页 ------------------------------ */

    function WikiNotesSection(props) {
      var stateTuple = useState(null)
      var state = stateTuple[0]
      var setState = stateTuple[1]

      var draftTuple = useState('')
      var draft = draftTuple[0]
      var setDraft = draftTuple[1]

      // 首帧就是 'load'：否则刷新回来之前会先闪一下「未连接宿主」。
      var busyTuple = useState('load')
      var busy = busyTuple[0]
      var setBusy = busyTuple[1]

      // 同一时刻只允许一个操作。busy 是 state，连点两下时闭包里读到的还是旧值，
      // 两次请求会一起发出去；用一个同步的盒子挡住。
      var busyRef = useRef('')

      // 清掉配置要按两次：第一次只把按钮变成「确认清掉？」，4 秒内不确认就复原。
      var confirmResetTuple = useState(false)
      var confirmReset = confirmResetTuple[0]
      var setConfirmReset = confirmResetTuple[1]

      var noticeTuple = useState(null)
      var notice = noticeTuple[0]
      var setNotice = noticeTuple[1]

      var probeTuple = useState(null)
      var probe = probeTuple[0]
      var setProbe = probeTuple[1]

      // 测试结果单独存在这里：只贴着「测试」那条操作栏显示，不跟保存/重扫的提示混在一起。
      var probeNoteTuple = useState(null)
      var probeNote = probeNoteTuple[0]
      var setProbeNote = probeNoteTuple[1]

      // 提示词草稿：只在首次读状态时初始化，之后由用户编辑/保存推动，
      // 免得「保存路径」时把正在编辑的提示词打回服务端旧值。
      var promptTuple = useState(null)
      var promptDraft = promptTuple[0]
      var setPromptDraft = promptTuple[1]

      // 页内视图：概览（路径、体检、提示词）与调用记录。
      // 不做成两个一级入口 —— 它们回答的是同一个问题「这个库现在怎么样」，
      // 拆成两个左侧入口只会让人多点一次，还得判断该进哪个。
      var tabTuple = useState('overview')
      var tab = tabTuple[0]
      var setTab = tabTuple[1]

      var apply = useCallback(function (data) {
        setState(data)
        setDraft(data && typeof data.root === 'string' ? data.root : '')
      }, [])

      var refresh = useCallback(
        function () {
          setBusy('load')
          // 读状态可能会当场扫一遍库，给它和「测试」一样长的耐心。
          return apiGet('/state', SCAN_TIMEOUT_MS)
            .then(function (data) {
              apply(data)
              setPromptDraft(function (current) {
                return current === null ? data.prompt || { enabled: true, override: '', extra: '' } : current
              })
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
        // 上一个操作还没回来，就当这次点击不存在——比让两个请求互相覆盖安全。
        if (busyRef.current !== '') return Promise.resolve(null)
        busyRef.current = kind
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
            busyRef.current = ''
            setBusy('')
            return data
          })
      }

      function onSavePrompt() {
        run('prompt', function () {
          return apiPost('/prompt', promptDraft).then(function (data) {
            setState(data)
            setPromptDraft(data.prompt)
            setNotice({ tone: 'ok', text: '提示词已保存，下一回合生效。' })
          })
        })
      }

      function onCheck() {
        if (busyRef.current !== '') return null
        var target = draft.trim()
        setProbe(null)
        if (target === '') {
          setProbeNote({ tone: 'warn', text: '输入框是空的——先填一个笔记目录。' })
          return null
        }
        // 点下去立刻给一句反馈：否则请求慢或失败时，界面看起来像「点了没反应」。
        setProbeNote({ tone: '', text: '正在扫描：' + target + ' …' })
        return run('check', function () {
          return apiPost('/check', { root: target }, SCAN_TIMEOUT_MS).then(
            function (result) {
              setProbe(result)
              if (result && result.ok === true) {
                var stats = result.stats || {}
                setProbeNote({
                  tone: 'ok',
                  text:
                    '这条路径能扫：' + (stats.pages || 0) + ' 页 / ' + (stats.resources || 0) + ' 份资料（' + (result.ms || 0) + ' ms）',
                })
              } else {
                setProbeNote({ tone: 'err', text: (result && result.error) || '这个路径扫不出页面' })
              }
              return result
            },
            function (error) {
              setProbeNote({ tone: 'err', text: '这次没测成：' + error.message })
              throw error
            },
          )
        })
      }

      function onSave() {
        var target = draft.trim()
        // 空输入框直接提交等于「把配置写成空」＝删掉库路径。这条口子必须堵在客户端，
        // 光靠服务端「显式传空串才清」挡不住——用户清空输入框再点保存，传的就是空串。
        if (target === '') {
          setNotice({
            tone: 'err',
            text: '输入框是空的。想换库就填新路径；想清掉已保存的路径，请点右边那个「清掉配置」。',
          })
          return
        }
        run('save', function () {
          return apiPost('/save', { root: target }, SCAN_TIMEOUT_MS).then(function (data) {
            // 服务端拒绝保存（路径扫不出页面）时不会落盘，也不该改输入框里的草稿
            if (data && data.ok === false && data.saved === false) {
              setNotice({ tone: 'err', text: '没有保存：' + (data.error || '这个路径扫不出页面') })
              return data
            }
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
          return apiPost('/rescan', {}, SCAN_TIMEOUT_MS).then(function (data) {
            // 只更新 state，不碰 draft —— 用户可能正在输入另一个路径
            setState(data)
            var stats = (data && data.stats) || {}
            setNotice({ tone: 'ok', text: '已重新扫描：' + (stats.pages || 0) + ' 页' })
            return data
          })
        })
      }

      function onReset() {
        if (busyRef.current !== '') return
        // 第一下只是上膛：这个按钮点错了要重配一遍，值得多问一句。
        if (!confirmReset) {
          setConfirmReset(true)
          setNotice({ tone: 'warn', text: '再点一次「确认清掉？」才会删掉配置里的库路径（笔记本身不受影响）。' })
          setTimeout(function () {
            setConfirmReset(false)
          }, 4000)
          return
        }
        setConfirmReset(false)
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

      var head = h(
        'div',
        { className: 'wn-head' },
        h('div', { className: 'wn-title' }, '知识库'),
        h(
          'div',
          { className: 'wn-sub' },
          '模型通过 wiki_recall 工具检索这个库（只读）。这里只改「库在哪」，不改「怎么检索」。',
        ),
      )

      var tabs = h(
        'div',
        { className: 'wn-tabs' },
        h(
          'button',
          {
            type: 'button',
            className: tab === 'overview' ? 'wn-tab wn-tab-on' : 'wn-tab',
            onClick: function () {
              setTab('overview')
            },
          },
          '概览',
        ),
        h(
          'button',
          {
            type: 'button',
            className: tab === 'calls' ? 'wn-tab wn-tab-on' : 'wn-tab',
            onClick: function () {
              setTab('calls')
            },
          },
          '调用记录',
        ),
      )

      var overview = h(
        'div',
        { className: 'wn-root' },

        head,
        tabs,

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

        // 覆盖诊断：发现多少、读到多少、漏在哪 —— 一行说清分母，不用猜。
        state !== null && (stats.pages || 0) > 0
          ? h(
              'div',
              { className: 'wn-cov' },
              h(
                'span',
                { className: 'wn-cov-item' },
                '发现 ' + (stats.discovered || 0) + ' 个文件 → 读到 ' + stats.pages + ' 页 / ' + (stats.sections || 0) + ' 小节',
              ),
              h('span', { className: 'wn-cov-item' }, bytesLabel(stats.bytes)),
              (stats.skipped || 0) > 0 ? h('span', { className: 'wn-cov-item' }, '跳过 ' + stats.skipped + '（index/log/下划线开头）') : null,
              (stats.unreadable || 0) > 0
                ? h('span', { className: 'wn-cov-item wn-cov-warn' }, '读不了 ' + stats.unreadable + ' 个')
                : null,
              (stats.oversized || 0) > 0
                ? h('span', { className: 'wn-cov-item wn-cov-warn' }, '超大未读 ' + stats.oversized + ' 个')
                : null,
              (stats.failuresTotal || 0) > 0
                ? h('span', { className: 'wn-cov-item wn-cov-warn' }, '目录/stat 失败 ' + stats.failuresTotal)
                : null,
              stats.newestMtime
                ? h('span', { className: 'wn-cov-item' }, '最新修改 ' + shortTime(stats.newestMtime))
                : null,
              stats.scannedAt
                ? h(
                    'span',
                    { className: 'wn-cov-item' },
                    '扫描于 ' + shortTime(stats.scannedAt) + ' · ' + (stats.scannedMs || 0) + ' ms',
                  )
                : null,
              h('span', { className: 'wn-cov-item wn-cov-path', title: '实际被扫描的目录' }, state.scannedRoot || state.root || ''),
            )
          : null,

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

        (state !== null && Array.isArray(state.topics) && state.topics.length > 0 && state.topicFilter)
          ? h(
              'label',
              { className: 'wn-toggle' },
              h('input', {
                type: 'checkbox',
                checked: state.topicFilter.minCount >= 2,
                disabled: busy !== '',
                onChange: function (event) {
                  var next = { minCount: event.target.checked ? 2 : 1, stopwords: state.topicFilter.stopwords !== false }
                  setBusy('topics')
                  setNotice(null)
                  apiPost('/topics', next)
                    .then(function (data) {
                      setState(data)
                      setNotice({ tone: 'ok', text: next.minCount >= 2 ? '已只统计出现 ≥2 次的标签。' : '已放开：出现一次的标签也参与排名。' })
                    })
                    .catch(function (error) { setNotice({ tone: 'err', text: '保存失败：' + error.message }) })
                    .then(function () { setBusy('') })
                },
              }),
              h('span', {}, '只统计出现 ≥2 次的标签'),
              h('span', { className: 'wn-hint wn-hint-dim' }, '（挡掉只属于一篇笔记的专有名词，以及 meta 这类结构页标签）'),
              (state.topicFilter.fallback === true && state.topicFilter.minCount >= 2)
                ? h('span', { className: 'wn-hint wn-hint-warn' }, '这个库的标签全都只出现过一次，阈值这次没生效（否则一个主题词都剩不下）。')
                : null,
            )
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

        // 只读检索面板：让人自己检查「模型会查到什么」，不用问模型。
        // 库没配好也照常显示 —— 它自己会把错误说出来，不连累上面那些配置区。
        h(
          'div',
          { className: 'wn-card' },
          h(
            'div',
            { className: 'wn-card-head' },
            h('span', { className: 'wn-card-title' }, '试一试检索'),
            h('span', { className: 'wn-badge wn-badge-muted' }, '只读'),
          ),
          h(WikiSearchPanel, { compact: false }),
        ),

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
                  placeholder: '例如 /home/me/notes 或 <你的库根目录>\\知识层-wiki',
                  onChange: function (event) {
                    setDraft(event.target.value)
                    // 换了路径，上一次「扫不出页面」的结论就不再指同一个东西了。
                    setProbe(null)
                    setProbeNote(null)
                    setConfirmReset(false)
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
                  ? h(
                      'button',
                      {
                        className: 'wn-btn wn-btn-ghost' + (confirmReset ? ' wn-btn-danger' : ''),
                        disabled: busy !== '',
                        onClick: onReset,
                      },
                      confirmReset ? '确认清掉？' : '清掉配置',
                    )
                  : null,
              ),

              (probeNote || (probe && probe.ok === true && (probe.stats || probe.hint)))
                ? h(
                    'div',
                    { className: 'wn-probe-box' },
                    probeNote ? h(Notice, { tone: probeNote.tone, message: probeNote.text }) : null,
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
                  )
                : null,

              promptDraft === null
                ? null
                : h(
                    'div',
                    { className: 'wn-prompt' },
                    h(
                      'label',
                      { className: 'wn-prompt-head' },
                      h('input', {
                        type: 'checkbox',
                        checked: promptDraft.enabled !== false,
                        onChange: function (event) {
                          setPromptDraft({ enabled: event.target.checked, override: promptDraft.override, extra: promptDraft.extra })
                        },
                      }),
                      '每回合注入一段提示词，让模型自己知道该来查库',
                    ),
                    h('div', { className: 'wn-hint' }, '关掉后不占上下文，但模型只在你说「我笔记里」时才会查。'),
                    h('textarea', {
                      className: 'wn-textarea',
                      rows: 3,
                      maxLength: 600,
                      'aria-label': '覆盖整段注入文案（留空则用自动生成的主题词行）',
                      disabled: promptDraft.enabled === false,
                      value: promptDraft.override,
                      placeholder: '留空 = 自动用下面这段（按标签算出来的）',
                      onChange: function (event) {
                        setPromptDraft({ enabled: promptDraft.enabled, override: event.target.value, extra: promptDraft.extra })
                      },
                    }),
                    h('textarea', {
                      className: 'wn-textarea',
                      rows: 2,
                      maxLength: 600,
                      'aria-label': '追加一句提示词',
                      disabled: promptDraft.enabled === false,
                      value: promptDraft.extra,
                      placeholder: '追加一句（可选），例如：不确定时先查库再回答',
                      onChange: function (event) {
                        setPromptDraft({ enabled: promptDraft.enabled, override: promptDraft.override, extra: event.target.value })
                      },
                    }),
                    h('div', { className: 'wn-preview-label' }, '现在实际注入的是：'),
                    h(
                      'pre',
                      { className: 'wn-preview' },
                      state && state.topicPreview
                        ? state.topicPreview
                        : state && state.prompt && state.prompt.enabled === false
                          ? '（空——提示词开关是关的，模型不会看到这段）'
                          : '（空——这个库的页面没有 标签 或 tags 字段，没有主题词可用）',
                    ),
                    h(
                      'div',
                      { className: 'wn-actions' },
                      h(
                        'button',
                        { className: 'wn-btn', disabled: busy !== '', onClick: onSavePrompt },
                        busy === 'prompt' ? '保存中…' : '保存提示词',
                      ),
                      h('span', { className: 'wn-actions-spacer' }),
                      h('span', { className: 'wn-hint' }, '（预览是上一次扫描的结果，保存后刷新即更新；两段各上限 600 字，超了会被截断）'),
                    ),
                  ),

              h(Notice, { tone: notice && notice.tone, message: notice && notice.text }),

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
      )

      // 同一个页面的另一面：谁在什么时候问过这个库、问到没有。
      if (tab === 'calls') {
        return h('div', { className: 'wn-root' }, head, tabs, h(WikiCallsSection, { embedded: true }))
      }
      return overview
    }

    /* ------------------------------ 检索面板 ------------------------------ */

    // 通道名要能直接读出来。分数的权重写在 title 里 —— 想核的时候能核，
    // 不想核的时候不占地方。
    var VIA_LABEL = { name: '页名', alias: '别名', tag: '标签', body: '正文', index: '摘要' }
    var VIA_HINT = {
      name: '页名全等 120 分，页名含该词 60 分',
      alias: '别名含该词 50 分',
      tag: '标签含该词 25 分',
      body: '正文每命中一次 3 分，最多算 12 次',
      index: '只在其它通道都是 0 时按 index 摘要给 8 分（只补漏，不抢位）',
    }

    /**
     * 把正文里命中查询词的地方标出来。
     *
     * 只做「标位置」，不改正文 —— 长词优先，否则「上下文工程」会被「上下文」切成两截。
     * 返回数组（字符串与 <mark> 混排），交给 React 转义，不拼 HTML 字符串。
     */
    function highlightNodes(text, terms) {
      var body = String(text === undefined || text === null ? '' : text)
      if (body === '') return body
      var words = []
      for (var i = 0; i < (Array.isArray(terms) ? terms.length : 0); i += 1) {
        var word = String(terms[i] === undefined || terms[i] === null ? '' : terms[i])
        if (word !== '' && words.indexOf(word) === -1) words.push(word)
      }
      if (words.length === 0) return body
      words.sort(function (a, b) {
        return b.length - a.length
      })
      var pattern = words
        .map(function (word) {
          return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        })
        .join('|')
      var re = new RegExp('(' + pattern + ')', 'gi')
      var out = []
      var last = 0
      var match = re.exec(body)
      var index = 0
      while (match !== null) {
        if (match.index > last) out.push(body.slice(last, match.index))
        out.push(h('mark', { key: 'mk' + index, className: 'wn-mark' }, match[0]))
        index += 1
        last = match.index + match[0].length
        if (match[0] === '') re.lastIndex += 1
        match = re.exec(body)
      }
      if (last < body.length) out.push(body.slice(last))
      return out
    }

    /**
     * 通用「复制」按钮：citation、查询词都用它 —— 复制逻辑只写一份。
     * 剪贴板不可用（http 下的老浏览器、或没有权限）时不假装成功文案骗人，
     * 但也别弹错：按钮保持原样，用户再点一次也不会更糟。
     */
    function CopyButton(props) {
      var text = String(props.text === undefined ? '' : props.text)
      var copiedTuple = useState(false)
      var copied = copiedTuple[0]
      var setCopied = copiedTuple[1]
      function copy() {
        var clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
        if (clipboard === undefined || clipboard === null || typeof clipboard.writeText !== 'function') {
          setCopied(true)
          return
        }
        clipboard.writeText(text).then(
          function () {
            setCopied(true)
          },
          function () {},
        )
      }
      return h(
        'button',
        {
          className: props.className || 'wn-cite-copy',
          type: 'button',
          title: props.title || '复制',
          disabled: text === '',
          onClick: copy,
        },
        copied ? props.doneLabel || '已复制' : props.label || '复制',
      )
    }

    /** citation 那一行的「复制」：复制的是原文出处，方便贴进对话或别的地方核对。 */
    function CiteRow(props) {
      var text = String(props.text === undefined ? '' : props.text)
      return h(
        'div',
        { className: 'wn-hit-cite' },
        h('span', { className: 'wn-hit-cite-text' }, text),
        text === '' ? null : h(CopyButton, { text: text, title: '复制这行出处' }),
      )
    }

    function TermChip(props) {
      var term = props.term
      var parts = term.parts || []
      var detail =
        parts.length === 0
          ? '未命中'
          : parts
              .map(function (part) {
                var name = VIA_LABEL[part.via] || part.via
                return name + (part.via === 'body' ? ' ×' + part.count : '') + ' ' + part.score
              })
              .join(' · ')
      var hint =
        parts.length === 0
          ? '这个词在这页里一次都没出现'
          : parts.map(function (part) { return (VIA_HINT[part.via] || part.via) + ' → ' + part.score + ' 分' }).join('\n')
      return h(
        'span',
        {
          className: 'wn-chip' + (parts.length === 0 ? ' wn-chip-dim' : ''),
          title: hint,
        },
        h('span', { className: 'wn-chip-term' }, term.term),
        h('span', { className: 'wn-chip-detail' }, detail),
      )
    }

    function SearchHit(props) {
      var hit = props.hit
      var terms = Array.isArray(hit.termHits) ? hit.termHits : []
      var rank = typeof props.rank === 'number' ? props.rank : 1
      var top = typeof props.top === 'number' && props.top > 0 ? props.top : hit.score || 1
      var ratio = top > 0 ? (hit.score || 0) / top : 0
      // 太短的条看不见，但也不该假装它有分量：6% 只是让它视觉上存在。
      var width = Math.max(6, Math.min(100, Math.round(ratio * 100)))
      var termsText = terms.map(function (term) {
        return term.term
      })
      var open = props.open === true
      var detailsProps = { className: 'wn-hit' + (props.active === true ? ' wn-hit-active' : '') }
      // 键盘上下选中的那一条默认展开：不然「选中」只剩一道边框，看不出选了干嘛
      if (open) detailsProps.open = true
      return h(
        'details',
        detailsProps,
        h(
          'summary',
          { className: 'wn-hit-head' },
          // summary 当 flex 容器在部分浏览器里会被 UA 样式顶掉（它自带 display 规则），
          // 所以真正的行布局交给里面这层 span —— summary 只负责「可点、可展开」。
          h(
            'span',
            { className: 'wn-hit-row' },
            h('span', { className: 'wn-hit-rank' }, String(rank)),
          h('span', { className: 'wn-hit-name' }, hit.name),
          hit.type !== '' && props.hideType !== true ? h('span', { className: 'wn-hit-type' }, hit.type) : null,
          hit.allTerms === false ? h('span', { className: 'wn-hit-partial' }, '部分词') : null,
          h(
            'span',
            { className: 'wn-hit-meter', 'aria-hidden': 'true' },
            h('span', { className: 'wn-hit-meter-fill', style: { width: width + '%' } }),
          ),
          h('span', { className: 'wn-hit-score' }, String(hit.score)),
          ),
        ),
        h(
          'div',
          { className: 'wn-hit-body' },
          h(
            'div',
            { className: 'wn-why' },
            terms.map(function (term) {
              return h(TermChip, { key: term.term, term: term })
            }),
          ),
          hit.section && hit.section.title !== ''
            ? h('div', { className: 'wn-hit-section' }, '§ ' + hit.section.title)
            : null,
          h(
            'div',
            { className: 'wn-hit-text' },
            hit.section && hit.section.text !== ''
              ? highlightNodes(hit.section.text, termsText)
              : '（这一页命中了，但没有命中某个正文小节）',
          ),
          h(CiteRow, { text: hit.citation || '' }),
        ),
      )
    }

    /* -------------------- 面板里可复用的几块（预览也用它） -------------------- */

    /**
     * 按「类型」分桶。只在真有两种以上类型时才分组：单一类型加标题只是多一层噪音。
     * 纯函数，好测，也让预览不必再抄一遍分桶逻辑。
     */
    function groupHits(hits) {
      var groups = []
      for (var i = 0; i < hits.length; i += 1) {
        var name = hits[i].type === '' ? '未标类型' : hits[i].type
        var bucket = null
        for (var j = 0; j < groups.length; j += 1) {
          if (groups[j].name === name) bucket = groups[j]
        }
        if (bucket === null) {
          bucket = { name: name, items: [] }
          groups.push(bucket)
        }
        bucket.items.push({ hit: hits[i], rank: i + 1 })
      }
      return { groups: groups, grouped: groups.length > 1 }
    }

    /** 计数行：命中多少、参与打分多少、多快、库多大；OR 降级时多一句黄字。 */
    function CountRow(props) {
      var result = props.result
      var shown = Array.isArray(result.hits) ? result.hits.length : 0
      return h(
        'div',
        { className: 'wn-count' },
        h(
          'span',
          { className: 'wn-count-main' },
          '命中 ' + result.total + ' 页',
          // 条数被 limit 截住时说清楚，否则「命中 7 页」下面只列 3 条会让人以为漏了。
          shown < result.total ? '（显示前 ' + shown + '）' : '',
        ),
        result.degraded === true
          ? h('span', { className: 'wn-count-degraded' }, '没有一条命中全部词，已降级为「命中任一」')
          : null,
        h(
          'span',
          { className: 'wn-count-meta' },
          '参与打分 ' +
            result.considered +
            ' 页 · ' +
            (result.elapsedMs || 0) +
            ' ms' +
            (typeof result.scanned === 'number' ? ' · 库 ' + result.scanned + ' 页' : ''),
        ),
      )
    }

    /** 查询诊断：这次真正参与打分的词、各自命中多少页、AND 还是 OR。 */
    function TermRow(props) {
      var terms = Array.isArray(props.termPages) ? props.termPages : []
      if (terms.length === 0) return null
      return h(
        'div',
        { className: 'wn-terms' },
        h('span', { className: 'wn-terms-label' }, '实际用的词'),
        terms.map(function (item) {
          var missed = (item.pages || 0) === 0
          return h(
            'span',
            {
              key: item.term,
              className: 'wn-term' + (missed ? ' wn-term-miss' : ''),
              title: missed ? '这个词在库里一页都没沾到 —— 换个说法或换个词' : '这个词在 ' + item.pages + ' 页上拿到了分',
            },
            h('span', { className: 'wn-term-word' }, item.term),
            h('span', { className: 'wn-term-count' }, missed ? '没沾到' : item.pages + ' 页'),
          )
        }),
        h(
          'span',
          { className: 'wn-terms-mode' },
          props.matchMode === 'or' ? '匹配：命中任一（OR）' : '匹配：全词都要（AND）',
        ),
      )
    }

    /** 命中列表：分组与否、选中哪条、分数条按「相对第一名」缩放。 */
    function HitList(props) {
      var hits = Array.isArray(props.hits) ? props.hits : []
      if (hits.length === 0) return null
      var active = typeof props.active === 'number' ? props.active : -1
      var top = hits[0].score
      function node(item, hideType) {
        return h(SearchHit, {
          key: item.hit.name,
          hit: item.hit,
          rank: item.rank,
          top: top,
          hideType: hideType,
          active: active === item.rank - 1,
          open: active === item.rank - 1,
        })
      }
      var split = groupHits(hits)
      return h(
        'div',
        { className: 'wn-hit-list' },
        split.grouped
          ? split.groups.map(function (group) {
              return h(
                'div',
                { className: 'wn-group', key: group.name },
                h('div', { className: 'wn-group-label' }, group.name + '（' + group.items.length + '）'),
                group.items.map(function (item) {
                  return node(item, true)
                }),
              )
            })
          : hits.map(function (hit, index) {
              return node({ hit: hit, rank: index + 1 }, false)
            }),
      )
    }

    /** 空状态：库多大、覆盖到哪、以及几个能直接点的标签。 */
    function EmptyState(props) {
      var lib = props.lib
      var pick = typeof props.onPick === 'function' ? props.onPick : function () {}
      return h(
        'div',
        { className: 'wn-empty' },
        lib !== null && lib !== undefined
          ? h('div', { className: 'wn-empty-lib' }, '库 ' + lib.pages + ' 页 · ' + lib.resources + ' 份资料 · 实时同步' + lib.watch)
          : null,
        lib !== null && lib !== undefined
          ? h(
              'div',
              { className: 'wn-empty-cov' },
              '参与检索 ' +
                lib.pages +
                ' 页 / ' +
                lib.sections +
                ' 个小节' +
                (lib.oversized > 0 ? ' · 超大未读 ' + lib.oversized : '') +
                (lib.unreadable > 0 ? ' · 读不了 ' + lib.unreadable : '') +
                (lib.skipped > 0 ? ' · 跳过 ' + lib.skipped : ''),
            )
          : null,
        h('div', { className: 'wn-empty-line' }, '和模型调 wiki_recall 是同一条检索路径 —— 这儿查不到，模型也拿不到。'),
        lib !== null && lib !== undefined && Array.isArray(lib.topics) && lib.topics.length > 0
          ? h(
              'div',
              { className: 'wn-suggest' },
              h('span', { className: 'wn-suggest-label' }, '试试'),
              lib.topics.map(function (topic) {
                return h(
                  'button',
                  {
                    key: topic.tag,
                    className: 'wn-chip wn-suggest-chip',
                    type: 'button',
                    title: '库里 ' + topic.count + ' 个页面带这个标签',
                    onClick: function () {
                      pick(topic.tag)
                    },
                  },
                  h('span', { className: 'wn-chip-term' }, topic.tag),
                )
              }),
            )
          : null,
      )
    }

    /**
     * 检索面板：设置页与右侧栏共用同一个组件。
     *
     * 它只做一件事 —— 把人放进模型的位置：同一条 `/api/wiki-notes/search`，
     * 也就是同一个 run(mode:'search')。所以「面板上看到的」和「模型拿到的」不可能分叉。
     */
    function WikiSearchPanel(props) {
      var compact = props !== null && props !== undefined && props.compact === true

      var queryTuple = useState('')
      var query = queryTuple[0]
      var setQuery = queryTuple[1]

      var resultTuple = useState(null)
      var result = resultTuple[0]
      var setResult = resultTuple[1]

      var busyTuple = useState(false)
      var busy = busyTuple[0]
      var setBusy = busyTuple[1]

      var errorTuple = useState('')
      var error = errorTuple[0]
      var setError = errorTuple[1]

      // 连按回车会发出多个请求；只认最后一次 —— 先发的慢响应不许盖掉后发的。
      var seqRef = useRef(0)
      // 边打边查的防抖：停手 350ms 才发，不然每敲一个字就扫一遍库。
      var timerRef = useRef(0)
      var activeTuple = useState(-1)
      var active = activeTuple[0]
      var setActive = activeTuple[1]
      // 快捷键要把焦点送进输入框，只能靠 DOM 引用
      var inputRef = useRef(null)

      // 空状态得有点信息可看：库多大、同步开没开、库里的词长什么样。
      // 失败就算了 —— 建议是锦上添花，拿不到建议不该让面板看起来像坏了。
      var libTuple = useState(null)
      var lib = libTuple[0]
      var setLib = libTuple[1]
      useEffect(function () {
        var alive = true
        apiGet('/state', SCAN_TIMEOUT_MS)
          .then(function (data) {
            if (!alive || data === null || data === undefined) return
            var stats = data.stats || {}
            setLib({
              pages: stats.pages || 0,
              resources: stats.resources || 0,
              watch: data.watch === 'on' ? '开' : '关',
              topics: (Array.isArray(data.topics) ? data.topics : []).slice(0, 6),
              // 覆盖诊断：空结果时要说清「是库里没有，还是这次没读到」
              sections: stats.sections || 0,
              oversized: stats.oversized || 0,
              unreadable: stats.unreadable || 0,
              skipped: stats.skipped || 0,
              root: data.scannedRoot || data.root || '',
            })
          })
          .catch(function () {})
        return function () {
          alive = false
        }
      }, [])

      // `/` 或 Ctrl/⌘+K 把焦点送进输入框：面板挂在侧栏时，手通常不在鼠标上。
      useEffect(function () {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        function onKey(event) {
          var target = event.target
          var tag = target !== null && target !== undefined && target.tagName ? String(target.tagName).toLowerCase() : ''
          if (tag === 'input' || tag === 'textarea') return
          var isSlash = event.key === '/' && event.metaKey !== true && event.ctrlKey !== true
          var isCombo = (event.metaKey === true || event.ctrlKey === true) && String(event.key).toLowerCase() === 'k'
          if (!isSlash && !isCombo) return
          var node = inputRef.current
          if (node === null || node === undefined || typeof node.focus !== 'function') return
          event.preventDefault()
          node.focus()
        }
        window.addEventListener('keydown', onKey)
        return function () {
          window.removeEventListener('keydown', onKey)
        }
      }, [])

      function runSearch(text) {
        var trimmed = String(text === undefined ? query : text).trim()
        if (trimmed === '' || busy) return
        setQuery(trimmed)
        setActive(-1)
        seqRef.current = seqRef.current + 1
        var seq = seqRef.current
        setBusy(true)
        setError('')
        // 和模型同样的默认条数（5 条），侧栏放宽到 8 条方便扫。
        apiGet('/search?q=' + encodeURIComponent(trimmed) + '&limit=' + (compact ? 8 : 5), SCAN_TIMEOUT_MS)
          .then(function (data) {
            if (seq !== seqRef.current) return
            setResult(data)
          })
          .catch(function (failure) {
            if (seq !== seqRef.current) return
            setResult(null)
            setError(failure && failure.message ? failure.message : '查询失败')
          })
          .then(function () {
            if (seq !== seqRef.current) return
            setBusy(false)
          })
      }

      function submit() {
        // 手动提交要压掉待发的防抖请求，不然回车后还会再发一次同样的查询
        if (timerRef.current !== 0 && typeof clearTimeout === 'function') clearTimeout(timerRef.current)
        timerRef.current = 0
        runSearch(query)
      }

      function scheduleSearch(text) {
        if (typeof setTimeout !== 'function') return
        if (timerRef.current !== 0 && typeof clearTimeout === 'function') clearTimeout(timerRef.current)
        timerRef.current = setTimeout(function () {
          timerRef.current = 0
          var trimmed = String(text === undefined ? '' : text).trim()
          // 一个字就查多半是噪音：中文单字命中面太宽，结果没人看
          if (trimmed.length < 2) return
          runSearch(trimmed)
        }, 350)
      }

      function clearAll() {
        if (timerRef.current !== 0 && typeof clearTimeout === 'function') clearTimeout(timerRef.current)
        timerRef.current = 0
        seqRef.current = seqRef.current + 1
        setQuery('')
        setResult(null)
        setError('')
        setActive(-1)
      }

      var hits = result !== null && Array.isArray(result.hits) ? result.hits : []

      return h(
        'div',
        { className: 'wn-panel' + (compact ? ' wn-panel-compact' : '') },
        h(
          'div',
          { className: 'wn-search' },
          h('input', {
            className: 'wn-input wn-search-input',
            type: 'text',
            value: query,
            ref: inputRef,
            spellCheck: false,
            'aria-label': '检索词',
            placeholder: '输入关键词，例如「上下文 预算」',
            onChange: function (event) {
              var next = event.target.value
              setQuery(next)
              scheduleSearch(next)
            },
            onKeyDown: function (event) {
              if (event.key === 'Enter') {
                event.preventDefault()
                submit()
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                clearAll()
                return
              }
              // 上下键在结果之间走：面板里不该非拿鼠标不可
              if (event.key === 'ArrowDown' && hits.length > 0) {
                event.preventDefault()
                setActive(function (prev) {
                  return Math.min(prev + 1, hits.length - 1)
                })
                return
              }
              if (event.key === 'ArrowUp' && hits.length > 0) {
                event.preventDefault()
                setActive(function (prev) {
                  return Math.max(prev - 1, 0)
                })
              }
            },
          }),
          // 查一次常常要换个地方再查：把这次的词原样带走，比让人重新敲一遍强。
          query.trim() === ''
            ? null
            : h(CopyButton, {
                className: 'wn-copy-query',
                text: query.trim(),
                label: '复制词',
                title: '复制这次的查询词',
              }),
          h(
            'button',
            {
              className: 'wn-btn wn-btn-primary',
              type: 'button',
              disabled: busy || query.trim() === '',
              onClick: submit,
            },
            busy ? '查…' : '查一下',
          ),
        ),

        error !== '' ? h(Notice, { tone: 'err', message: error }) : null,

        busy ? h('div', { className: 'wn-busy' }, '检索中…') : null,

        result !== null ? h(CountRow, { result: result }) : null,

        result !== null ? h(TermRow, { termPages: result.termPages, matchMode: result.matchMode }) : null,

        result !== null && hits.length === 0
          ? h(Notice, {
              tone: 'warn',
              message: '一条也没命中。要么库里确实没写这个说法，要么该换个词 —— 中文不分词，写整句只会一个词都匹配不上。',
            })
          : null,

        h(HitList, { hits: hits, active: active }),

        result === null && error === '' && busy === false ? h(EmptyState, { lib: lib, onPick: runSearch }) : null,
      )
    }

    /* -------------------------- 调用审计（第二页签） -------------------------- */

    /** 轮询间隔。2 秒够看清「模型刚刚查了没有」，又不至于把本机 HTTP 当心跳打。 */
    var CALLS_POLL_MS = 2000
    var CALLS_LIMIT = 200

    function callsSourceLabel(source) {
      return source === 'panel' ? '面板' : '模型'
    }

    /** 把 setState 的结果合并进旧对象：stub 环境里 setter 是空函数，这里也不依赖它。 */
    function patchState(prev, patch) {
      var next = {}
      Object.keys(prev).forEach(function (key) {
        next[key] = prev[key]
      })
      Object.keys(patch).forEach(function (key) {
        next[key] = patch[key]
      })
      return next
    }

    /** 指标为 null 时不许伪装成 0%；「没有数据」和「0 次违规」必须是两种状态。 */
    function governancePercent(metric) {
      if (!metric || typeof metric.value !== 'number' || !Number.isFinite(metric.value)) return '没有数据'
      return (metric.value * 100).toFixed(1) + '%'
    }

    /** 每项指标都带分子分母、有效样本数、排除数与排除原因，不许只报一个百分比。 */
    function governanceDetail(metric) {
      if (!metric) return ''
      function shown(value) {
        return value === null || value === undefined ? '—' : String(value)
      }
      var parts = [
        '分子/分母：' + shown(metric.numerator) + '/' + shown(metric.denominator),
        '有效样本：' + shown(metric.effective_samples),
        '排除：' + shown(metric.excluded_count),
      ]
      var reasons = Array.isArray(metric.exclude_reasons) ? metric.exclude_reasons : []
      if (reasons.length > 0) parts.push('排除原因：' + reasons.join('、'))
      return parts.join(' · ')
    }

    function governanceMetricRow(label, metric, extraClassName) {
      var text = governancePercent(metric)
      if (label === '有效 Verify 违规发现率' && metric && metric.numerator === 0
        && typeof metric.denominator === 'number' && metric.denominator > 0) {
        text = '0 次违规（0.0%）'
      }
      return h(
        'div',
        { className: 'wn-gov-row' + (extraClassName ? ' ' + extraClassName : '') },
        h('div', { className: 'wn-gov-row-head' }, h('span', null, label), h('b', null, text)),
        h('div', { className: 'wn-gov-detail' }, governanceDetail(metric)),
      )
    }

    /** 治理指标面板只挂在「知识库 → 调用记录」页签内，不另开页签或一级入口。 */
    function WikiGovernancePanel(props) {
      var g = props && props.governance
      var head = h('div', { className: 'wn-gov-head' }, '治理观察（插件侧账本，与 Python 观察日志分开）')
      var on = !!(g && g.observe_enabled === true && g.state !== 'disabled' && g.state !== 'unavailable')
      if (!on) {
        return h(
          'div',
          { className: 'wn-gov' },
          head,
          h('div', { className: 'wn-gov-off' }, (g && g.message) || '没有启用观察，因此没有数据'),
          h('div', { className: 'wn-gov-note' }, '观察是否启用：未启用 · 窗口 ' + String((g && g.window && g.window.days) || 7) + ' 天'),
          h('div', { className: 'wn-gov-note' }, '断言数量：数据不可用'),
          h('div', { className: 'wn-gov-note' }, '观察到的核验链收敛率：没有启用观察，因此没有数据'),
        )
      }

      var metrics = g.metrics || {}
      var trigger = metrics.required_check_verification_trigger_rate
      var discovery = metrics.effective_verify_violation_discovery_rate
      var coverage = metrics.observation_coverage
      var rows = [
        governanceMetricRow('必核项 Context 核验触发率', trigger),
        governanceMetricRow('有效 Verify 违规发现率', discovery),
        governanceMetricRow('观察覆盖率', coverage),
      ]
      var group = trigger && trigger.groups && trigger.groups.partial_insufficient
      if (group) {
        rows.push(governanceMetricRow('其中 partial / insufficient 分组', group, 'wn-gov-sub'))
      }

      var conv = g.convergence || {}
      var convParts = []
      if (typeof conv.converged === 'number') convParts.push('已收敛 ' + conv.converged)
      if (typeof conv.unresolved === 'number') convParts.push('仍未收敛 ' + conv.unresolved)
      if (typeof conv.not_rechecked === 'number') convParts.push('未复核 ' + conv.not_rechecked)

      var ex = g.excluded || {}
      var cs = ex.context_samples || {}
      var vc = ex.verify_calls || {}
      var exParts = []
      ;['restart_not_observed', 'capacity'].forEach(function (key) {
        if (typeof cs[key] === 'number' && cs[key] > 0) exParts.push('样本 ' + key + ' ' + cs[key])
      })
      ;['context_missing', 'context_expired', 'context_corrupt', 'exec_failed'].forEach(function (key) {
        if (typeof vc[key] === 'number' && vc[key] > 0) exParts.push('Verify ' + key + ' ' + vc[key])
      })
      if (typeof ex.late_verify === 'number' && ex.late_verify > 0) exParts.push('迟到 Verify ' + ex.late_verify)

      return h(
        'div',
        { className: 'wn-gov' },
        head,
        h('div', { className: 'wn-gov-note' }, '观察是否启用：已启用 · 窗口 ' + String((g.window && g.window.days) || 7) + ' 天'),
        h('div', { className: 'wn-gov-rows' }, rows),
        h('div', { className: 'wn-gov-note' }, '断言数量：数据不可用'),
        h('div', { className: 'wn-gov-note' }, '观察到的核验链收敛率：' + (convParts.length > 0 ? convParts.join(' / ') : '没有数据')),
        h('div', { className: 'wn-gov-note' }, exParts.length > 0 ? '排除：' + exParts.join(' · ') : '排除：无'),
        h('div', { className: 'wn-gov-note' }, '收敛只表示观察到的核验链，不等于最终回答已证明可靠。'),
      )
    }

    /**
     * 「知识库 · 调用」。
     *
     * 存在的理由：wiki_observe 只看网关那三次调用，wiki_recall 压根不写观察日志。
     * 所以「模型到底查没查库」这件事，之前只能去翻会话转录。这个页面就是那本账。
     */
    function WikiCallsSection(props) {
      var stateTuple = useState({ rows: [], totals: null, enabled: true, window: 0, governance: null, error: '', loading: true })
      var state = stateTuple[0]
      var setState = stateTuple[1]

      var filterTuple = useState('all')
      var filter = filterTuple[0]
      var setFilter = filterTuple[1]

      var missTuple = useState(false)
      var onlyMiss = missTuple[0]
      var setOnlyMiss = missTuple[1]

      // 清空要按两次：第一次只把按钮变成「确认清空？」，4 秒内不确认就复原。
      // 不用 window.confirm —— 系统对话框在自己页面里显得突兀，也不好统一风格。
      var confirmClearTuple = useState(false)
      var confirmClear = confirmClearTuple[0]
      var setConfirmClear = confirmClearTuple[1]
      var confirmTimerRef = useRef(null)

      // 切走页面后别再 setState：轮询还在跑，往已卸载的组件写 state 只会刷警告。
      var aliveRef = useRef(true)
      // 同一时刻只发一个写请求，别让轮询和手点清空撞在一起。
      var busyRef = useRef('')

      var load = useCallback(
        function () {
          var path = '/calls?limit=' + CALLS_LIMIT
          if (filter !== 'all') path = path + '&source=' + filter
          if (onlyMiss) path = path + '&only=miss'
          return apiGet(path).then(
            function (data) {
              if (aliveRef.current !== true) return
              setState({
                rows: Array.isArray(data && data.rows) ? data.rows : [],
                totals: (data && data.totals) || null,
                enabled: !(data && data.enabled === false),
                window: data && typeof data.window === 'number' ? data.window : 0,
                governance: data && data.governance && typeof data.governance === 'object' ? data.governance : null,
                error: '',
                loading: false,
              })
            },
            function (error) {
              if (aliveRef.current !== true) return
              setState(function (prev) {
                return patchState(prev, { loading: false, error: String((error && error.message) || error) })
              })
            },
          )
        },
        [filter, onlyMiss],
      )

      useEffect(
        function () {
          aliveRef.current = true
          load()
          var timer = setInterval(function () {
            // 页面在后台时跳过：没人看，白花一次请求。
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
            load()
          }, CALLS_POLL_MS)
          return function () {
            aliveRef.current = false
            clearInterval(timer)
            if (confirmTimerRef.current !== null) {
              clearTimeout(confirmTimerRef.current)
              confirmTimerRef.current = null
            }
          }
        },
        [load],
      )

      function runAction(path, body, label) {
        if (busyRef.current !== '') return
        busyRef.current = label
        apiPost(path, body || {}).then(
          function () {
            busyRef.current = ''
            load()
          },
          function (error) {
            busyRef.current = ''
            setState(function (prev) {
              return patchState(prev, { error: String((error && error.message) || error) })
            })
          },
        )
      }

      function clearCalls() {
        if (confirmClear !== true) {
          setConfirmClear(true)
          if (confirmTimerRef.current !== null) clearTimeout(confirmTimerRef.current)
          confirmTimerRef.current = setTimeout(function () {
            confirmTimerRef.current = null
            setConfirmClear(false)
          }, 4000)
          return
        }
        if (confirmTimerRef.current !== null) {
          clearTimeout(confirmTimerRef.current)
          confirmTimerRef.current = null
        }
        setConfirmClear(false)
        runAction('/calls/clear', {}, 'clear')
      }

      function toggleEnabled() {
        runAction('/calls/config', { enabled: state.enabled !== true }, 'toggle')
      }

      var totals = state.totals || {}
      var hitRate = typeof totals.hitRate === 'number' ? Math.round(totals.hitRate * 100) + '%' : '—'

      var filterButtons = [
        ['all', '全部'],
        ['model', '模型'],
        ['panel', '面板'],
      ].map(function (item) {
        return h(
          'button',
          {
            key: item[0],
            type: 'button',
            className: filter === item[0] ? 'wn-btn wn-btn-on' : 'wn-btn',
            onClick: function () {
              setFilter(item[0])
            },
          },
          item[1],
        )
      })

      var rows = (state.rows || []).map(function (row, index) {
        var slow = typeof row.ms === 'number' && row.ms > 1000
        return h(
          'tr',
          { key: String(row.ts) + '-' + String(index) },
          h('td', { className: 'wn-calls-time' }, typeof row.ts === 'string' ? row.ts.slice(11, 16) : '—'),
          h('td', null, callsSourceLabel(row.source)),
          h('td', null, row.tool === '' || row.tool === undefined ? '—' : row.tool),
          h(
            'td',
            { className: 'wn-calls-query', title: typeof row.query === 'string' ? row.query : '' },
            row.query === '' || row.query === undefined ? '（无查询词）' : row.query,
          ),
          h('td', { className: 'wn-calls-hits' }, row.hits === null || row.hits === undefined ? '—' : String(row.hits)),
          h('td', { className: slow ? 'wn-calls-ms wn-slow' : 'wn-calls-ms' }, typeof row.ms === 'number' ? row.ms + 'ms' : '—'),
        )
      })

      var body =
        rows.length === 0
          ? h('div', { className: 'wn-calls-empty' }, '还没有调用记录。让模型查一次库，或在「概览」页的搜索框里查一次 —— 两条路都会记进同一个账本。')
          : h(
              'table',
              { className: 'wn-calls-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, '时间'),
                  h('th', null, '来源'),
                  h('th', null, '工具'),
                  h('th', null, '问题'),
                  h('th', null, '命中'),
                  h('th', null, '耗时'),
                ),
              ),
              h('tbody', null, rows),
            )

      var embedded = props !== null && props !== undefined && props.embedded === true

      return h(
        'div',
        // 嵌进「知识库」页时不再套一层 .wn-root —— 那会把间距和 padding 叠加两遍。
        { className: embedded === true ? 'wn-calls' : 'wn-root wn-calls' },
        // 标题与页签由外层给，这里不重复一个头。
        embedded === true
          ? null
          : h(
              'div',
              { className: 'wn-head' },
              h('div', { className: 'wn-title' }, '调用记录'),
              h(
                'div',
                { className: 'wn-sub' },
                '模型和面板每一次查库都记在这儿。这是唯一能回答「我这句问话，它到底查了没有」的地方。',
              ),
            ),
        h(
          'div',
          { className: 'wn-calls-stats' },
          h('div', { className: 'wn-calls-stat' }, h('b', null, String(totals.calls === undefined ? 0 : totals.calls)), h('span', null, '今日调用')),
          h('div', { className: 'wn-calls-stat' }, h('b', null, hitRate), h('span', null, '命中率')),
          h('div', { className: 'wn-calls-stat' }, h('b', null, String(totals.misses === undefined ? 0 : totals.misses)), h('span', null, '零命中')),
        ),
        h(
          'div',
          { className: 'wn-calls-note' },
          '统计基于最近 ' + String(state.window === undefined ? 0 : state.window) + ' 条记录；命中率分母不含 verify / observe。',
        ),
        h(WikiGovernancePanel, { governance: state.governance }),
        h(
          'div',
          { className: 'wn-calls-bar' },
          filterButtons,
          h(
            'label',
            { className: 'wn-calls-check' },
            h('input', {
              type: 'checkbox',
              checked: onlyMiss === true,
              onChange: function () {
                setOnlyMiss(onlyMiss !== true)
              },
            }),
            '只看零命中',
          ),
          h(
            'label',
            { className: 'wn-calls-check' },
            h('input', {
              type: 'checkbox',
              checked: state.enabled === true,
              onChange: toggleEnabled,
            }),
            '记录开关',
          ),
          h('span', { className: 'wn-calls-warn' }, '关闭会清空现有记录与待核验状态，期间指标不可用'),
          h(
            'button',
            { type: 'button', className: confirmClear === true ? 'wn-btn wn-btn-danger' : 'wn-btn', onClick: clearCalls },
            confirmClear === true ? '确认清空？' : '清空',
          ),
        ),
        state.error === '' || state.error === undefined
          ? null
          : h('div', { className: 'wn-notice wn-notice-bad' }, h('span', { className: 'wn-notice-mark' }, '!'), h('span', { className: 'wn-notice-text' }, state.error)),
        body,
        h('div', { className: 'wn-foot' }, '账本只记这 8 个字段：时间、来源、工具、模式、问题、命中、耗时、成败。页面路径与正文一律不进。'),
      )
    }

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
      '.wn-dim{font-size:12.5px;color:var(--wn-muted);}',
      '.wn-stats{display:flex;gap:10px;flex-wrap:wrap;}',
      '.wn-stat{flex:1 1 96px;min-width:96px;background:var(--wn-bar);border:1px solid var(--wn-line-soft);border-radius:10px;padding:10px 12px;}',
      '.wn-stat-value{font-size:22px;font-weight:600;line-height:1.15;font-variant-numeric:tabular-nums;}',
      '.wn-stat-label{font-size:11.5px;color:var(--wn-muted);margin-top:3px;}',
      '.wn-stat-warn .wn-stat-value{color:var(--wn-warn);}',
      '.wn-scale{font-size:12px;color:var(--wn-muted);}',
      '.wn-cov{display:flex;flex-wrap:wrap;gap:5px 12px;font-size:11.5px;color:var(--wn-muted);font-variant-numeric:tabular-nums;}',
      '.wn-cov-item{white-space:nowrap;}',
      '.wn-cov-warn{color:var(--wn-warn);}',
      '.wn-cov-path{flex:1 1 100%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;}',
      '.wn-card{background:var(--wn-card);border:1px solid var(--wn-line);border-radius:12px;padding:13px 14px;display:flex;flex-direction:column;gap:10px;}',
      '.wn-card-head{display:flex;align-items:center;gap:8px;}',
      '.wn-card-title{font-size:12.5px;font-weight:600;color:var(--wn-muted);}',
      '.wn-badge{font-size:11px;padding:2px 7px;border-radius:999px;border:1px solid var(--wn-line);color:var(--wn-muted);background:var(--wn-bar);white-space:nowrap;}',
      '.wn-badge-ok{color:var(--wn-ok);border-color:color-mix(in srgb,var(--wn-ok) 35%,transparent);}',
      '.wn-badge-warn{color:var(--wn-warn);border-color:color-mix(in srgb,var(--wn-warn) 35%,transparent);}',
      '.wn-badge-muted{color:var(--wn-muted);}',
      '.wn-path{word-break:break-all;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;background:var(--wn-field);border:1px solid var(--wn-line-soft);border-radius:8px;padding:8px 10px;}',
      '.wn-field-row{display:flex;gap:8px;}',
      '.wn-input{flex:1 1 auto;min-width:0;box-sizing:border-box;font-size:12.5px;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);color:var(--wn-fg);background:var(--wn-field);border:1px solid var(--wn-line);border-radius:8px;padding:8px 10px;outline:none;}',
      '.wn-input:focus{border-color:var(--wn-brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--wn-brand) 18%,transparent);}',
      '.wn-actions{display:flex;gap:8px;flex-wrap:wrap;}',
      '.wn-probe-box{display:flex;flex-direction:column;gap:8px;}',
      '.wn-loading{display:flex;align-items:center;gap:10px;}',
      '.wn-btn{font-size:12.5px;padding:7px 13px;border-radius:8px;border:1px solid var(--wn-line);background:var(--wn-bar);color:var(--wn-fg);cursor:pointer;white-space:nowrap;}',
      '.wn-btn:hover:not(:disabled){filter:brightness(.97);}',
      '.wn-btn:disabled{opacity:.5;cursor:default;}',
      '.wn-btn:focus-visible,.wn-input:focus-visible{outline:2px solid var(--wn-brand);outline-offset:2px;}',
      '.wn-btn-primary{background:var(--wn-brand);color:var(--wn-brand-fg);border-color:transparent;}',
      '.wn-btn-ghost{background:transparent;color:var(--wn-muted);}',
      '.wn-btn-danger{color:var(--wn-err);border-color:color-mix(in srgb,var(--wn-err) 45%,transparent);background:color-mix(in srgb,var(--wn-err) 8%,transparent);}',
      '.wn-notice{font-size:12.5px;line-height:1.55;padding:8px 11px;border-radius:8px;border:1px solid var(--wn-line-soft);background:var(--wn-bar);color:var(--wn-muted);}',
      '.wn-notice-ok{color:var(--wn-ok);border-color:color-mix(in srgb,var(--wn-ok) 30%,transparent);background:color-mix(in srgb,var(--wn-ok) 8%,transparent);}',
      '.wn-notice-err{color:var(--wn-err);border-color:color-mix(in srgb,var(--wn-err) 30%,transparent);background:color-mix(in srgb,var(--wn-err) 8%,transparent);}',
      '.wn-notice-warn{color:var(--wn-warn);border-color:color-mix(in srgb,var(--wn-warn) 30%,transparent);background:color-mix(in srgb,var(--wn-warn) 8%,transparent);}',
      '.wn-probe{font-size:12px;color:var(--wn-muted);line-height:1.6;}',
      '.wn-hint{font-size:11.5px;color:var(--wn-muted);line-height:1.65;word-break:break-all;}',
      '.wn-prompt{display:flex;flex-direction:column;gap:7px;border-top:1px dashed var(--wn-line-soft);padding-top:11px;}',
      '.wn-prompt-head{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--wn-fg);cursor:pointer;}',
      '.wn-textarea{font:inherit;font-size:12.5px;line-height:1.6;padding:8px 10px;border-radius:8px;border:1px solid var(--wn-line);background:var(--wn-bar);color:var(--wn-fg);resize:vertical;}',
      '.wn-textarea:focus-visible{outline:2px solid var(--wn-brand);outline-offset:2px;}',
      '.wn-textarea:disabled{opacity:.5;}',
      '.wn-preview-label{font-size:11.5px;color:var(--wn-muted);}',
      '.wn-preview{margin:0;font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;padding:8px 10px;border-radius:8px;background:var(--wn-bar);border:1px solid var(--wn-line-soft);color:var(--wn-muted);max-height:180px;overflow:auto;}',
      '.wn-hint-warn{color:var(--wn-warn);}',
      '.wn-hint-dim{opacity:.75;}',
      '.wn-head{display:flex;flex-direction:column;gap:3px;}',
      '.wn-statusbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:11.5px;color:var(--wn-muted);}',
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
      '.wn-toggle{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-size:11.5px;color:var(--wn-muted);cursor:pointer;}',
      '.wn-toggle input{cursor:pointer;}',
      '.wn-chip{display:inline-flex;align-items:baseline;gap:6px;font-size:11.5px;padding:2px 8px;border-radius:6px;background:var(--wn-bar);border:1px solid var(--wn-line-soft);color:var(--wn-muted);}',
      '.wn-chip-term{font-weight:600;color:var(--wn-fg);}',
      '.wn-chip-detail{color:var(--wn-muted);font-variant-numeric:tabular-nums;}',
      '.wn-chip-warn{color:var(--wn-warn);border-color:color-mix(in srgb,var(--wn-warn) 35%,transparent);}',
      '.wn-chip-dim{opacity:.7;}',
      '.wn-chip-dim .wn-chip-term{font-weight:500;color:var(--wn-faint);}',
      '.wn-actions-spacer{flex:1 1 auto;}',
      '.wn-details{border-top:1px solid var(--wn-line-soft);padding-top:9px;margin-top:2px;}',
      '.wn-details summary{font-size:11.5px;color:var(--wn-muted);cursor:pointer;user-select:none;list-style:none;}',
      '.wn-details summary::-webkit-details-marker{display:none;}',
      '.wn-details summary::before{content:"▸ ";color:var(--wn-faint);}',
      '.wn-details[open] summary::before{content:"▾ ";}',
      '.wn-details-body{display:flex;flex-direction:column;gap:4px;padding-top:8px;}',
      '.wn-panel{display:flex;flex-direction:column;gap:10px;}',
      '.wn-search{display:flex;gap:8px;align-items:center;}',
      '.wn-search-input{flex:1 1 auto;min-width:0;font-family:inherit;font-size:13px;}',
      // 计数行：主信息在左，元信息推到行尾 —— 一眼看到「命中几页」，想核再看耗时。
      '.wn-count{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--wn-muted);font-variant-numeric:tabular-nums;}',
      '.wn-count-main{color:var(--wn-fg);font-weight:600;}',
      '.wn-count-degraded{font-size:11.5px;color:var(--wn-warn);}',
      '.wn-count-meta{margin-left:auto;font-size:11px;color:var(--wn-muted);}',
      // 结果按行排、不按卡片：一列的边框会把 1/2/3 名的强弱比较打断。
      '.wn-hit-list{display:flex;flex-direction:column;border-top:1px solid var(--wn-line-soft);}',
      '.wn-hit{border-bottom:1px solid var(--wn-line-soft);}',
      '.wn-hit[open]{background:var(--wn-bar);}',
      '.wn-hit-head{display:block;padding:0;cursor:pointer;list-style:none;user-select:none;}',
      '.wn-hit-head::-webkit-details-marker{display:none;}',
      '.wn-hit-row{display:flex;align-items:center;gap:9px;padding:9px 5px;font-size:13px;line-height:1.45;}',
      '.wn-hit-row:hover{background:var(--wn-bar);}',
      '.wn-hit[open] .wn-hit-row:hover{background:transparent;}',
      '.wn-hit-rank{flex:0 0 15px;text-align:right;font-size:11px;color:var(--wn-muted);font-variant-numeric:tabular-nums;}',
      '.wn-hit-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--wn-fg);}',
      '.wn-hit-type{font-size:10.5px;line-height:1.6;padding:0 5px;border-radius:5px;border:1px solid var(--wn-line-soft);color:var(--wn-muted);white-space:nowrap;}',
      '.wn-hit-partial{font-size:10.5px;color:var(--wn-warn);white-space:nowrap;}',
      '.wn-hit-meter{flex:0 0 44px;height:3px;border-radius:2px;margin-left:auto;background:var(--wn-line-soft);overflow:hidden;}',
      '.wn-hit-meter-fill{display:block;height:100%;border-radius:2px;background:color-mix(in srgb,var(--wn-brand) 58%,transparent);}',
      '.wn-hit-score{flex:0 0 32px;text-align:right;font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--wn-fg);}',
      '.wn-hit-body{display:flex;flex-direction:column;gap:7px;padding:2px 5px 12px 24px;}',
      '.wn-why{display:flex;flex-wrap:wrap;gap:5px;}',
      '.wn-hit-section{font-size:11px;color:var(--wn-muted);}',
      // 设置页正文不设高度上限（页面本来就长，截断反而多出滚动条）；侧栏才封顶。
      '.wn-hit-text{font-size:12.5px;line-height:1.75;color:var(--wn-fg);white-space:pre-wrap;padding-right:4px;}',
      '.wn-hit-cite{font-size:10.5px;color:var(--wn-muted);word-break:break-all;display:flex;align-items:baseline;gap:8px;}',
      '.wn-hit-cite-text{flex:1 1 auto;min-width:0;}',
      '.wn-cite-copy{flex:0 0 auto;font-family:inherit;font-size:10.5px;line-height:1.6;padding:0 6px;border-radius:5px;border:1px solid var(--wn-line);background:var(--wn-bar);color:var(--wn-muted);cursor:pointer;}',
      '.wn-cite-copy:hover{background:var(--wn-field);color:var(--wn-fg);}',
      '.wn-copy-query{flex:0 0 auto;font-family:inherit;font-size:12px;line-height:1.9;padding:0 9px;border-radius:7px;border:1px solid var(--wn-line);background:transparent;color:var(--wn-muted);cursor:pointer;}',
      '.wn-copy-query:hover{background:var(--wn-bar);color:var(--wn-fg);}',
      // 键盘走一圈时要看得见落点：录不录用户无所谓，不能靠鼠标才知道焦点在哪。
      '.wn-cite-copy:focus-visible,.wn-copy-query:focus-visible,.wn-suggest-chip:focus-visible,.wn-hit-head:focus-visible,.wn-search-input:focus-visible,.wn-btn:focus-visible{outline:2px solid var(--wn-brand);outline-offset:1px;}',
      '.wn-cite-copy:disabled,.wn-copy-query:disabled{opacity:.55;cursor:default;}',
      '.wn-cite-copy:hover{color:var(--wn-fg);border-color:var(--wn-line);}',
      // 正文里的命中位置：底纹而不是改字色，正文照旧可读
      '.wn-mark{background:color-mix(in srgb,var(--wn-warn) 22%,transparent);color:inherit;border-radius:2px;padding:0 1px;}',
      '.wn-hit-active{background:var(--wn-bar);}',
      // 查询诊断：引擎到底拿哪几个词去找的
      '.wn-terms{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:11.5px;color:var(--wn-muted);}',
      '.wn-terms-label{color:var(--wn-muted);}',
      '.wn-term{display:inline-flex;align-items:baseline;gap:5px;padding:1px 6px;border-radius:5px;border:1px solid var(--wn-line-soft);background:var(--wn-bar);}',
      '.wn-term-word{font-weight:600;color:var(--wn-fg);}',
      '.wn-term-count{font-variant-numeric:tabular-nums;color:var(--wn-muted);}',
      '.wn-term-miss{border-style:dashed;border-color:var(--wn-err);}',
      '.wn-term-miss .wn-term-word{color:var(--wn-err);}',
      '.wn-terms-mode{margin-left:auto;font-size:11px;color:var(--wn-muted);}',
      '.wn-group{display:flex;flex-direction:column;}',
      '.wn-group-label{font-size:10.5px;letter-spacing:.4px;color:var(--wn-muted);padding:9px 2px 3px;}',
      '.wn-busy{font-size:11.5px;color:var(--wn-muted);}',
      '.wn-empty-cov{font-size:11px;color:var(--wn-muted);font-variant-numeric:tabular-nums;line-height:1.6;}',
      '.wn-panel-compact .wn-hit-text{max-height:220px;overflow:auto;}',
      '.wn-panel-compact .wn-hit-row{padding:8px 2px;}',
      '.wn-panel-compact .wn-hit-body{padding-left:24px;padding-right:2px;}',
      // 空状态：与其留一片白，不如把「库多大」和「库里的词长什么样」摆出来。
      '.wn-empty{display:flex;flex-direction:column;gap:8px;padding:12px 13px;border:1px dashed var(--wn-line);border-radius:10px;}',
      '.wn-empty-lib{font-size:11.5px;color:var(--wn-muted);font-variant-numeric:tabular-nums;}',
      '.wn-empty-line{font-size:12px;line-height:1.6;color:var(--wn-muted);}',
      '.wn-suggest{display:flex;flex-wrap:wrap;align-items:center;gap:6px;}',
      '.wn-suggest-label{font-size:11px;color:var(--wn-muted);}',
      '.wn-suggest-chip{font-family:inherit;cursor:pointer;}',
      '.wn-suggest-chip:hover{border-color:var(--wn-brand);}',
      '.wn-suggest-chip:focus-visible{outline:2px solid var(--wn-brand);outline-offset:2px;}',
      '.wn-notice{display:flex;gap:7px;align-items:flex-start;}',
      '.wn-notice-mark{flex:0 0 auto;font-weight:700;opacity:.85;}',
      '.wn-notice-text{flex:1 1 auto;}',
      '.wn-foot{font-size:11.5px;color:var(--wn-muted);border-top:1px solid var(--wn-line-soft);padding-top:10px;}',
      '.wn-tabs{display:flex;gap:4px;border-bottom:1px solid var(--wn-line);padding-bottom:0;}',
      '.wn-tab{appearance:none;border:0;background:transparent;padding:7px 12px;font-size:12.5px;color:var(--wn-muted);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;}',
      '.wn-tab:hover{color:var(--wn-fg);}',
      '.wn-tab-on{color:var(--wn-fg);font-weight:600;border-bottom-color:var(--wn-brand);}',
      '.wn-calls-stats{display:flex;gap:10px;flex-wrap:wrap;}',
      '.wn-calls-stat{flex:1 1 120px;display:flex;flex-direction:column;gap:2px;padding:10px 12px;background:var(--wn-card);border:1px solid var(--wn-line-soft);border-radius:10px;}',
      '.wn-calls-stat b{font-size:20px;line-height:1.1;}',
      '.wn-calls-stat span{font-size:11.5px;color:var(--wn-muted);}',
      '.wn-calls-note{font-size:11.5px;color:var(--wn-faint);}',
      '.wn-calls-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
      '.wn-calls-check{display:inline-flex;gap:5px;align-items:center;font-size:12px;color:var(--wn-muted);}',
      '.wn-calls-table{width:100%;border-collapse:collapse;font-size:12px;}',
      '.wn-calls-table th{text-align:left;font-weight:600;color:var(--wn-muted);border-bottom:1px solid var(--wn-line);padding:6px 8px;}',
      '.wn-calls-table td{border-bottom:1px solid var(--wn-line-soft);padding:6px 8px;vertical-align:top;}',
      '.wn-calls-time{color:var(--wn-muted);white-space:nowrap;}',
      '.wn-calls-query{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.wn-calls-hits{text-align:right;font-variant-numeric:tabular-nums;}',
      '.wn-calls-ms{text-align:right;font-variant-numeric:tabular-nums;color:var(--wn-muted);}',
      '.wn-calls-ms.wn-slow{color:#b4552d;}',
      '.wn-calls-empty{padding:18px 12px;text-align:center;color:var(--wn-muted);font-size:12.5px;background:var(--wn-card);border:1px dashed var(--wn-line);border-radius:10px;}',
      '.wn-calls-warn{font-size:11.5px;color:var(--wn-warn);}',
      '.wn-gov{display:flex;flex-direction:column;gap:7px;padding:12px;background:var(--wn-card);border:1px solid var(--wn-line-soft);border-radius:10px;}',
      '.wn-gov-head{font-size:12.5px;font-weight:600;color:var(--wn-fg);}',
      '.wn-gov-off{padding:8px 10px;background:var(--wn-bar);border-radius:8px;font-size:12px;color:var(--wn-muted);}',
      '.wn-gov-rows{display:flex;flex-direction:column;gap:6px;}',
      '.wn-gov-row{display:flex;flex-direction:column;gap:2px;padding:8px 10px;background:var(--wn-field);border:1px solid var(--wn-line-soft);border-radius:8px;}',
      '.wn-gov-row.wn-gov-sub{margin-left:16px;}',
      '.wn-gov-row-head{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;}',
      '.wn-gov-row-head b{font-variant-numeric:tabular-nums;}',
      '.wn-gov-detail,.wn-gov-note{font-size:11.5px;color:var(--wn-muted);line-height:1.5;}',
      '}',
    ].join('')

    /* ------------------------------ 右侧栏 ------------------------------ */

    var SIDEBAR_TAB_ID = 'dsh-wiki-notes/search'
    var SIDEBAR_TAB_KIND = 'wiki-notes-search'

    function WikiSearchSidebarTab() {
      return h(
        'div',
        { className: 'wn-root wn-sidebar' },
        h(
          'div',
          { className: 'wn-head' },
          h('div', { className: 'wn-title' }, '知识库'),
          h('div', { className: 'wn-sub' }, '在这儿查一遍，看模型为什么会、或者为什么不会想起你的笔记。'),
        ),
        h(WikiSearchPanel, { compact: true }),
      )
    }

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

      // 设置弹层左侧的一级入口
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

      // 右侧栏入口：可选能力，坏了也不能连累设置页。
      // 服务不存在时 ctx.inject 的回调根本不会执行 —— 这就是要的故障隔离。
      // 也刻意没把它写进 package.json 的 dsh.client.inject：那会把「侧栏模块在不在」
      // 变成整个客户端包的加载前提，侧栏一缺，连设置页都进不去。
      if (typeof ctx.inject !== 'function') return
      ctx.inject(['sidebarRightTabs'], function (owner) {
        var tabs = owner.get('sidebarRightTabs')
        if (tabs === null || tabs === undefined || typeof tabs.register !== 'function') return
        owner.effect(function () {
          return tabs.register({
            id: SIDEBAR_TAB_ID,
            kind: SIDEBAR_TAB_KIND,
            priority: 'extension',
            title: function () {
              return '知识库'
            },
            guide: [
              {
                order: 100,
                // 侧栏显示的是 guide 这条的标题，不是上面的 title —— 两处必须同一个字符串，
                // 否则页签会写成一句说明（"按关键词查一遍…"）而不是入口名。
                title: function () {
                  return '知识库'
                },
              },
            ],
          })
        }, 'dsh-wiki-notes: sidebar tab type')

        // 必须用 owner 的槽位表登记：本模块的 ctx.slots 属于插件自己的作用域，
        // 往别人的插槽里注册会被静默丢掉。
        var ownerRegister = owner.slots.register.bind(owner.slots)
        owner.slots.inject('sidebar.right.pane.tab', function () {
          return ownerRegister(
            {
              name: 'sidebar.right.pane.tab',
              key: SIDEBAR_TAB_ID,
              inject: function () {
                return {}
              },
            },
            function () {
              return h(WikiSearchSidebarTab, {})
            },
          )
        })
      })
    }

    module.exports = {
      name: 'wiki-notes',
      inject: ['slots'],
      apply: apply,
      // 只给 tools/preview.mjs 用：把面板的零件交出去，好在真 CSS 下渲染一张静态预览。
      // 宿主不看这个键，多一个也不影响加载。
      __preview: {
        TermChip: TermChip,
        SearchHit: SearchHit,
        CiteRow: CiteRow,
        CopyButton: CopyButton,
        Notice: Notice,
        groupHits: groupHits,
        CountRow: CountRow,
        TermRow: TermRow,
        HitList: HitList,
        EmptyState: EmptyState,
        highlightNodes: highlightNodes,
        bytesLabel: bytesLabel,
        shortTime: shortTime,
        WikiSearchPanel: WikiSearchPanel,
        WikiSearchSidebarTab: WikiSearchSidebarTab,
        WikiCallsSection: WikiCallsSection,
        WikiGovernancePanel: WikiGovernancePanel,
      },
    }
    return module.exports
  },
})
