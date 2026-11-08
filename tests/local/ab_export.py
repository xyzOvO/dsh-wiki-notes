#!/usr/bin/env python3
"""ab_export.py —— 直接调用 search.py 里的函数，把它的 top-5 结果导成 JSON。

为什么不在 node 里 spawn python：沙箱禁止跨进程 spawn（EPERM）。
所以由外面用 bash 跑一次、落到 tests/local/ab_baseline.json，node 再读那份文件做对比。

查询来源（按优先级）：
  1. 环境变量 AB_QUERIES="词一|词二"          —— 临时试探，不进文件
  2. tests/local/queries.json 的 queries[].q  —— 本机评测集（含真实笔记主题，不进仓库）
  3. 内置中性词（上下文 工程|记忆 系统|…）    —— 新克隆仓库时也能跑
三者取第一个非空的，别同时用，否则基线里到底有哪些查询说不清。
"""

import json
import os
import sys
from pathlib import Path

# search.py 所在目录：作者私有，用环境变量指过来；没设就跳过（这是本地回归，不是通用测试）
TOOLS_DIR = os.environ.get("WIKI_TOOLS_DIR", "")
if TOOLS_DIR == "":
    print("跳过：需要 WIKI_TOOLS_DIR 指向放着 search.py 的目录", file=sys.stderr)
    sys.exit(0)

sys.path.insert(0, str(Path(TOOLS_DIR)))
import search as s  # noqa: E402

NEUTRAL = "上下文 工程|记忆 系统|检索 增强|微调|证据 分级|窗口"
QUERIES_JSON = Path(__file__).resolve().parent / "queries.json"


def from_suite():
    """读本机评测集的查询顺序。顺序必须稳定：基线是按 key 对查询的，顺序变了没关系，
    但同名查询只能出现一次，否则后一条会悄悄覆盖前一条。"""
    try:
        raw = QUERIES_JSON.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return []
    try:
        suite = json.loads(raw)
    except json.JSONDecodeError as error:
        print(f"queries.json 不是合法 JSON：{error}", file=sys.stderr)
        sys.exit(1)
    out = []
    for item in suite.get("queries", []):
        query = str(item.get("q", "")).strip()
        if query and query not in out:
            out.append(query)
    return out


env_queries = [q.strip() for q in os.environ.get("AB_QUERIES", "").split("|") if q.strip()]
QUERIES = env_queries or from_suite() or [q.strip() for q in NEUTRAL.split("|") if q.strip()]

pages = s.load_pages()
result = {}
for query in QUERIES:
    terms = [t.lower() for t in query.split()]
    scored = [(s.score(p, terms), p["stem"]) for p in pages if s.score(p, terms) > 0]
    scored.sort(key=lambda item: -item[0])
    result[query] = [name for _, name in scored[:5]]

print(json.dumps(result, ensure_ascii=False, indent=2))
