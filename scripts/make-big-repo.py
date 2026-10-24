"""Generates a large synthetic repository with git fast-import (for performance checks).

    python scripts/make-big-repo.py <target-dir> [commits=60000] [branches=40]

Branches fork off main at random points and some are merged back, so the graph has
real lanes. Runs in a few seconds even for 100k commits.
"""
import random
import subprocess
import sys
from pathlib import Path

target = Path(sys.argv[1])
commits = int(sys.argv[2]) if len(sys.argv) > 2 else 60000
branches = int(sys.argv[3]) if len(sys.argv) > 3 else 40
random.seed(7)
target.mkdir(parents=True, exist_ok=True)
subprocess.run(["git", "init", "-q", "-b", "main", str(target)], check=True)

authors = ["Alex Rivera <alex@example.com>", "Sam Chen <sam@example.com>", "Jordan Blake <jordan@example.com>", "Taylor Morgan <taylor@example.com>", "Casey Brooks <casey@example.com>"]
words = "fix add refactor update remove improve parser graph cache index merge layout theme button docs tests api client server".split()

out = []
mark = 0
t = 1_500_000_000
main_tip = None
branch_tips = {}
marks_on_main = []


def blob(data: bytes) -> int:
    global mark
    mark += 1
    out.append(b"blob\nmark :%d\ndata %d\n" % (mark, len(data)) + data + b"\n")
    return mark


def commit(ref: str, parent, extra_parent=None, msg=None) -> int:
    global mark, t
    t += random.randint(60, 7200)
    b = blob(("line %d\n" % mark).encode() * 3)
    mark += 1
    m = mark
    author = random.choice(authors)
    msg = msg or f"{random.choice(words).capitalize()} {random.choice(words)} {random.choice(words)} #{m}"
    data = msg.encode()
    s = b"commit %s\nmark :%d\nauthor %s %d +0000\ncommitter %s %d +0000\ndata %d\n%s\n" % (ref.encode(), m, author.encode(), t, author.encode(), t, len(data), data)
    if parent:
        s += b"from :%d\n" % parent
    if extra_parent:
        s += b"merge :%d\n" % extra_parent
    s += b"M 100644 :%d file%d.txt\n\n" % (b, m % 500)
    out.append(s)
    return m


for i in range(commits):
    r = random.random()
    if branch_tips and r < 0.35:
        name = random.choice(list(branch_tips))
        branch_tips[name] = commit(f"refs/heads/{name}", branch_tips[name])
        if random.random() < 0.03:
            main_tip = commit("refs/heads/main", main_tip, branch_tips[name], f"Merge branch '{name}'")
            marks_on_main.append(main_tip)
            del branch_tips[name]
    elif len(branch_tips) < branches and r < 0.40 and marks_on_main:
        name = f"feature/{random.choice(words)}-{i}"
        base = random.choice(marks_on_main[-200:])
        branch_tips[name] = commit(f"refs/heads/{name}", base)
    else:
        main_tip = commit("refs/heads/main", main_tip)
        marks_on_main.append(main_tip)

subprocess.run(["git", "-C", str(target), "fast-import", "--quiet"], input=b"".join(out), check=True)
subprocess.run(["git", "-C", str(target), "checkout", "-q", "-f", "main"], check=True)
print(f"created {commits} commits, {len(branch_tips)} open branches in {target}")
