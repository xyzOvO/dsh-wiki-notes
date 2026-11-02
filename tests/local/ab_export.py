#!/usr/bin/env python3
"""ab_export.py —— 直接调用 search.py 里的函数，把它的 top-5 结果导成 JSON。

为什么不在 node 里 spawn python：沙箱禁止跨进程 spawn（EPERM）。
所以由外面用 bash 跑一次、落到 tests/ab_baseline.json，node 再读那份文件做对比。
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

# 对照查询默认用中性词。作者本地跑真实查询时从环境变量传，别把私人笔记主题写进仓库：
#   AB_QUERIES="词一|词二|词三" python tests/local/ab_export.py
QUERIES = [q.strip() for q in os.environ.get(
    "AB_QUERIES",
    "上下文 工程|记忆 系统|检索 增强|微调|证据 分级|窗口",
).split("|") if q.strip()]

pages = s.load_pages()
result = {}
for query in QUERIES:
    terms = [t.lower() for t in query.split()]
    scored = [(s.score(p, terms), p["stem"]) for p in pages if s.score(p, terms) > 0]
    scored.sort(key=lambda item: -item[0])
    result[query] = [name for _, name in scored[:5]]

print(json.dumps(result, ensure_ascii=False, indent=2))
