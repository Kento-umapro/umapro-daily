#!/usr/bin/env python3
"""前日売上・今月の着地・年間の着地を出して、サイト用のJSONを書く。

  .cache/raw.json ──▶ build.py ──▶ .cache/payload.json ──▶ encrypt.mjs ──▶ docs/data/payload.json

考え方
  日次売上 = 店の水準 × 月係数 × 曜日シェア
  ・月係数と曜日シェアは全店の実績から毎回学習し直す
  ・2026年7月から全店10%値上げ。6月以前は ×1.10 して価格を揃えてから水準を測る
  ・本部売上 = 38%店×0.38 ＋ 5%店×0.05 ＋ 直営前橋の売上全額 ＋ MPS内部請求（前橋を除く11店）
    ただし今年は 石山駅前・日吉駅前 がロイヤリティ10%未収（28%のみ）、
    門前仲町は7月の売上ぶんから 10%→5%（33%）
"""
import json, os, math, statistics, collections, calendar, datetime as dt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = json.load(open(os.path.join(ROOT, '.cache', 'raw.json')))
CFG = json.load(open(os.path.join(ROOT, 'config.json')))

TODAY = dt.date.fromisoformat(RAW['today'])
YESTERDAY = TODAY - dt.timedelta(days=1)
YEAR = TODAY.year
SHOPS = CFG['shops']                       # code -> {name, kind}
RATE = {'r38': 0.38, 'r5': 0.05, 'own': 1.00}
HIKE_FROM = CFG['hike']['from']            # '2026-07'
HIKE = CFG['hike']['rate']                 # 1.10
UMACHA = CFG['umacha_yearly']
TARGET = CFG['target_yearly']
ADJ = CFG['royalty_adjustments']           # 今年もらえていない分

# ── 1. 日次売上（税込）────────────────────────────────────────
daily = {}                                  # (code, 'YYYY-MM-DD') -> 税込の円
detail = {}                                 # (code, 'YYYY-MM-DD') -> 税込/税抜/客数/組数
for r in RAW['dinii'] + RAW['blayn']:
    if r['code'] in SHOPS and r['sales'] > 0:
        daily[(r['code'], r['date'])] = r['sales']
        detail[(r['code'], r['date'])] = {
            'incl': r['sales'],
            'excl': r.get('excl') or round(r['sales'] / 1.1),
            'people': r.get('people') or 0,
            'groups': r.get('groups') or 0,
        }

dates = sorted({d for (_, d) in daily})
monthly = collections.defaultdict(int)      # (code, 'YYYY-MM') -> 円
mdays = collections.defaultdict(int)
for (c, d), v in daily.items():
    monthly[(c, d[:7])] += v
    mdays[(c, d[:7])] += 1


def full_month(code, ym):
    y, m = int(ym[:4]), int(ym[5:])
    return mdays.get((code, ym), 0) >= calendar.monthrange(y, m)[1] * 0.9


def padj(code, ym):
    v = monthly.get((code, ym), 0)
    return v * HIKE if ym < HIKE_FROM else v


CUR_YM = TODAY.strftime('%Y-%m')

# ── 2. 月係数（メディアンポリッシュ）──────────────────────────
obs = [(c, int(ym[5:]), math.log(padj(c, ym)), ym)
       for (c, ym) in monthly
       if ym < CUR_YM and full_month(c, ym) and monthly[(c, ym)] > 0]
shop_eff = {c: 0.0 for c in SHOPS}
mon_eff = {m: 0.0 for m in range(1, 13)}
for _ in range(30):
    for c in shop_eff:
        rs = [lv - mon_eff[mn] for (cc, mn, lv, _) in obs if cc == c]
        if rs:
            shop_eff[c] = statistics.median(rs)
    for m in mon_eff:
        rs = [lv - shop_eff[cc] for (cc, mn, lv, _) in obs if mn == m]
        if rs:
            mon_eff[m] = statistics.median(rs)
    mu = statistics.mean(mon_eff.values())
    for m in mon_eff:
        mon_eff[m] -= mu
    for c in shop_eff:
        shop_eff[c] += mu
season = {m: math.exp(mon_eff[m]) for m in range(1, 13)}

