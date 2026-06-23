import React, { useState, useEffect, useCallback } from 'react';

// ---------- Date helpers ----------
const pad = (n) => String(n).padStart(2, '0');
const fmt = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const todayObj = new Date();
const TODAY_KEY = fmt(todayObj.getFullYear(), todayObj.getMonth(), todayObj.getDate());

const MONTH_NAMES = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const WEEKDAYS_MON_START = ['月', '火', '水', '木', '金', '土', '日'];

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

// ---------- URL-based device default kid ----------
// Reads ?kid=みの (query) or #kid=みの (hash) so each device/home-screen shortcut
// can default to a specific kid without affecting the shared data.
function getKidParamFromUrl() {
  try {
    const search = new URLSearchParams(window.location.search);
    const fromQuery = search.get('kid');
    if (fromQuery) return fromQuery;
    const hash = window.location.hash || '';
    const match = hash.match(/kid=([^&]+)/);
    if (match) return decodeURIComponent(match[1]);
  } catch (e) {
    // ignore — fall back to default selection
  }
  return null;
}

// ---------- Stamp calculation ----------
// activities shape per day:
// { drillDramaHomework: bool, commonStudy: bool, commonHours: number (1.5 step, 1.5-9), commonDrama: bool,
//   jukuStudy: bool, jukuHours: number (1-9), jukuDrama: bool }
// Note: drillDramaHomework, commonDrama, jukuDrama all represent "did drum today" — only one can be true.
function calcStampsForDay(a) {
  if (!a) return 0;
  let stamps = 0;
  if (a.drillDramaHomework) stamps += 1;
  if (a.commonStudy) {
    const hours = a.commonHours || 1.5;
    const baseStamps = Math.round(hours / 1.5);
    stamps += baseStamps + (a.commonDrama ? 1 : 0);
  }
  if (a.jukuStudy && a.jukuHours > 0) {
    stamps += a.jukuHours + (a.jukuDrama ? 1 : 0);
  }
  return stamps;
}

function emptyActivity() {
  return {
    drillDramaHomework: false,
    commonStudy: false,
    commonHours: 0,
    commonDrama: false,
    jukuStudy: false,
    jukuHours: 0,
    jukuDrama: false,
  };
}

// ---------- Storage helpers ----------
const STORAGE_KEY = 'study-tracker-data-v2';

function defaultData() {
  return {
    kids: [], // [{ id, name }]
    records: {}, // records[kidId][dateKey] = activity
    settlements: {}, // settlements[kidId] = { lastSettledDate: dateKey | null, history: [{ date, yen }] }
  };
}

async function loadDataOnce() {
  const res = await window.storage.get(STORAGE_KEY, true);
  if (res && res.value) {
    const parsed = JSON.parse(res.value);
    return { ...defaultData(), ...parsed };
  }
  return defaultData();
}

async function loadData() {
  try {
    const data = await loadDataOnce();
    return { ok: true, data };
  } catch (e) {
    // First attempt failed — could be "key not found yet" or a transient error. Retry once.
    try {
      const data = await loadDataOnce();
      return { ok: true, data };
    } catch (e2) {
      // Still failing — proceed with empty data rather than blocking the user with an error screen.
      // If the user already has kids set up, this just means the setup screen may flash briefly;
      // a normal reload will pick up the real data once storage responds.
      return { ok: true, data: defaultData() };
    }
  }
}

async function saveData(data) {
  try {
    await window.storage.set(STORAGE_KEY, JSON.stringify(data), true);
    return true;
  } catch (e) {
    console.error('Save failed', e);
    return false;
  }
}

// ---------- Weekly streak bonus calc ----------
function calcWeeklyBonuses(kidRecords, uptoDateKey) {
  const keys = Object.keys(kidRecords).sort();
  if (keys.length === 0) return 0;
  const start = new Date(keys[0]);
  const end = new Date(uptoDateKey);
  let streak = 0;
  let bonusCount = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = fmt(d.getFullYear(), d.getMonth(), d.getDate());
    const stamps = calcStampsForDay(kidRecords[key]);
    if (stamps > 0) {
      streak += 1;
      if (streak === 7) {
        bonusCount += 1;
        streak = 0;
      }
    } else {
      streak = 0;
    }
  }
  return bonusCount;
}

// ---------- Monthly bonus calc ----------
function calcMonthlyBonus(kidRecords, year, month) {
  const totalDays = daysInMonth(year, month);
  const now = new Date();
  const isCurrentMonth = now.getFullYear() === year && now.getMonth() === month;
  const lastDay = isCurrentMonth ? now.getDate() : totalDays;
  let restDays = 0;
  for (let d = 1; d <= lastDay; d++) {
    const key = fmt(year, month, d);
    const stamps = calcStampsForDay(kidRecords[key]);
    if (stamps === 0) restDays += 1;
  }
  let bonus = 0;
  if (restDays === 0) bonus = 300;
  else if (restDays === 1) bonus = 200;
  else if (restDays === 2) bonus = 100;
  else bonus = 0;
  return { restDays, bonus, isComplete: !isCurrentMonth, daysElapsed: lastDay, totalDays };
}

// ---------- Unsettled yen calculation ----------
// Everything strictly after lastSettledDate (or everything, if null) counts as unsettled.
// Includes stamp yen + weekly bonus yen, computed day by day up to today.
function calcUnsettledYen(kidRecords, lastSettledDate) {
  const keys = Object.keys(kidRecords).sort();
  if (keys.length === 0) return 0;
  const start = new Date(keys[0]);
  const end = new Date(TODAY_KEY);
  let streak = 0;
  let totalYen = 0;
  const afterSettled = (key) => !lastSettledDate || key > lastSettledDate;

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = fmt(d.getFullYear(), d.getMonth(), d.getDate());
    const stamps = calcStampsForDay(kidRecords[key]);
    if (stamps > 0) {
      streak += 1;
      if (afterSettled(key)) totalYen += stamps * 50;
      if (streak === 7) {
        if (afterSettled(key)) totalYen += 50;
        streak = 0;
      }
    } else {
      streak = 0;
    }
  }
  return totalYen;
}

