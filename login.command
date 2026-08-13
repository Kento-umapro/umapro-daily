#!/bin/zsh
# ダブルクリックで、ログインし直し → そのまま取得 → サイト更新 まで走る。
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$HOME/umapro-daily" || exit 1
node scripts/browser.mjs --fetch 2025-01-01
echo
echo "終わりました。このウィンドウは閉じて大丈夫です。"