# ── 3. 曜日シェア（店ごと。実績が薄い店は全社の形に寄せる）────
def dow_profile(rows):
    """曜日 -> その月の平均日に対する倍率。
    月ごとの水準（季節・値上げ）を先に割ってから曜日を測らないと、
    月の高い安いが曜日の係数に混ざってしまう。"""
    per_month = collections.defaultdict(list)
    for d, v in rows:
        per_month[d[:7]].append(v)
    base = {ym: statistics.mean(vs) for ym, vs in per_month.items() if vs}
    by = collections.defaultdict(list)
    for d, v in rows:
        b = base.get(d[:7])
        if b:
            by[dt.date.fromisoformat(d).weekday()].append(v / b)
    if len(by) < 7:
        return None
    med = {w: statistics.median(vs) for w, vs in by.items()}
    mu = statistics.mean(med.values())
    return {w: med[w] / mu for w in range(7)} if mu else None


recent = [d for d in dates if d >= (TODAY - dt.timedelta(days=180)).isoformat()]
all_rows = [(d, sum(daily.get((c, d), 0) for c in SHOPS)) for d in recent]
GLOBAL_DOW = dow_profile([(d, v) for d, v in all_rows if v > 0]) or {w: 1.0 for w in range(7)}
dow = {}
for c in SHOPS:
    rows = [(d, daily[(c, d)]) for d in recent if (c, d) in daily]
    dow[c] = dow_profile(rows) if len(rows) >= 90 else None
    if not dow[c]:
        dow[c] = dict(GLOBAL_DOW)

# ── 4. 店の水準（直近6ヶ月の季節調整済み平均・値上げ後換算）───
level = {}
for c in SHOPS:
    vals = [padj(c, ym) / season[int(ym[5:])]
            for ym in sorted({y for (cc, y) in monthly if cc == c})
            if ym < CUR_YM and full_month(c, ym) and monthly[(c, ym)] > 0]
    level[c] = statistics.mean(vals[-6:]) if vals else 0

# ── 5. 日次の見込み ───────────────────────────────────────────
def expected_day(code, d):
    """その日の期待売上。月の総額を曜日シェアで割り振る。"""
    y, m = d.year, d.month
    dim = calendar.monthrange(y, m)[1]
    wts = [dow[code][dt.date(y, m, i + 1).weekday()] for i in range(dim)]
    tot = sum(wts)
    if not tot:
        return 0
    return level[code] * season[m] * wts[d.day - 1] / tot


def month_forecast(code, ym):
    """その月の着地見込み。実績が入っている日はそのまま、残りは期待値。"""
    y, m = int(ym[:4]), int(ym[5:])
    dim = calendar.monthrange(y, m)[1]
    got, rest = 0, 0
    for i in range(1, dim + 1):
        d = dt.date(y, m, i)
        key = (code, d.isoformat())
        if key in daily:
            got += daily[key]
        elif d <= YESTERDAY:
            pass                              # 実績が無い＝休業日とみなして0
        else:
            rest += expected_day(code, d)
    return got, rest


# ── 6. 本部の取り分 ──────────────────────────────────────────
def take_rate(code, ym):
    r = RATE[SHOPS[code]['kind']]
    a = ADJ.get(code)
    if a and ym >= a.get('from', '0000-00') and ym <= a.get('to', '9999-99'):
        r = a['rate']
    return r


mps = {}                                    # (code, ym) -> 内部請求（税込）
mps_all = {}
for r in RAW.get('mps', []):
    if r['code'] == 'ALL':
        mps_all[r['ym']] = r['internal']
    else:
        mps[(r['code'], r['ym'])] = r['internal']

MPS_EXCLUDE = set(CFG['mps_exclude'])
mps_ratio = {}
for c in SHOPS:
    if c in MPS_EXCLUDE:
        continue
    rs = [mps[(c, ym)] / padj(c, ym)
          for ym in sorted({y for (cc, y) in mps if cc == c})
          if ym < CUR_YM and padj(c, ym) > 0 and full_month(c, ym)]
    if rs:
        mps_ratio[c] = statistics.mean(rs[-6:])
GLOBAL_MPS = statistics.median(list(mps_ratio.values())) if mps_ratio else 0.27