// ---------- Main Component ----------
export default function StudyTracker() {
  const [loading, setLoading] = useState(true);
  const [kids, setKids] = useState([]);
  const [records, setRecords] = useState({});
  const [settlements, setSettlements] = useState({});
  const [activeKidId, setActiveKidId] = useState(null);
  const [viewYear, setViewYear] = useState(todayObj.getFullYear());
  const [viewMonth, setViewMonth] = useState(todayObj.getMonth());
  const [selectedDate, setSelectedDate] = useState(null);
  const [saving, setSaving] = useState(false);
  const [stampAnim, setStampAnim] = useState(null);
  const [error, setError] = useState(null);
  const [setupNames, setSetupNames] = useState(['', '']);
  const [showSettleConfirm, setShowSettleConfirm] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showExportImport, setShowExportImport] = useState(false);

  useEffect(() => {
    (async () => {
      const result = await loadData();
      const data = result.data;
      setKids(data.kids || []);
      setRecords(data.records || {});
      setSettlements(data.settlements || {});
      if (data.kids && data.kids.length > 0) {
        const kidParam = getKidParamFromUrl();
        const matched = kidParam ? data.kids.find((k) => k.name === kidParam) : null;
        setActiveKidId(matched ? matched.id : data.kids[0].id);
      }
      setLoading(false);
    })();
  }, []);

  const persist = useCallback(async (newState) => {
    setSaving(true);
    const ok = await saveData(newState);
    if (!ok) setError('保存に失敗しました。もう一度お試しください。');
    else setError(null);
    setSaving(false);
  }, []);

  const finishSetup = () => {
    const names = setupNames.map((n) => n.trim()).filter(Boolean);
    if (names.length === 0) return;
    const newKids = names.map((name, i) => ({ id: `kid_${Date.now()}_${i}`, name }));
    const newRecords = {};
    const newSettlements = {};
    newKids.forEach((k) => {
      newRecords[k.id] = {};
      newSettlements[k.id] = { lastSettledDate: null, history: [] };
    });
    setKids(newKids);
    setRecords(newRecords);
    setSettlements(newSettlements);
    setActiveKidId(newKids[0].id);
    persist({ kids: newKids, records: newRecords, settlements: newSettlements });
  };

  const updateDay = (kidId, dateKey, activity) => {
    const newRecords = { ...records, [kidId]: { ...(records[kidId] || {}), [dateKey]: activity } };
    setRecords(newRecords);
    persist({ kids, records: newRecords, settlements });
    setStampAnim(`${kidId}_${dateKey}`);
    setTimeout(() => setStampAnim(null), 600);
  };

  const deleteDay = (kidId, dateKey) => {
    const kidRecords = { ...(records[kidId] || {}) };
    delete kidRecords[dateKey];
    const newRecords = { ...records, [kidId]: kidRecords };
    setRecords(newRecords);
    persist({ kids, records: newRecords, settlements });
  };

  const settleKid = (kidId) => {
    const kidRecords = records[kidId] || {};
    const prevSettled = (settlements[kidId] && settlements[kidId].lastSettledDate) || null;
    const yen = calcUnsettledYen(kidRecords, prevSettled);
    const newHistory = [
      ...((settlements[kidId] && settlements[kidId].history) || []),
      { date: TODAY_KEY, yen },
    ];
    const newSettlements = {
      ...settlements,
      [kidId]: { lastSettledDate: TODAY_KEY, history: newHistory },
    };
    setSettlements(newSettlements);
    persist({ kids, records, settlements: newSettlements });
    setShowSettleConfirm(false);
  };

  const resetAllRecords = () => {
    const newRecords = {};
    const newSettlements = {};
    kids.forEach((k) => {
      newRecords[k.id] = {};
      newSettlements[k.id] = { lastSettledDate: null, history: [] };
    });
    setRecords(newRecords);
    setSettlements(newSettlements);
    persist({ kids, records: newRecords, settlements: newSettlements });
    setShowResetConfirm(false);
  };

  const goPrevMonth = () => {
    if (viewMonth === 0) { setViewYear(viewYear - 1); setViewMonth(11); }
    else setViewMonth(viewMonth - 1);
  };
  const goNextMonth = () => {
    if (viewMonth === 11) { setViewYear(viewYear + 1); setViewMonth(0); }
    else setViewMonth(viewMonth + 1);
  };

  if (loading) {
    return (
      <div style={styles.loadingWrap}>
        <div style={styles.loadingStamp}>📋</div>
        <div style={styles.loadingText}>読み込み中…</div>
      </div>
    );
  }

  // ---------- Setup screen ----------
  if (kids.length === 0) {
    return (
      <div style={styles.page}>
        <style>{globalCss}</style>
        <div style={styles.setupCard}>
          <div style={styles.setupTitleRow}>
            <span style={styles.titleStamp}>🎫</span>
            <h1 style={styles.title}>がんばり スタンプカード</h1>
          </div>
          <p style={styles.setupDesc}>お子さんの名前を入力してください（2人まで）</p>
          {[0, 1].map((i) => (
            <input
              key={i}
              style={styles.setupInput}
              placeholder={i === 0 ? '例：さくら' : '例：もうた（空欄でも可）'}
              value={setupNames[i]}
              onChange={(e) => {
                const next = [...setupNames];
                next[i] = e.target.value;
                setSetupNames(next);
              }}
            />
          ))}
          <button style={styles.saveBtn} onClick={finishSetup}>はじめる</button>
        </div>
      </div>
    );
  }

  const activeKid = kids.find((k) => k.id === activeKidId) || kids[0];
  const activeKidRecords = records[activeKid.id] || {};
  const activeSettlement = settlements[activeKid.id] || { lastSettledDate: null, history: [] };
  const activeKidIndex = kids.findIndex((k) => k.id === activeKid.id);
  const activeKidColor = kidColor(activeKidIndex < 0 ? 0 : activeKidIndex);

  const totalDays = daysInMonth(viewYear, viewMonth);
  const rawFirstWeekday = new Date(viewYear, viewMonth, 1).getDay(); // 0=Sun..6=Sat
  const firstWeekday = (rawFirstWeekday + 6) % 7; // shift so 0=Mon..6=Sun
  const weeklyBonusCount = calcWeeklyBonuses(
    activeKidRecords,
    fmt(viewYear, viewMonth, Math.min(totalDays, viewYear === todayObj.getFullYear() && viewMonth === todayObj.getMonth() ? todayObj.getDate() : totalDays))
  );
  const monthly = calcMonthlyBonus(activeKidRecords, viewYear, viewMonth);

  let monthStampTotal = 0;
  for (let d = 1; d <= totalDays; d++) {
    monthStampTotal += calcStampsForDay(activeKidRecords[fmt(viewYear, viewMonth, d)]);
  }
  const monthStampYen = monthStampTotal * 50;
  const unsettledYen = calcUnsettledYen(activeKidRecords, activeSettlement.lastSettledDate);

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= totalDays; d++) cells.push(d);

  return (
    <div style={styles.page}>
      <style>{globalCss}</style>

      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div style={styles.titleRow}>
            <span style={styles.titleStamp}>🎫</span>
            <h1 style={styles.title}>がんばり スタンプカード</h1>
          </div>
          {saving && <span style={styles.savingTag}>保存中…</span>}
        </div>
      </header>

      {error && <div style={styles.errorBanner}>{error}</div>}


      {kids.length > 1 && (
        <div style={styles.kidSwitchRow}>
          {kids.map((k, kidIdx) => {
            const color = kidColor(kidIdx);
            const isActive = k.id === activeKid.id;
            return (
              <button
                key={k.id}
                onClick={() => setActiveKidId(k.id)}
                style={{
                  ...styles.kidSwitchBtn,
                  ...(isActive
                    ? { background: color.main, color: '#fff', border: `1px solid ${color.main}` }
                    : { background: color.soft, color: color.main, border: `1px solid ${color.main}55` }),
                }}
              >
                <span style={styles.kidSwitchEmoji}>{kidIdx === 0 ? '🔴' : '🔵'}</span> {k.name}
              </button>
            );
          })}
        </div>
      )}

      <div style={styles.summaryRow}>
        <SummaryCard label="今月のスタンプ" value={`${monthStampTotal} 個`} accent="#E85D3D" icon="🔖" />
        <SummaryCard label="今月のポイント" value={`¥${monthStampYen.toLocaleString()}`} accent="#2C5F7C" icon="🪙" />
        <SummaryCard label="週間ボーナス" value={`+¥${weeklyBonusCount * 50} (${weeklyBonusCount}回)`} accent="#D4A647" icon="🔥" />
      </div>

      <SettlementCard
        unsettledYen={unsettledYen}
        history={activeSettlement.history}
        onSettle={() => setShowSettleConfirm(true)}
      />

      <MonthlyBonusCard monthly={monthly} monthName={MONTH_NAMES[viewMonth]} />

      <div style={styles.calendarCard}>
        <div style={styles.monthNav}>
          <button style={styles.navBtn} onClick={goPrevMonth} aria-label="前の月">‹</button>
          <div style={styles.monthLabel}>{viewYear}年 {MONTH_NAMES[viewMonth]}</div>
          <button style={styles.navBtn} onClick={goNextMonth} aria-label="次の月">›</button>
        </div>

        <div style={styles.weekdayRow}>
          {WEEKDAYS_MON_START.map((w, i) => (
            <div key={w} style={{ ...styles.weekdayCell, color: i === 6 ? '#C0504D' : i === 5 ? '#2C5F7C' : '#8a8378' }}>{w}</div>
          ))}
        </div>

        <div style={styles.grid}>
          {cells.map((d, idx) => {
            if (d === null) return <div key={`empty-${idx}`} style={styles.emptyCell} />;
            const dateKey = fmt(viewYear, viewMonth, d);
            const isToday = dateKey === TODAY_KEY;
            const isFuture = new Date(dateKey) > new Date(TODAY_KEY);
            const isActiveKidSettled = activeSettlement.lastSettledDate && dateKey <= activeSettlement.lastSettledDate;
            return (
              <button
                key={dateKey}
                onClick={() => setSelectedDate(dateKey)}
                style={{
                  ...styles.dayCell,
                  ...(isToday ? styles.dayCellToday : {}),
                  ...(isFuture ? styles.dayCellFuture : {}),
                  ...(isActiveKidSettled ? styles.dayCellLocked : {}),
                }}
              >
                {isActiveKidSettled && <span style={styles.lockIcon}>🔒</span>}
                <span style={styles.dayNum}>{d}</span>
                <div style={styles.dayKidStampsWrap}>
                  {kids.map((k, kidIdx) => {
                    const kr = records[k.id] || {};
                    const st = settlements[k.id] || { lastSettledDate: null };
                    const stamps = calcStampsForDay(kr[dateKey]);
                    if (stamps === 0) return null;
                    const isSettled = st.lastSettledDate && dateKey <= st.lastSettledDate;
                    const isOtherKid = k.id !== activeKid.id;
                    const animKey = `${k.id}_${dateKey}`;
                    const color = kidColor(kidIdx);
                    // 相手の子は薄く（22=約13%透明度）、精算済みはさらに薄く（15=約8%）
                    const bg = isSettled
                      ? `${color.main}22`
                      : isOtherKid
                        ? `${color.main}55`
                        : color.main;
                    const fg = (isSettled || isOtherKid) ? color.main : '#fff';
                    return (
                      <span
                        key={k.id}
                        style={{
                          ...styles.miniStampBadge,
                          background: bg,
                          color: fg,
                          transform: stampAnim === animKey ? 'scale(1.3)' : 'scale(1)',
                        }}
                        title={k.name}
                      >
                        {stamps}
                      </span>
                    );
                  })}
                </div>
              </button>
            );
          })}
        </div>
        <div style={styles.calendarLegendNote}>
          {kids.map((k, i) => (
            <span key={k.id} style={{ ...styles.legendKidTag, color: kidColor(i).main }}>
              ● {k.name}
            </span>
          ))}
          　/　うすい色は精算済み、濃い色は未精算
        </div>
      </div>

      <div style={styles.legend}>
        <div style={styles.legendTitle}>スタンプのルール</div>
        <ul style={styles.legendList}>
          <li>ドリル4ページ＋ドラム＋宿題 → 🔖×1</li>
          <li>コモンで自習：1.5時間ごとに🔖×1（最大9h、＋ドラムで+🔖1）</li>
          <li>塾で自習：1時間ごとに🔖×1（最大8h、＋ドラムで+🔖1）</li>
          <li>「ドリル・ドラム・宿題」と「塾」は同じ日に両方OK</li>
          <li>ただしドラムは1日1回。3つのうちどれか1つだけ選べます</li>
          <li>🔖1個 ＝ 50円</li>
          <li>7日連続で🔖あり → +50円</li>
          <li>1ヶ月お休み0〜2日 → 300〜100円ボーナス（3日以上で0円）</li>
        </ul>
      </div>

      <button style={styles.resetLinkBtn} onClick={() => setShowResetConfirm(true)}>
        すべての記録をリセットする
      </button>

      <button style={styles.exportImportBtn} onClick={() => setShowExportImport(true)}>
        📦 データのエクスポート / インポート
      </button>

      {selectedDate && (
        <DayEditorModal
          dateKey={selectedDate}
          kidName={activeKid.name}
          kidColor={activeKidColor}
          activity={activeKidRecords[selectedDate] || emptyActivity()}
          isLocked={Boolean(activeSettlement.lastSettledDate && selectedDate <= activeSettlement.lastSettledDate)}
          onClose={() => setSelectedDate(null)}
          onSave={(activity) => {
            updateDay(activeKid.id, selectedDate, activity);
            setSelectedDate(null);
          }}
          onDelete={() => {
            deleteDay(activeKid.id, selectedDate);
            setSelectedDate(null);
          }}
        />
      )}

      {showSettleConfirm && (
        <SettleConfirmModal
          kidName={activeKid.name}
          yen={unsettledYen}
          onCancel={() => setShowSettleConfirm(false)}
          onConfirm={() => settleKid(activeKid.id)}
        />
      )}

      {showResetConfirm && (
        <ResetConfirmModal
          onCancel={() => setShowResetConfirm(false)}
          onConfirm={resetAllRecords}
        />
      )}

      {showExportImport && (
        <ExportImportModal
          data={{ kids, records, settlements }}
          onClose={() => setShowExportImport(false)}
          onImport={(imported) => {
            setKids(imported.kids || []);
            setRecords(imported.records || {});
            setSettlements(imported.settlements || {});
            if (imported.kids && imported.kids.length > 0) {
              setActiveKidId(imported.kids[0].id);
            }
            persist({ kids: imported.kids, records: imported.records, settlements: imported.settlements });
            setShowExportImport(false);
          }}
        />
      )}
    </div>
  );
}

