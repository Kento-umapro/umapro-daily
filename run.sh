#!/bin/zsh
# 毎朝の更新。9:30に走り、ダイニーの前日ぶんが揃うまで10分おきに再挑戦する。
# 揃った時点で当日の目印を置き、以降の実行は即終了する。
set -u
cd "$HOME/umapro-daily" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
mkdir -p logs .cache
TODAY=$(date +%F)
LOG="logs/$TODAY.log"
DONE=".cache/done-$TODAY"

if [[ -f "$DONE" ]]; then
  echo "$(date '+%F %T') 本日ぶんは取得済みなので何もしません" >> "$LOG"
  exit 0
fi

{
  echo "===== $(date '+%F %T') ====="
  node scripts/fetch.mjs   || echo "!! fetch が異常終了"
  python3 scripts/build.py || { echo "!! build が失敗したので中止"; exit 1; }
  node scripts/encrypt.mjs || { echo "!! encrypt が失敗したので中止"; exit 1; }
  if [[ -n "$(git status --porcelain docs)" ]]; then
    git add docs
    git commit -q -m "$TODAY 更新"
    git push -q origin main && echo "公開しました"
  else
    echo "変更なし"
  fi

  # 前日ぶんのダイニーが全店そろったか。そろっていれば今日はもう走らせない
  if python3 - <<'PY'
import json, os, sys, datetime as dt
root = os.path.expanduser('~/umapro-daily')
raw = json.load(open(os.path.join(root, '.cache', 'raw.json')))
cfg = json.load(open(os.path.join(root, 'config.json')))
blayn = {cfg.get('blayn', {}).get('code', '000400')}
want = len([c for c in cfg['shops'] if c not in blayn])
yd = (dt.date.fromisoformat(raw['today']) - dt.timedelta(days=1)).isoformat()
got = len({r['code'] for r in raw['dinii'] if r['date'] == yd})
print(f"  前日({yd})のダイニー {got}/{want}店")
sys.exit(0 if got >= want else 1)
PY
  then
    touch "$DONE"
    echo "  そろったので本日ぶんは完了"
    find .cache -name 'done-*' -mtime +7 -delete 2>/dev/null
  else
    echo "  まだ揃っていないので10分後にもう一度"
  fi
  echo "----- $(date '+%F %T') 完了"
} >> "$LOG" 2>&1