# ── 7. 年間の積み上げ ────────────────────────────────────────
YMS = [f'{YEAR}-{m:02d}' for m in range(1, 13)]
months_out = []
for ym in YMS:
    got_t = rest_t = 0
    hq_got = hq_rest = 0
    mps_m = 0
    per_shop = {}
    for c in SHOPS:
        g, r = month_forecast(c, ym)
        per_shop[c] = {'actual': round(g), 'forecast': round(g + r)}
        got_t += g
        rest_t += r
        rt = take_rate(c, ym)
        hq_got += g * rt
        hq_rest += r * rt
        if c not in MPS_EXCLUDE:
            v = mps.get((c, ym))
            if v and ym < CUR_YM:
                mps_m += v
            else:
                mps_m += (g + r) * mps_ratio.get(c, GLOBAL_MPS)
    months_out.append({
        'ym': ym,
        'sales_actual': round(got_t), 'sales_forecast': round(got_t + rest_t),
        'royalty': round(hq_got + hq_rest), 'royalty_actual': round(hq_got),
        'mps': round(mps_m),
        'hq': round(hq_got + hq_rest + mps_m),
        'done': ym < CUR_YM,
        'shops': per_shop,
    })

year_sales = sum(m['sales_forecast'] for m in months_out)
year_royalty = sum(m['royalty'] for m in months_out)
year_mps = sum(m['mps'] for m in months_out)
year_hq = year_royalty + year_mps
umapro = year_hq + UMACHA

# 年初来の実績（着地ではなく、いま確定している分）
ytd_sales = sum(v for (c, d), v in daily.items() if d[:4] == str(YEAR))
ytd_hq = sum(m['royalty_actual'] for m in months_out) + sum(
    (mps_all.get(m['ym'], 0) - mps.get(('000500', m['ym']), 0)) if m['done'] else 0
    for m in months_out)

# ── 8. 前日 ─────────────────────────────────────────────────
yd = YESTERDAY.isoformat()
WD = '月火水木金土日'
def usual(code, d, weeks=8):
    """いつものその曜日。直近8週の同じ曜日の実績の中央値（その日自身は除く）。"""
    vs = []
    for k in range(1, weeks + 1):
        v = daily.get((code, (d - dt.timedelta(days=7 * k)).isoformat()))
        if v:
            vs.append(v)
    return statistics.median(vs) if len(vs) >= 3 else None


def day_tag(d):
    iso = d.isoformat()
    t = CFG.get('calendar', {}).get(iso)
    if t:
        return t
    ob = CFG.get('obon')
    if ob and ob['from'] <= iso <= ob['to']:
        return ob['label']
    return None


yday_shops = []
for c in SHOPS:
    v = daily.get((c, yd))
    exp = usual(c, YESTERDAY)
    dd = detail.get((c, yd), {})
    people, groups = dd.get('people', 0), dd.get('groups', 0)
    ex = dd.get('excl') or 0
    yday_shops.append({
        'code': c, 'name': SHOPS[c]['name'], 'kind': SHOPS[c]['kind'],
        'sales': None if v is None else round(v),
        'excl': dd.get('excl'),
        'people': people, 'groups': groups,
        # 客単価は税抜ベース
        'per_person': round(ex / people) if (ex and people) else None,
        'per_group': round(ex / groups) if (ex and groups) else None,
        'expected': round(exp) if exp else None,
        'ratio': (v / exp) if (v and exp) else None,
    })
yday_total = sum(s['sales'] or 0 for s in yday_shops)
yday_excl = sum(s['excl'] or 0 for s in yday_shops if s['sales'] is not None)
yday_people = sum(s['people'] for s in yday_shops if s['sales'] is not None)
yday_groups = sum(s['groups'] for s in yday_shops if s['sales'] is not None)
yday_exp = sum(s['expected'] or 0 for s in yday_shops if s['sales'] is not None)
yday_open = sum(1 for s in yday_shops if s['sales'] is not None)

# 直近30日の推移（全店合計）
trend = []
for i in range(29, -1, -1):
    d = YESTERDAY - dt.timedelta(days=i)
    k = d.isoformat()
    v = sum(daily.get((c, k), 0) for c in SHOPS)
    trend.append({'date': k, 'dow': WD[d.weekday()], 'sales': round(v), 'tag': day_tag(d)})

