#!/bin/zsh
# 自動ログインの設定。パスワードはこのMacのキーチェーンにだけ入る。
# ファイルにもGitHubにも書かれないし、画面にも出ない。
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$HOME/umapro-daily" || exit 1
exec < /dev/tty          # 入力は必ずキーボードから読む

ask_pw () {   # ask_pw <サービス名> <アカウント>
  local svc="$1" acct="$2" pw pw2
  while true; do
    printf "  パスワード（表示されません）: "
    read -rs pw; echo
    if [[ -z "$pw" ]]; then echo "  空です。入れ直してください"; continue; fi
    printf "  もう一度: "
    read -rs pw2; echo
    if [[ "$pw" != "$pw2" ]]; then echo "  一致しません。入れ直してください"; continue; fi
    break
  done
  security delete-generic-password -s "$svc" >/dev/null 2>&1
  security add-generic-password -s "$svc" -a "$acct" -w "$pw" -U || return 1
  pw=""; pw2=""
  local n
  n=$(security find-generic-password -s "$svc" -w 2>/dev/null | tr -d '\n' | wc -c | tr -d ' ')
  echo "  → 保存しました（${n}文字）"
}

echo
echo "  ───────────────────────────────────────────────"
echo "   自動ログインの設定"
echo "   パスワードはキーチェーンにだけ入ります"
echo "  ───────────────────────────────────────────────"
echo

echo "▼ blayn"
printf "  ログインID: "
read -r BLAYN_ID
[[ -n "$BLAYN_ID" ]] && ask_pw umapro-blayn "$BLAYN_ID"
echo

echo "▼ MPS（multiweb）"
printf "  企業コード: "
read -r MPS_KIGYO
printf "  アカウント: "
read -r MPS_ACCT
[[ -n "$MPS_ACCT" ]] && ask_pw umapro-mps "$MPS_ACCT"
echo

python3 - "$BLAYN_ID" "$MPS_KIGYO" "$MPS_ACCT" <<'PY'
import json, sys, os
p = os.path.join(os.path.expanduser('~'), 'umapro-daily', 'config.json')
c = json.load(open(p))
blayn_id, kigyo, acct = sys.argv[1], sys.argv[2], sys.argv[3]
if blayn_id:
    c.setdefault('blayn', {})['login_id'] = blayn_id
if kigyo or acct:
    c.setdefault('mps', {})
    if kigyo:
        c['mps']['kigyo_code'] = kigyo
    if acct:
        c['mps']['account'] = acct
c['_login'] = 'パスワードはキーチェーン（umapro-blayn / umapro-mps）。ここにはIDだけ'
json.dump(c, open(p, 'w'), ensure_ascii=False, indent=2)
print('  IDを保存しました')
PY

echo
echo "  ───────────────────────────────────────────────"
echo "   自動ログインを試します。10分ほどかかります。"
echo "   途中の行が流れていれば動いています。"
echo "  ───────────────────────────────────────────────"
echo
node scripts/fetch.mjs && python3 scripts/build.py && node scripts/encrypt.mjs \
  && git add docs && git commit -q -m "$(date +%F) 更新" && git push -q origin main \
  && echo && echo "  サイトを更新しました"
echo
echo "  終わりです。このウィンドウは閉じて大丈夫です。"