// ---------- Subcomponents ----------
function SummaryCard({ label, value, accent, icon }) {
  return (
    <div style={{ ...styles.summaryCard, borderTopColor: accent }}>
      <div style={styles.summaryIcon}>{icon}</div>
      <div style={styles.summaryLabel}>{label}</div>
      <div style={{ ...styles.summaryValue, color: accent }}>{value}</div>
    </div>
  );
}

function SettlementCard({ unsettledYen, history, onSettle }) {
  const lastSettlement = history && history.length > 0 ? history[history.length - 1] : null;
  return (
    <div style={styles.settleCard}>
      <div style={styles.settleLeft}>
        <div style={styles.settleLabel}>未精算ポイント</div>
        <div style={styles.settleYen}>¥{unsettledYen.toLocaleString()}</div>
        {lastSettlement && (
          <div style={styles.settleLastNote}>
            前回精算: {lastSettlement.date}（¥{lastSettlement.yen.toLocaleString()}）
          </div>
        )}
      </div>
      <button
        style={{ ...styles.settleBtn, ...(unsettledYen === 0 ? styles.settleBtnDisabled : {}) }}
        onClick={onSettle}
        disabled={unsettledYen === 0}
      >
        精算する
      </button>
    </div>
  );
}

const SETTLE_PASSWORD = '0999';