# ── 9. 目標達成のペース ───────────────────────────────────────
# 目標5億から逆算して「全店でいくら売る必要があるか」を出し、
# 季節の形にそって「今日までに積み上がっているべき額」と実績を比べる。
eff = (year_hq / year_sales) if year_sales else 0        # 全店売上1円あたり本部にいくら残るか
need_year_sales = (TARGET - UMACHA) / eff if eff else 0

shape_total = 0.0
shape_todate = 0.0
d = dt.date(YEAR, 1, 1)
while d.year == YEAR:
    v = sum(expected_day(c, d) for c in SHOPS)
    shape_total += v
    if d <= YESTERDAY:
        shape_todate += v
    d += dt.timedelta(days=1)
frac = (shape_todate / shape_total) if shape_total else 0

need_todate = need_year_sales * frac
pace_gap = ytd_sales - need_todate
rest_days = (dt.date(YEAR, 12, 31) - YESTERDAY).days
need_rest = max(0.0, need_year_sales - ytd_sales)
need_per_day = need_rest / rest_days if rest_days else 0

_yd = YESTERDAY.isoformat()
last28 = [d0 for d0 in dates if (YESTERDAY - dt.timedelta(days=27)).isoformat() <= d0 <= _yd]
recent_per_day = (sum(sum(daily.get((c, d0), 0) for c in SHOPS) for d0 in last28) / len(last28)) \
    if last28 else 0

pace = {
    'need_year_sales': round(need_year_sales),
    'need_todate': round(need_todate),
    'actual_todate': round(ytd_sales),
    'gap': round(pace_gap),
    'on_track': pace_gap >= 0,
    'rest_days': rest_days,
    'need_per_day': round(need_per_day),
    'recent_per_day': round(recent_per_day),
    'per_day_gap': round(recent_per_day - need_per_day),
    'effective_rate': round(eff, 4),
    'progress': round(ytd_sales / need_year_sales, 4) if need_year_sales else 0,
    'frac_elapsed': round(frac, 4),
}

# ── 10. 前日からの動き ───────────────────────────────────────
# 毎回の計算結果を .cache/history.json に貯めて、前回（前日）との差を出す。
HIST = os.path.join(ROOT, '.cache', 'history.json')
try:
    hist = json.load(open(HIST))
except Exception:
    hist = []

snap = {
    'date': TODAY.isoformat(),
    'umapro': round(umapro),
    'hq': round(year_hq),
    'year_sales': round(year_sales),
    'pace_gap': round(pace_gap),
    'ytd_sales': round(ytd_sales),
    'month_forecast': round(sum(m['sales_forecast'] for m in months_out if m['ym'] == CUR_YM)),
}
prev = next((h for h in sorted(hist, key=lambda x: x['date'], reverse=True)
             if h['date'] < snap['date']), None)


def diff(k):
    return (snap[k] - prev[k]) if prev and k in prev else None


delta = {
    'since': prev['date'] if prev else None,
    'umapro': diff('umapro'), 'hq': diff('hq'), 'year_sales': diff('year_sales'),
    'pace_gap': diff('pace_gap'), 'month_forecast': diff('month_forecast'),
    'ytd_sales': diff('ytd_sales'),
}

hist = [h for h in hist if h['date'] != snap['date']] + [snap]
hist.sort(key=lambda x: x['date'])
json.dump(hist[-400:], open(HIST, 'w'), ensure_ascii=False)

# 直近の年間着地の推移（グラフ用）
year_trend = [{'date': h['date'], 'umapro': h['umapro']} for h in hist[-30:]]

cur = next(m for m in months_out if m['ym'] == CUR_YM)
prev_ym = (TODAY.replace(day=1) - dt.timedelta(days=1)).strftime('%Y-%m')
prev = next((m for m in months_out if m['ym'] == prev_ym), None)

# データ源ごとの新しさ（なんばやMPSが古いままだと気づけるように）
blayn_last = max((r['date'] for r in RAW.get('blayn', [])), default=None)
dinii_last = max((r['date'] for r in RAW.get('dinii', [])), default=None)
mps_last = max((r['ym'] for r in RAW.get('mps', [])), default=None)
sources = [
    {'name': 'ダイニー（11店）', 'last': dinii_last,
     'stale': not dinii_last or dinii_last < yd},
    {'name': 'blayn（なんば）', 'last': blayn_last,
     'stale': not blayn_last or blayn_last < yd},
    {'name': 'MPS（発注請求）', 'last': mps_last,
     'stale': not mps_last or mps_last < (TODAY.replace(day=1) - dt.timedelta(days=1)).strftime('%Y-%m')},
]

