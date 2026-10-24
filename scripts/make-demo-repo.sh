#!/usr/bin/env bash
# Builds a demo repository with branches, merges, tags, a remote and a pending
# conflict scenario. Used for manual testing and the UI smoke test.
#   scripts/make-demo-repo.sh <target-dir>
set -euo pipefail
TARGET="${1:?usage: make-demo-repo.sh <target-dir>}"
rm -rf "$TARGET"
mkdir -p "$TARGET"
cd "$TARGET"

export GIT_AUTHOR_NAME="Ada Lovelace" GIT_AUTHOR_EMAIL="ada@example.com"
export GIT_COMMITTER_NAME="Ada Lovelace" GIT_COMMITTER_EMAIL="ada@example.com"
t=1767225600 # 2026-01-01
tick() { t=$((t + 3600 * ${1:-5})); export GIT_AUTHOR_DATE="$t +0300" GIT_COMMITTER_DATE="$t +0300"; }
as() { export GIT_AUTHOR_NAME="$1" GIT_AUTHOR_EMAIL="$2"; }

git init -q -b main demo
cd demo
git config user.name "Demo User"
git config user.email "demo@example.com"
git config core.autocrlf false

mkdir -p src docs
cat > src/app.ts <<'EOF'
export interface User {
  id: number;
  name: string;
}

export function greet(user: User): string {
  return `Hello, ${user.name}!`;
}

export function total(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
EOF
cat > README.md <<'EOF'
# Demo project

A small project used to try Revqora.
EOF
cat > src/config.json <<'EOF'
{
  "port": 8080,
  "debug": false
}
EOF
tick; git add -A; git commit -q -m "Initial project structure"

tick; as "Grace Hopper" "grace@example.com"
cat >> src/app.ts <<'EOF'

export function average(values: number[]): number {
  return values.length ? total(values) / values.length : 0;
}
EOF
git commit -qam "Add average helper"
git tag -a v0.1.0 -m "First preview"

# feature/auth branch
git switch -q -c feature/auth
tick; as "Linus Torvalds" "linus@example.com"
cat > src/auth.ts <<'EOF'
export function login(name: string, password: string): boolean {
  return name.length > 0 && password.length >= 8;
}
EOF
git add -A; git commit -qm "Add login function"
tick
sed -i 's/password.length >= 8/password.length >= 12/' src/auth.ts
git commit -qam "Require longer passwords"

# feature/ui branch from main
git switch -q main
git switch -q -c feature/ui
tick; as "Margaret Hamilton" "margaret@example.com"
cat > src/ui.ts <<'EOF'
export const theme = { primary: "#7c5cff", radius: 8 };
EOF
git add -A; git commit -qm "Introduce UI theme tokens"
tick
echo 'export const spacing = [4, 8, 12, 16];' >> src/ui.ts
git commit -qam "Spacing scale"

# main continues
git switch -q main
tick; as "Ada Lovelace" "ada@example.com"
sed -i 's/"debug": false/"debug": true/' src/config.json
git commit -qam "Enable debug mode by default"
tick
git merge -q --no-ff -m "Merge branch 'feature/auth'" feature/auth
tick; as "Grace Hopper" "grace@example.com"
cat >> README.md <<'EOF'

## Usage

Run `npm start` and open the app.
EOF
git commit -qam "Document usage"
git tag v0.2.0

# hotfix branch that will conflict with main
git switch -q -c hotfix/greeting
tick; as "Linus Torvalds" "linus@example.com"
sed -i 's/Hello, ${user.name}!/Hi ${user.name}, welcome back!/' src/app.ts
git commit -qam "Friendlier greeting"
git switch -q main
tick; as "Ada Lovelace" "ada@example.com"
sed -i 's/Hello, ${user.name}!/Good day, ${user.name}./' src/app.ts
git commit -qam "Formal greeting for the enterprise edition"

# remote: a bare clone, then diverge locally and remotely
cd ..
git clone -q --bare demo origin.git
cd demo
git remote add origin ../origin.git
git fetch -q origin
git branch -q --set-upstream-to=origin/main main
# remote gets a new commit
cd ..
git clone -q origin.git other
cd other
git config user.name "Teammate"; git config user.email "team@example.com"
tick; echo "- teammate note" >> README.md; git commit -qam "Teammate: README note"; git push -q origin main
cd ../demo
git fetch -q origin
# local commit not pushed yet
tick; as "Ada Lovelace" "ada@example.com"
echo 'export const VERSION = "0.3.0";' > src/version.ts
git add -A; git commit -qm "Bump version to 0.3.0"

# working tree changes
cat >> src/app.ts <<'EOF'

export function shout(text: string): string {
  return text.toUpperCase() + "!";
}
EOF
sed -i 's/"port": 8080/"port": 9090/' src/config.json
echo "Draft notes" > docs/notes.md
echo "Demo repository ready: $(pwd)"
