// DSH 每次启动端口都会变，用环境变量传，别写死
const ORIGIN = process.env.DSH_WEB_URL || process.env.DSH_ORIGIN || 'http://127.0.0.1:61900'
const BASE = ORIGIN.replace(/\/$/, '') + '/api/wiki-notes'

async function get(p) {
  const r = await fetch(BASE + p, { cache: 'no-store' })
  return r.json()
}
async function post(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return r.json()
}

const target = (process.env.WIKI_ROOT ?? '')
const parent = (process.env.WIKI_ROOT_PARENT ?? '')
if (target === '') {
  console.log('跳过：需要 WIKI_ROOT / WIKI_ROOT_PARENT，且 DSH 正在运行（DSH_WEB_URL）')
  process.exit(0)
}

console.log('1) /state      ->', JSON.stringify(await get('/state')))
console.log('2) /check 正确 ->', JSON.stringify(await post('/check', { root: target })))
console.log('3) /check 上层 ->', JSON.stringify(await post('/check', { root: parent })))
console.log('4) /check 乱写 ->', JSON.stringify(await post('/check', { root: 'D:/不存在的目录' })))
console.log('5) /save 原值  ->', JSON.stringify(await post('/save', { root: target })))
console.log('6) /rescan     ->', JSON.stringify(await post('/rescan')))