payload = {
    'sources': sources,
    'generatedAt': dt.datetime.now().isoformat(timespec='seconds'),
    'today': TODAY.isoformat(), 'yesterday': yd,
    'yesterdayDow': WD[YESTERDAY.weekday()],
    'yesterdayTag': day_tag(YESTERDAY),
    'year': YEAR,
    'yesterday_total': round(yday_total),
    'yesterday_excl': round(yday_excl),
    'yesterday_people': yday_people,
    'yesterday_groups': yday_groups,
    'yesterday_per_person': round(yday_excl / yday_people) if yday_people else None,
    'yesterday_per_group': round(yday_excl / yday_groups) if yday_groups else None,
    'yesterday_open_shops': yday_open,
    'shop_count': len(SHOPS),
    'yesterday_expected': round(yday_exp),
    'yesterday_shops': yday_shops,
    'trend': trend,
    'month': {
        'ym': CUR_YM,
        'actual': cur['sales_actual'], 'forecast': cur['sales_forecast'],
        'hq': cur['hq'], 'prev': prev['sales_forecast'] if prev else None,
        'days_done': (YESTERDAY.day if YESTERDAY.month == TODAY.month else 0),
        'days_in_month': calendar.monthrange(TODAY.year, TODAY.month)[1],
    },
    'year_view': {
        'sales': round(year_sales), 'hq': round(year_hq),
        'royalty': round(year_royalty), 'mps': round(year_mps),
        'umacha': UMACHA, 'umapro': round(umapro), 'target': TARGET,
        'ytd_sales': round(ytd_sales), 'ytd_hq': round(ytd_hq),
    },
    'pace': pace,
    'delta': delta,
    'year_trend': year_trend,
    'months': months_out,
    'shops': {c: SHOPS[c] for c in SHOPS},
    'detail': {
        'mps_ratio': {c: round(mps_ratio.get(c, GLOBAL_MPS), 4) for c in SHOPS if c not in MPS_EXCLUDE},
        'mps_exclude': sorted(MPS_EXCLUDE),
        'season': {str(m): round(season[m], 4) for m in range(1, 13)},
        'level': {c: round(level[c]) for c in SHOPS},
        'take_rate': {c: take_rate(c, CUR_YM) for c in SHOPS},
        'adjustments': ADJ,
        'hike': CFG['hike'],
        'mps_months': [{'ym': ym, 'internal': mps_all[ym]} for ym in sorted(mps_all)],
    },
}

os.makedirs(os.path.join(ROOT, '.cache'), exist_ok=True)
json.dump(payload, open(os.path.join(ROOT, '.cache', 'payload.json'), 'w'), ensure_ascii=False)


def man(x):
    return f'{round(x / 10000):,}万'


print(f"前日 {yd}({WD[YESTERDAY.weekday()]}) 全店 {man(yday_total)}　平常比 "
      f"{(yday_total / yday_exp * 100) if yday_exp else 0:.0f}%")
print(f"今月 {CUR_YM} 実績 {man(cur['sales_actual'])} → 着地 {man(cur['sales_forecast'])}")
print(f"{YEAR}年 全店売上 {man(year_sales)} / 本部 {man(year_hq)} / うまプロ {man(umapro)}"
      f"（目標 {man(TARGET)}・達成率 {umapro / TARGET * 100:.0f}%）")
print(f"ペース 必要な年間全店売上 {man(need_year_sales)} / 今日までに必要 {man(need_todate)} / "
      f"実績 {man(ytd_sales)} → {'先行' if pace_gap >= 0 else '遅れ'} {man(abs(pace_gap))}")
print(f"残り{rest_days}日 1日あたり必要 {man(need_per_day)} / 直近28日平均 {man(recent_per_day)}")
if delta['umapro'] is not None:
    sign = '+' if delta['umapro'] >= 0 else '−'
    print(f"前日({delta['since']})から 年間着地 {sign}{man(abs(delta['umapro']))} / "
          f"ペース {'+' if delta['pace_gap'] >= 0 else '−'}{man(abs(delta['pace_gap']))}")
else:
    print("前日比: 明日の実行から出ます（今日が1回目）")
