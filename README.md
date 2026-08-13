# うまプロ 売上（毎日）

各店の前日売上を毎朝ひろって、今月と年間の着地、目標達成のペースを出す社内用サイト。

```
POS(日別) ┐
POS(日別) ├→ .cache/raw.json → build.py → .cache/payload.json → encrypt.mjs → docs/data/payload.json
発注(月別)┘                      (円入り・非公開)                 (合言葉で暗号化)
```

## 見られること

- **前日の売上**（全店合計と店別・いつもの同じ曜日との比較）
- **目標達成のペース** … 今日までに積み上がっているべき額との差、残り日数で1日あたりいくら必要か
- **今月の着地** と **年間の着地**
- 「くわしく見る」を押すと 発注・月別・店別・前提

## 毎朝の自動更新

`~/Library/LaunchAgents/com.umapro.daily.plist` が毎朝 **9:10** に `run.sh` を叩く。
専用のブラウザプロファイル `.profile` を使うので、他の朝のジョブとぶつからない。

```bash
~/umapro-daily/run.sh                    # 手で動かす
node ~/umapro-daily/scripts/browser.mjs  # ログインが切れたとき
```

browser.mjs は3つタブを開く。切れているものだけログインし直してウィンドウを閉じる。
**閉じないと翌朝の自動取得がプロファイルを掴めない。**

## 設定

料率・目標・店舗・祝日は `config.json` にまとめてある。
**このファイルは商売の条件が入るのでコミットしない**（`config.example.json` が形だけの見本）。

## 公開と合言葉

GitHub Pages は公開なので、**金額は AES-256-GCM で暗号化**して置いている（合言葉なしでは読めない）。
合言葉は `.env` の `PASSPHRASE`。変えるときは `.env` を書き換えて `run.sh` を回す。

`.cache/` `.env` `.profile/` `config.json` は絶対にコミットしない。