function SettleConfirmModal({ kidName, yen, onCancel, onConfirm }) {
  const [pw, setPw] = useState('');
  const [wrongShake, setWrongShake] = useState(false);
  const isCorrect = pw === SETTLE_PASSWORD;

  const handleConfirmClick = () => {
    if (isCorrect) {
      onConfirm();
    } else {
      setWrongShake(true);
      setTimeout(() => setWrongShake(false), 400);
    }
  };

  return (
    <div style={styles.confirmOverlay} onClick={onCancel}>
      <div style={styles.confirmCard} onClick={(e) => e.stopPropagation()}>
        <div style={styles.confirmTitle}>{kidName}さんの精算</div>
        <div style={styles.confirmBody}>
          未精算の ¥{yen.toLocaleString()} をすべて精算済みにします。よろしいですか？
        </div>
        <div style={styles.pwLabel}>おうちの人のパスワード</div>
        <input
          type="password"
          inputMode="numeric"
          maxLength={4}
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="••••"
          style={{
            ...styles.pwInput,
            ...(wrongShake ? styles.pwInputWrong : {}),
          }}
        />
        <div style={styles.confirmBtnRow}>
          <button style={styles.confirmCancelBtn} onClick={onCancel}>キャンセル</button>
          <button
            style={{ ...styles.confirmOkBtn, ...(isCorrect ? {} : styles.confirmOkBtnDisabled) }}
            onClick={handleConfirmClick}
          >
            精算する
          </button>
        </div>
      </div>
    </div>
  );
}

function ResetConfirmModal({ onCancel, onConfirm }) {
  const [pw, setPw] = useState('');
  const [wrongShake, setWrongShake] = useState(false);
  const isCorrect = pw === SETTLE_PASSWORD;

  const handleConfirmClick = () => {
    if (isCorrect) {
      onConfirm();
    } else {
      setWrongShake(true);
      setTimeout(() => setWrongShake(false), 400);
    }
  };

  return (
    <div style={styles.confirmOverlay} onClick={onCancel}>
      <div style={styles.confirmCard} onClick={(e) => e.stopPropagation()}>
        <div style={styles.confirmTitle}>すべての記録をリセット</div>
        <div style={styles.confirmBody}>
          全員分の毎日の記録と精算履歴をすべて消します。お子さんの名前はそのまま残ります。この操作は元に戻せません。よろしいですか？
        </div>
        <div style={styles.pwLabel}>おうちの人のパスワード</div>
        <input
          type="password"
          inputMode="numeric"
          maxLength={4}
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="••••"
          style={{
            ...styles.pwInput,
            ...(wrongShake ? styles.pwInputWrong : {}),
          }}
        />
        <div style={styles.confirmBtnRow}>
          <button style={styles.confirmCancelBtn} onClick={onCancel}>キャンセル</button>
          <button
            style={{ ...styles.deleteOkBtn, ...(isCorrect ? {} : styles.confirmOkBtnDisabled) }}
            onClick={handleConfirmClick}
          >
            リセットする
          </button>
        </div>
      </div>
    </div>
  );
}

