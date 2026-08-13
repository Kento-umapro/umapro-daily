#!/bin/zsh
# 毎朝の更新。ダイニー・blayn・MPS から取って、集計して、暗号化して、GitHubに上げる。
set -u
cd "$HOME/umapro-daily" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
LOG="logs/$(date +%Y-%m-%d).log"
mkdir -p logs
{
  echo "===== $(date '+%F %T') ====="
  node scripts/fetch.mjs   || echo "!! fetch が異常終了"
  python3 scripts/build.py || { echo "!! build が失敗したので中止"; exit 1; }
  node scripts/encrypt.mjs || { echo "!! encrypt が失敗したので中止"; exit 1; }
  if [[ -n "$(git status --porcelain docs)" ]]; then
    git add docs
    git commit -q -m "$(date '+%Y-%m-%d') 更新"
    git push -q origin main && echo "公開しました"
  else
    echo "変更なし"
  fi
  echo "----- $(date '+%F %T') 完了"
} >> "$LOG" 2>&1
