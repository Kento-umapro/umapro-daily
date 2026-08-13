#!/bin/zsh
# 自動ログインの設定。パスワードはこのMacのキーチェーンにだけ入る。
# ファイルにもGitHubにも書かれないし、画面にも出ない。
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$HOME/umapro-daily" || exit 1

echo
echo "  ───────────────────────────────────────────────"
echo "   自動ログインの設定"
echo "   パスワードはキーチェーンに保存します（画面には出ません）"
echo "  ───────────────────────────────────────────────"
echo

# ── blayn ─────────────────────────────────────────
echo "▼ blayn"
printf "  ログインID: "
read BLAYN_ID
if [[ -n "$BLAYN_ID" ]]; then
  security delete-generic-password -s umapro-blayn >/dev/null 2>&1
  echo "  パスワードを入力してください（表示されません）"
  security add-generic-password -s umapro-blayn -a "$BLAYN_ID" -w -U || exit 1
  echo "  → 保存しました"
fi
echo

# ── MPS ───────────────────────────────────────────
echo "▼ MPS（multiweb）"
printf "  企業コード: "
read MPS_KIGYO
printf "  アカウント: "
read MPS_ACCT
if [[ -n "$MPS_ACCT" ]]; then
  security delete-generic-password -s umapro-mps >/dev/null 2>&1
  echo "  パスワードを入力してください（表示されません）"
  security add-generic-password -s umapro-mps -a "$MPS_ACCT" -w -U || exit 1
  echo "  → 保存しました"
fi
echo

# IDと企業コードは config.json に書く（config.json はコミットされない）
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
print('  設定を保存しました')
PY

echo
echo "  続けて、自動ログインで取れるか試します…"
echo
node scripts/fetch.mjs 2>&1 | tail -12
echo
echo "  「blayn ○○行」「MPS ○○行」と出ていれば成功です。"
echo "  このウィンドウは閉じて大丈夫です。"