function ExportImportModal({ data, onClose, onImport }) {
  const [mode, setMode] = useState('export'); // 'export' | 'import'
  const [importText, setImportText] = useState('');
  const [copied, setCopied] = useState(false);
  const [importError, setImportError] = useState('');

  const exportText = JSON.stringify(data, null, 2);

  const handleCopy = () => {
    try {
      navigator.clipboard.writeText(exportText).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    } catch (e) {
      // fallback: select textarea
    }
  };

  const handleImport = () => {
    try {
      const parsed = JSON.parse(importText.trim());
      if (!parsed.kids || !Array.isArray(parsed.kids)) {
        setImportError('データの形式が正しくありません。エクスポートしたテキストをそのまま貼り付けてください。');
        return;
      }
      onImport(parsed);
    } catch (e) {
      setImportError('読み込みに失敗しました。テキストを正しく貼り付けてください。');
    }
  };

  return (
    <div style={styles.confirmOverlay} onClick={onClose}>
      <div style={{ ...styles.confirmCard, maxHeight: '80vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <div style={styles.confirmTitle}>📦 データのエクスポート / インポート</div>

        <div style={styles.exportTabRow}>
          <button
            style={{ ...styles.exportTab, ...(mode === 'export' ? styles.exportTabActive : {}) }}
            onClick={() => setMode('export')}
          >コピーして保存</button>
          <button
            style={{ ...styles.exportTab, ...(mode === 'import' ? styles.exportTabActive : {}) }}
            onClick={() => setMode('import')}
          >貼り付けて復元</button>
        </div>

        {mode === 'export' ? (
          <>
            <div style={styles.exportDesc}>
              下のテキストを全部コピーして、メモアプリやメールに保存しておいてください。新しいURLに移った時に「貼り付けて復元」で元に戻せます。
            </div>
            <textarea
              readOnly
              value={exportText}
              style={styles.exportTextarea}
              onFocus={(e) => e.target.select()}
            />
            <button style={styles.copyBtn} onClick={handleCopy}>
              {copied ? '✓ コピーしました！' : 'テキストをコピーする'}
            </button>
          </>
        ) : (
          <>
            <div style={styles.exportDesc}>
              保存しておいたテキストを下に貼り付けて「復元する」を押してください。現在のデータは上書きされます。
            </div>
            <textarea
              value={importText}
              onChange={(e) => { setImportText(e.target.value); setImportError(''); }}
              placeholder="ここにテキストを貼り付けてください..."
              style={styles.exportTextarea}
            />
            {importError && <div style={styles.importError}>{importError}</div>}
            <button
              style={{ ...styles.saveBtn, marginTop: '8px' }}
              onClick={handleImport}
            >
              復元する
            </button>
          </>
        )}

        <button style={styles.resetLinkBtn} onClick={onClose}>閉じる</button>
      </div>
    </div>
  );
}

function MonthlyBonusCard({ monthly, monthName }) {
  const { restDays, bonus, isComplete, daysElapsed, totalDays } = monthly;
  const pct = Math.min(100, Math.round((daysElapsed / totalDays) * 100));
  return (
    <div style={styles.monthlyCard}>
      <div style={styles.monthlyHeader}>
        <span style={styles.monthlyTitle}>{monthName}の継続ボーナス</span>
        <span style={styles.monthlyBadge}>{isComplete ? '確定' : '進行中'}</span>
      </div>
      <div style={styles.monthlyBarTrack}>
        <div style={{ ...styles.monthlyBarFill, width: `${pct}%` }} />
      </div>
      <div style={styles.monthlyFooter}>
        <span>お休み: {restDays}日</span>
        <span style={styles.monthlyYen}>+¥{bonus}</span>
      </div>
    </div>
  );
}

const DELETE_PASSWORD = '0999';

function DayEditorModal({ dateKey, kidName, kidColor, activity, isLocked, onClose, onSave, onDelete }) {
  const [a, setA] = useState({ ...activity });
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletePw, setDeletePw] = useState('');
  const [deleteWrongShake, setDeleteWrongShake] = useState(false);
  const stamps = calcStampsForDay(a);
  const [y, m, d] = dateKey.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d);
  const label = `${y}年${m}月${d}日（${WEEKDAYS[dateObj.getDay()]}）`;

  const guard = (fn) => (...args) => {
    if (isLocked) return;
    fn(...args);
  };

  const toggle = guard((key) => setA((prev) => ({ ...prev, [key]: !prev[key] })));
  const setJukuHours = guard((val) => setA((prev) => ({ ...prev, jukuHours: val })));
  const setCommonHours = guard((val) => setA((prev) => ({ ...prev, commonHours: val })));
  const toggleJukuStudy = guard(() => setA((prev) => ({
    ...prev,
    jukuStudy: !prev.jukuStudy,
    jukuHours: !prev.jukuStudy ? (prev.jukuHours || 1) : prev.jukuHours,
  })));
  const toggleCommonStudy = guard(() => setA((prev) => ({
    ...prev,
    commonStudy: !prev.commonStudy,
    commonHours: !prev.commonStudy ? (prev.commonHours || 1.5) : prev.commonHours,
  })));

  // drillDramaHomework, commonDrama, and jukuDrama all represent "drum today" — only one can be on
  const toggleDrillDramaHomework = guard(() => setA((prev) => ({
    ...prev,
    drillDramaHomework: !prev.drillDramaHomework,
    commonDrama: !prev.drillDramaHomework ? false : prev.commonDrama,
    jukuDrama: !prev.drillDramaHomework ? false : prev.jukuDrama,
  })));
  const toggleCommonDrama = guard(() => setA((prev) => ({
    ...prev,
    commonDrama: !prev.commonDrama,
    drillDramaHomework: !prev.commonDrama ? false : prev.drillDramaHomework,
    jukuDrama: !prev.commonDrama ? false : prev.jukuDrama,
  })));
  const toggleJukuDrama = guard(() => setA((prev) => ({
    ...prev,
    jukuDrama: !prev.jukuDrama,
    drillDramaHomework: !prev.jukuDrama ? false : prev.drillDramaHomework,
    commonDrama: !prev.jukuDrama ? false : prev.commonDrama,
  })));

  const handleDeleteClick = () => {
    if (deletePw === DELETE_PASSWORD) {
      onDelete();
    } else {
      setDeleteWrongShake(true);
      setTimeout(() => setDeleteWrongShake(false), 400);
    }
  };

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalScrollArea}>
          <div style={styles.modalHeader}>
            <div>
              <div style={{ ...styles.modalKidName, color: kidColor ? kidColor.main : STAMP_RED }}>{kidName}</div>
              <div style={styles.modalDate}>{label}</div>
            </div>
            <button style={styles.closeBtn} onClick={onClose} aria-label="閉じる">✕</button>
          </div>

          {isLocked && (
            <div style={styles.lockedBanner}>🔒 この日は精算済みのため編集できません</div>
          )}

          <div style={styles.modalStampPreview}>
            <span style={styles.modalStampEmoji}>{stamps > 0 ? '🔖'.repeat(Math.min(stamps, 5)) : '—'}</span>
            <span style={styles.modalStampText}>{stamps > 0 ? `${stamps} 個（¥${stamps * 50}）` : 'まだスタンプなし'}</span>
          </div>

          <div style={{ ...styles.modalSection, ...(isLocked ? styles.modalSectionLocked : {}) }}>
            <ActivityToggle
              checked={a.drillDramaHomework}
              onChange={toggleDrillDramaHomework}
              title="ドリル・ドラム・宿題"
              desc="ドリル4ページ＋ドラム＋宿題 → 🔖1"
            />

            <div style={styles.subBlock}>
              <ActivityToggle
                checked={a.commonStudy}
                onChange={toggleCommonStudy}
                title="コモンで自習"
                desc="時間を選んでください"
              />
              {a.commonStudy && (
                <>
                  <div style={styles.hourPicker}>
                    {[1.5, 3, 4.5, 6, 7.5, 9].map((h) => (
                      <button
                        key={h}
                        onClick={() => setCommonHours(h)}
                        style={{
                          ...styles.hourBtn,
                          ...(a.commonHours === h ? styles.hourBtnActive : {}),
                        }}
                      >
                        {`${h}h`}
                      </button>
                    ))}
                  </div>
                  <div style={styles.subToggleRow}>
                    <ActivityToggle
                      checked={a.commonDrama}
                      onChange={toggleCommonDrama}
                      title="＋ドラムもやった"
                      desc={`🔖${Math.round((a.commonHours || 1.5) / 1.5) + 1} になる`}
                      compact
                    />
                  </div>
                </>
              )}
            </div>

            <div style={styles.subBlock}>
              <ActivityToggle
                checked={a.jukuStudy}
                onChange={toggleJukuStudy}
                title="塾で自習"
                desc="時間を選んでください"
              />
              {a.jukuStudy && (
                <>
                  <div style={styles.hourPicker}>
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((h) => (
                      <button
                        key={h}
                        onClick={() => setJukuHours(h)}
                        style={{
                          ...styles.hourBtn,
                          ...(a.jukuHours === h ? styles.hourBtnActive : {}),
                        }}
                      >
                        {`${h}h`}
                      </button>
                    ))}
                  </div>
                  <div style={styles.subToggleRow}>
                    <ActivityToggle
                      checked={a.jukuDrama}
                      onChange={toggleJukuDrama}
                      title="＋ドラムもやった"
                      desc={`🔖${(a.jukuHours || 1) + 1} になる`}
                      compact
                    />
                  </div>
                </>
              )}
            </div>
          </div>

          {!isLocked && (
            <button style={styles.saveBtn} onClick={() => onSave(a)}>この内容で保存する</button>
          )}

          {!showDeleteConfirm ? (
            <button style={styles.deleteLinkBtn} onClick={() => setShowDeleteConfirm(true)}>
              この日の記録を消す
            </button>
          ) : (
            <div style={styles.deleteBox}>
              <div style={styles.deleteBoxTitle}>この日の記録を削除します</div>
              <div style={styles.pwLabel}>おうちの人のパスワード</div>
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={deletePw}
                onChange={(e) => setDeletePw(e.target.value)}
                placeholder="••••"
                style={{ ...styles.pwInput, ...(deleteWrongShake ? styles.pwInputWrong : {}) }}
              />
              <div style={styles.confirmBtnRow}>
                <button style={styles.confirmCancelBtn} onClick={() => { setShowDeleteConfirm(false); setDeletePw(''); }}>
                  やめる
                </button>
                <button style={styles.deleteOkBtn} onClick={handleDeleteClick}>削除する</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ActivityToggle({ checked, onChange, title, desc, compact }) {
  return (
    <button
      onClick={onChange}
      style={{
        ...styles.toggleRow,
        ...(checked ? styles.toggleRowActive : {}),
        ...(compact ? styles.toggleRowCompact : {}),
      }}
    >
      <span style={{ ...styles.checkbox, ...(checked ? styles.checkboxActive : {}) }}>
        {checked ? '✓' : ''}
      </span>
      <span style={styles.toggleTextWrap}>
        <span style={styles.toggleTitle}>{title}</span>
        <span style={styles.toggleDesc}>{desc}</span>
      </span>
    </button>
  );
}

// ---------- Styles ----------
const globalCss = `
  * { box-sizing: border-box; }
  button { font-family: inherit; cursor: pointer; }
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    20%, 60% { transform: translateX(-6px); }
    40%, 80% { transform: translateX(6px); }
  }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }
`;

const PAPER = '#FBF6EC';
const INK = '#4A4039';
const STAMP_RED = '#E85D3D';
const INDIGO = '#2C5F7C';
const GOLD = '#D4A647';

// Per-kid color palette (cycled by index): stamp emoji is recolored via filter trick isn't reliable,
// so we use a colored badge/background behind the stamp + colored text for counts/tabs instead.
const KID_COLORS = [
  { main: '#E85D3D', soft: '#FDEFE5', name: 'red' },    // kid 1: red/orange
  { main: '#2C5F7C', soft: '#E6EEF2', name: 'indigo' },  // kid 2: indigo/blue
];
function kidColor(index) {
  return KID_COLORS[index % KID_COLORS.length];
}

const styles = {
  page: {
    minHeight: '100%',
    background: PAPER,
    backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(74,64,57,0.06) 1px, transparent 0)',
    backgroundSize: '18px 18px',
    color: INK,
    fontFamily: "'Hiragino Maru Gothic ProN', 'Yu Gothic', 'Helvetica Neue', sans-serif",
    padding: '20px 14px 40px',
  },
  loadingWrap: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    height: '300px', gap: '12px', background: PAPER,
  },
  loadingStamp: { fontSize: '40px' },
  loadingText: { color: '#8a8378', fontSize: '14px' },

  setupCard: {
    background: '#fff', borderRadius: '18px', padding: '24px 20px', maxWidth: '420px', margin: '40px auto',
    boxShadow: '0 4px 14px rgba(74,64,57,0.10)', display: 'flex', flexDirection: 'column', gap: '12px',
  },
  setupTitleRow: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' },
  setupDesc: { fontSize: '13px', color: '#8a8378', margin: '0 0 8px' },
  setupInput: {
    border: '1px solid #E0D8C5', borderRadius: '10px', padding: '12px 14px', fontSize: '14px',
    background: '#FBF6EC', color: INK,
  },

  header: { marginBottom: '16px' },
  headerInner: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  titleRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  titleStamp: { fontSize: '26px' },
  title: { fontSize: '20px', fontWeight: 800, margin: 0, letterSpacing: '0.02em' },
  savingTag: { fontSize: '11px', color: '#8a8378' },
  errorBanner: {
    background: '#FCE8E4', color: '#A1432F', padding: '10px 14px', borderRadius: '10px',
    fontSize: '13px', marginBottom: '14px', border: '1px solid #E85D3D33',
  },
  debugBanner: {
    background: '#E6EEF2', color: '#2C5F7C', padding: '8px 10px', borderRadius: '8px',
    fontSize: '10px', marginBottom: '14px', wordBreak: 'break-all',
  },

  kidSwitchRow: { display: 'flex', gap: '8px', marginBottom: '14px' },
  kidSwitchBtn: {
    flex: 1, padding: '10px 0', borderRadius: '12px',
    fontSize: '14px', fontWeight: 700,
  },
  kidSwitchEmoji: { fontSize: '10px' },

  summaryRow: { display: 'flex', gap: '10px', marginBottom: '14px' },
  summaryCard: {
    flex: 1, background: '#fff', borderRadius: '14px', padding: '12px 10px',
    borderTop: '4px solid', boxShadow: '0 2px 8px rgba(74,64,57,0.08)',
    display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'center', textAlign: 'center',
  },
  summaryIcon: { fontSize: '18px' },
  summaryLabel: { fontSize: '11px', color: '#8a8378' },
  summaryValue: { fontSize: '15px', fontWeight: 800 },

  settleCard: {
    background: '#fff', borderRadius: '14px', padding: '14px 16px', marginBottom: '14px',
    boxShadow: '0 2px 8px rgba(74,64,57,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
  },
  settleLeft: { display: 'flex', flexDirection: 'column', gap: '2px' },
  settleLabel: { fontSize: '12px', color: '#8a8378' },
  settleYen: { fontSize: '20px', fontWeight: 800, color: STAMP_RED },
  settleLastNote: { fontSize: '11px', color: '#9c948a' },
  settleBtn: {
    padding: '10px 16px', borderRadius: '12px', border: 'none', background: INDIGO, color: '#fff',
    fontWeight: 700, fontSize: '13px', whiteSpace: 'nowrap',
  },
  settleBtnDisabled: { background: '#D8CFB9', color: '#fff' },

  monthlyCard: {
    background: '#fff', borderRadius: '14px', padding: '14px 16px', marginBottom: '14px',
    boxShadow: '0 2px 8px rgba(74,64,57,0.08)',
  },
  monthlyHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' },
  monthlyTitle: { fontSize: '13px', fontWeight: 700, color: INK },
  monthlyBadge: {
    fontSize: '10px', padding: '2px 8px', borderRadius: '999px', background: `${GOLD}22`, color: '#9c7a23',
    fontWeight: 700,
  },
  monthlyBarTrack: { height: '8px', borderRadius: '999px', background: '#EFE9DB', overflow: 'hidden', marginBottom: '8px' },
  monthlyBarFill: { height: '100%', background: `linear-gradient(90deg, ${GOLD}, ${STAMP_RED})`, borderRadius: '999px', transition: 'width 0.4s ease' },
  monthlyFooter: { display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: '#8a8378' },
  monthlyYen: { fontWeight: 800, color: GOLD, fontSize: '15px' },

  calendarCard: {
    background: '#fff', borderRadius: '18px', padding: '14px', marginBottom: '16px',
    boxShadow: '0 4px 14px rgba(74,64,57,0.10)',
  },
  monthNav: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' },
  navBtn: {
    width: '32px', height: '32px', borderRadius: '50%', border: 'none', background: '#F3EEE2',
    fontSize: '18px', color: INK, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  monthLabel: { fontSize: '16px', fontWeight: 800 },
  weekdayRow: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', marginBottom: '4px' },
  weekdayCell: { textAlign: 'center', fontSize: '11px', fontWeight: 700, padding: '4px 0' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '4px' },
  emptyCell: { aspectRatio: '1' },
  dayCell: {
    aspectRatio: '1', border: 'none', borderRadius: '10px', background: '#F8F4EA',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: '2px', position: 'relative', padding: '2px',
  },
  dayCellToday: { background: '#FDEFE5', boxShadow: `inset 0 0 0 2px ${STAMP_RED}55` },
  dayCellFuture: { opacity: 0.45 },
  dayCellLocked: { cursor: 'default', background: '#DCD5C6', boxShadow: 'none' },
  lockIcon: { position: 'absolute', top: '1px', right: '2px', fontSize: '8px', opacity: 0.5 },
  dayNum: { fontSize: '11px', color: '#8a8378', fontWeight: 600 },
  dayKidStampsWrap: { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '3px', flexWrap: 'wrap', justifyContent: 'center' },
  miniStampBadge: {
    minWidth: '15px', height: '15px', borderRadius: '999px', fontSize: '9px', fontWeight: 800,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px',
    transition: 'transform 0.25s cubic-bezier(.34,1.56,.64,1)', lineHeight: 1,
  },
  calendarLegendNote: { fontSize: '10px', color: '#9c948a', textAlign: 'center', marginTop: '8px' },
  legendKidTag: { fontWeight: 700, marginRight: '4px' },

  legend: { background: '#fff', borderRadius: '14px', padding: '14px 16px', boxShadow: '0 2px 8px rgba(74,64,57,0.08)' },
  legendTitle: { fontSize: '13px', fontWeight: 800, marginBottom: '8px', color: INDIGO },
  legendList: { margin: 0, paddingLeft: '18px', fontSize: '12px', color: '#6b625a', lineHeight: 1.7 },

  // Modal
  modalOverlay: {
    position: 'fixed', inset: 0, background: 'rgba(40,32,24,0.45)', display: 'flex',
    alignItems: 'flex-start', justifyContent: 'center', zIndex: 1000, padding: 0,
  },
  confirmOverlay: {
    position: 'fixed', inset: 0, background: 'rgba(40,32,24,0.45)', display: 'flex',
    alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px',
  },
  modalCard: {
    background: PAPER, borderRadius: '0 0 24px 24px', width: '100%', maxWidth: '480px',
    maxHeight: '90vh', boxShadow: '0 8px 30px rgba(0,0,0,0.2)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  modalScrollArea: {
    overflowY: 'auto', padding: '18px 18px 24px', flex: '1 1 auto',
  },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' },
  modalKidName: { fontSize: '12px', fontWeight: 700, marginBottom: '2px' },
  modalDate: { fontSize: '16px', fontWeight: 800 },
  closeBtn: { border: 'none', background: 'transparent', fontSize: '18px', color: '#8a8378' },
  modalStampPreview: {
    background: '#fff', borderRadius: '14px', padding: '12px 14px', display: 'flex',
    alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px',
    boxShadow: '0 2px 8px rgba(74,64,57,0.08)',
  },
  modalStampEmoji: { fontSize: '20px' },
  modalStampText: { fontSize: '13px', fontWeight: 700, color: STAMP_RED },
  modalSection: { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' },
  modalSectionLocked: { opacity: 0.5, pointerEvents: 'none' },
  lockedBanner: {
    background: '#EFEAE0', color: '#8a8378', fontSize: '12px', fontWeight: 700,
    borderRadius: '10px', padding: '8px 12px', marginBottom: '12px', textAlign: 'center',
  },
  deleteLinkBtn: {
    width: '100%', padding: '10px', border: 'none', background: 'transparent',
    color: '#B0473A', fontSize: '12px', fontWeight: 700, marginTop: '10px', textDecoration: 'underline',
  },
  deleteBox: {
    background: '#FCE8E4', borderRadius: '14px', padding: '14px', marginTop: '10px',
    border: '1px solid #E85D3D33',
  },
  deleteBoxTitle: { fontSize: '13px', fontWeight: 800, color: '#A1432F', marginBottom: '10px' },
  resetLinkBtn: {
    width: '100%', padding: '12px', border: 'none', background: 'transparent',
    color: '#9c948a', fontSize: '11px', fontWeight: 600, marginTop: '4px', marginBottom: '8px',
    textDecoration: 'underline',
  },
  exportImportBtn: {
    width: '100%', padding: '12px', border: '1px solid #E0D8C5', background: '#fff',
    color: INDIGO, fontSize: '13px', fontWeight: 700, borderRadius: '12px',
    marginBottom: '20px',
  },
  exportTabRow: { display: 'flex', gap: '8px', marginBottom: '12px' },
  exportTab: {
    flex: 1, padding: '9px 0', borderRadius: '10px', border: '1px solid #E0D8C5',
    background: '#fff', fontSize: '12px', fontWeight: 700, color: '#8a8378',
  },
  exportTabActive: { background: INDIGO, color: '#fff', border: `1px solid ${INDIGO}` },
  exportDesc: { fontSize: '12px', color: '#6b625a', lineHeight: 1.6, marginBottom: '10px' },
  exportTextarea: {
    width: '100%', height: '140px', border: '1px solid #E0D8C5', borderRadius: '10px',
    padding: '10px', fontSize: '11px', background: '#FBF6EC', color: INK,
    fontFamily: 'monospace', resize: 'none', marginBottom: '10px', boxSizing: 'border-box',
  },
  copyBtn: {
    width: '100%', padding: '12px', borderRadius: '12px', border: 'none',
    background: INDIGO, color: '#fff', fontWeight: 800, fontSize: '14px',
  },
  importError: {
    fontSize: '12px', color: '#A1432F', background: '#FCE8E4', borderRadius: '8px',
    padding: '8px 10px', marginBottom: '8px',
  },
  deleteOkBtn: {
    flex: 1, padding: '12px 0', borderRadius: '12px', border: 'none', background: '#B0473A', color: '#fff',
    fontWeight: 800, fontSize: '13px',
  },
  subBlock: { background: '#F3EEE2', borderRadius: '12px', padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' },
  subToggleRow: { paddingLeft: '4px' },
  hourPicker: { display: 'flex', gap: '6px', flexWrap: 'wrap', padding: '0 4px' },
  hourBtn: {
    flex: '1 0 auto', minWidth: '40px', padding: '8px 0', borderRadius: '10px', border: '1px solid #E0D8C5',
    background: '#fff', fontSize: '12px', fontWeight: 700, color: '#8a8378',
  },
  hourBtnActive: { background: INDIGO, color: '#fff', border: `1px solid ${INDIGO}` },
  toggleRow: {
    display: 'flex', alignItems: 'center', gap: '10px', background: '#fff', border: '1px solid #EAE3D3',
    borderRadius: '12px', padding: '10px 12px', textAlign: 'left', width: '100%',
  },
  toggleRowActive: { background: '#FDEFE5', border: `1px solid ${STAMP_RED}55` },
  toggleRowCompact: { padding: '8px 10px' },
  checkbox: {
    width: '22px', height: '22px', borderRadius: '7px', border: '2px solid #D8CFB9', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 800, color: '#fff',
  },
  checkboxActive: { background: STAMP_RED, border: `2px solid ${STAMP_RED}` },
  toggleTextWrap: { display: 'flex', flexDirection: 'column' },
  toggleTitle: { fontSize: '13px', fontWeight: 700, color: INK },
  toggleDesc: { fontSize: '11px', color: '#9c948a' },
  saveBtn: {
    width: '100%', padding: '14px', borderRadius: '14px', border: 'none', background: STAMP_RED,
    color: '#fff', fontWeight: 800, fontSize: '15px', boxShadow: '0 4px 12px rgba(232,93,61,0.35)',
  },

  // Settle confirm modal
  confirmCard: {
    background: '#fff', borderRadius: '18px', padding: '20px', width: '90%', maxWidth: '360px',
    margin: 'auto', boxShadow: '0 8px 30px rgba(0,0,0,0.2)',
  },
  confirmTitle: { fontSize: '15px', fontWeight: 800, marginBottom: '8px' },
  confirmBody: { fontSize: '13px', color: '#6b625a', lineHeight: 1.6, marginBottom: '14px' },
  pwLabel: { fontSize: '11px', color: '#9c948a', marginBottom: '6px' },
  pwInput: {
    width: '100%', border: '1px solid #E0D8C5', borderRadius: '10px', padding: '12px 14px',
    fontSize: '18px', letterSpacing: '0.3em', textAlign: 'center', background: '#FBF6EC', color: INK,
    marginBottom: '16px', boxSizing: 'border-box',
  },
  pwInputWrong: { border: '1px solid #E85D3D', animation: 'shake 0.4s' },
  confirmBtnRow: { display: 'flex', gap: '10px' },
  confirmCancelBtn: {
    flex: 1, padding: '12px 0', borderRadius: '12px', border: '1px solid #E0D8C5', background: '#fff',
    color: '#8a8378', fontWeight: 700, fontSize: '13px',
  },
  confirmOkBtn: {
    flex: 1, padding: '12px 0', borderRadius: '12px', border: 'none', background: STAMP_RED, color: '#fff',
    fontWeight: 800, fontSize: '13px',
  },
  confirmOkBtnDisabled: { background: '#D8CFB9', color: '#fff' },
};
