/**
 * 🤖 FB Smart Auto Responder v8.2
 * ------------------------------------------------------------
 * - مرحلة Initialization واضحة: لا يُنفَّذ أي أمر قبل استرجاع الحالة
 * - تحميل ذكي: تمرير تدريجي + انتظار مبني على الأحداث + تحقق من اكتمال القائمة
 * - تحديد المحادثة: Key ثم (الاسم + بصمة الصورة) ولا يُستخدم الاسم وحده عند الغموض
 * - بحث موجّه بدل المحاولات العشوائية + سقف زمني + إعادة مسح كاملة قبل "غير موجود"
 * - اختيار الرد المحفوظ: مطابقة صارمة للعنوان + إعادة محاولة + عدم اختيار "أول رد" أبداً
 * - Web Locks / AudioContext / Heartbeat تعمل فقط أثناء التشغيف وتُحرَّر عند التوقف
 * - مؤقّت بديل عبر Worker حتى لا يتخنق التاب المخفي
 * - ويدجيت قابل للسحب والتكبير والتصغير والطي مع حفظ الوضع
 */
(() => {
'use strict';

// ============================================
// هوية النسخة (لمنع تشغيل نسختين متعارضتين بعد إعادة تحميل الإضافة)
// ============================================
const INSTANCE = Math.random().toString(36).slice(2) + Date.now().toString(36);
document.documentElement.dataset.fbsrInstance = INSTANCE;
const isAlive = () => document.documentElement.dataset.fbsrInstance === INSTANCE;
try { const old = document.getElementById('fbsr-widget-host'); if (old) old.remove(); } catch (e) {}

const SCHEMA = 2;

// ============================================
// الحالة
// ============================================
let currentMode = 'idle'; // idle | loading | sending
let processedChats = new Set();
let failedChats = new Set();
let failReasons = {};          // key -> reason
let stats = { sent: 0, skipped: 0, failed: 0 };
let conversationQueue = [];    // [{key,name,id,idKind,fp}]
let queueIndex = 0;
let loadingComplete = false;
let loadInfo = { withId: 0, nameOnly: 0, virtual: false };
let recentLogs = [];
let settings = { savedReplyTitle: 'BM AUTO', skipCount: 0, startFromName: '', speed: 'normal', autoRecover: true, autoResume: true };

let stopLoadingFlag = false;
let stopSendingFlag = false;
let initialized = false;
let queueDirty = false;
let lastProgressAt = Date.now();
let resumeSending = false;           // استئناف تلقائي بعد إعادة تحميل الصفحة
let recovery = { count: 0, start: 0 };
let currentName = '';
let statusNote = '';
let sendTimes = [];                  // أوقات آخر عمليات الإرسال الناجحة (لحساب السرعة و ETA)
let lastActive = 0;

let idxByKey = new Map();      // key -> index في الطابور
let nameCounts = new Map();    // اسم مطبّع -> عدد مرات ظهوره في الطابور
let fpByKey = new Map();

let _resolveReady;
const ready = new Promise(r => { _resolveReady = r; });

const touch = () => { lastProgressAt = Date.now(); };
const isStopped = () =>
    !isAlive() ||
    (currentMode === 'loading' && stopLoadingFlag) ||
    (currentMode === 'sending' && stopSendingFlag);

console.log('✅ [FB Bot v8.2] تم تحميل السكريبت (بانتظار استرجاع الحالة)');

// ============================================
// المؤقّتات: Worker (لا يتخنق في التاب المخفي) مع بدائل
// ============================================
let _timerWorker = null; // null = لم يُجرَّب، false = غير متاح
let _timerSeq = 0;
const _timerCbs = new Map();

function getTimerWorker() {
    if (_timerWorker !== null) return _timerWorker || null;
    try {
        const src = 'const t=new Map();onmessage=e=>{const d=e.data;if(d.cancel){clearTimeout(t.get(d.id));t.delete(d.id);return;}t.set(d.id,setTimeout(()=>{t.delete(d.id);postMessage(d.id);},d.ms));};';
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        const w = new Worker(url);
        w.onmessage = (e) => { const cb = _timerCbs.get(e.data); if (cb) { _timerCbs.delete(e.data); cb(); } };
        w.onerror = () => {
            _timerWorker = false;
            const pending = Array.from(_timerCbs.values());
            _timerCbs.clear();
            pending.forEach(cb => cb());
        };
        _timerWorker = w;
    } catch (e) { _timerWorker = false; }
    return _timerWorker || null;
}

function sleep(ms) {
    ms = Math.max(0, ms | 0);
    return new Promise(resolve => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        const w = getTimerWorker();
        if (!w) { setTimeout(finish, ms); return; }
        const id = ++_timerSeq;
        _timerCbs.set(id, finish);
        try { w.postMessage({ id, ms }); } catch (e) { setTimeout(finish, ms); return; }
        // شبكة أمان لو الـ Worker لم يرد
        setTimeout(finish, ms + 4000);
    });
}
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);
const randomDelay = (min, max) => sleep(rand(min, max));

async function waitUntil(cond, timeout = 5000, poll = 120) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        if (isStopped()) return false;
        let v = false;
        try { v = cond(); } catch (e) { /* تجاهل */ }
        if (v) return true;
        await sleep(poll);
    }
    try { return !!cond(); } catch (e) { return false; }
}

// ============================================
// السجل (يُكتب على دفعات لتخفيف الضغط على storage)
// ============================================
const logBuf = [];
let logTimer = null;

function addLog(message, type = 'info') {
    touch();
    const ts = new Date().toLocaleTimeString('ar');
    const entry = { message: `[${ts}] ${message}`, type };
    recentLogs.push(entry);
    if (recentLogs.length > 40) recentLogs.shift();
    logBuf.push(entry);
    if (!logTimer) logTimer = setTimeout(flushLogs, 1200);
    console.log(message);
}

async function flushLogs() {
    logTimer = null;
    if (!logBuf.length || !isAlive()) return;
    const add = logBuf.splice(0);
    try {
        const d = await chrome.storage.local.get('botLog');
        const logs = (d.botLog || []).concat(add).slice(-150);
        await chrome.storage.local.set({ botLog: logs });
    } catch (e) { /* غير حرج */ }
}

// ============================================
// حفظ الحالة (الطابور الكبير يُحفظ فقط عند تغيّره)
// ============================================
async function persistState(opts = {}) {
    if (!initialized || !isAlive()) return;
    const payload = {
        schema: SCHEMA,
        stats,
        processedChats: Array.from(processedChats),
        failedChats: Array.from(failedChats),
        failReasons,
        queueIndex,
        loadingComplete,
        loadInfo,
        currentMode,
        resumeSending,
        recovery,
        lastActive: Date.now()
    };
    if (opts.withQueue || queueDirty) { payload.conversationQueue = conversationQueue; queueDirty = false; }
    try { await chrome.storage.local.set(payload); } catch (e) { /* غير حرج */ }
}

function rebuildIndexes() {
    idxByKey = new Map();
    nameCounts = new Map();
    fpByKey = new Map();
    conversationQueue.forEach((c, i) => {
        idxByKey.set(c.key, i);
        const n = normalizeArabic(c.name);
        nameCounts.set(n, Math.max((nameCounts.get(n) || 0) + 1, c.dupN || 0));
        if (c.fp) fpByKey.set(c.key, c.fp);
    });
}

// ============================================
// Initialization: لا يُنفَّذ أي أمر قبل اكتمالها
// ============================================
async function initState() {
    let legacy = false;
    try {
        const r = await chrome.storage.local.get([
            'processedChats', 'failedChats', 'failReasons', 'conversationQueue', 'queueIndex',
            'stats', 'loadingComplete', 'loadInfo', 'botSettings', 'schema', 'resumeSending', 'recovery', 'lastActive'
        ]);
        if (r.resumeSending && Date.now() - (r.lastActive || 0) < 20 * 60000) resumeSending = true;
        if (r.recovery) recovery = r.recovery;
        if (r.processedChats) processedChats = new Set(r.processedChats);
        if (r.stats) stats = r.stats;
        if (r.botSettings) settings = { ...settings, ...r.botSettings };
        if (r.schema === SCHEMA) {
            if (r.failedChats) failedChats = new Set(r.failedChats);
            if (r.failReasons) failReasons = r.failReasons;
            if (r.conversationQueue) conversationQueue = r.conversationQueue;
            if (typeof r.queueIndex === 'number') queueIndex = r.queueIndex;
            if (typeof r.loadingComplete === 'boolean') loadingComplete = r.loadingComplete;
            if (r.loadInfo) loadInfo = { ...loadInfo, ...r.loadInfo };
        } else if (r.conversationQueue && r.conversationQueue.length) {
            legacy = true; // طابور من نسخة قديمة بمفاتيح غير متوافقة
        }
    } catch (e) { /* نكمل بحالة فارغة */ }

    currentMode = 'idle';
    rebuildIndexes();
    initialized = true;
    await persistState({ withQueue: true });
    _resolveReady();

    if (legacy) addLog('♻️ تم تحديث النسخة: أعد تحميل المحادثات (الطابور القديم غير متوافق)', 'warning');
    else if (conversationQueue.length > 0 || processedChats.size > 0) {
        addLog(`📊 استرجاع الحالة: ${processedChats.size} ناجحة، ${failedChats.size} فاشلة، ${conversationQueue.length} محملة`, 'info');
    }
}

// ============================================
// KeepAlive: يعمل فقط أثناء التشغيل ويتحرر عند التوقف
// ============================================
let _lockWanted = false;
let _lockRelease = null;
let _audioCtx = null;
let _audioOsc = null;
let _hbTimer = null;
let _audioWarned = false;

function acquireLock() {
    _lockWanted = true;
    if (_lockRelease || !navigator.locks) return;
    try {
        navigator.locks.request('fbsr_keepalive', { mode: 'shared' }, () => new Promise(res => {
            if (!_lockWanted) { res(); return; }   // تم الإيقاف قبل أن يُمنح القفل
            _lockRelease = res;
        })).catch(() => {});
    } catch (e) { /* غير حرج */ }
}
function releaseLock() {
    _lockWanted = false;
    if (_lockRelease) { try { _lockRelease(); } catch (e) {} _lockRelease = null; }
}

async function ensureAudio() {
    try {
        if (!_audioCtx || _audioCtx.state === 'closed') {
            _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            _audioOsc = null;
        }
        if (_audioCtx.state === 'suspended') await _audioCtx.resume();   // استئناف فعلي
        if (!_audioOsc && _audioCtx.state === 'running') {
            const osc = _audioCtx.createOscillator();
            const gain = _audioCtx.createGain();
            gain.gain.value = 0.00001; // غير مسموع
            osc.frequency.value = 30;
            osc.connect(gain); gain.connect(_audioCtx.destination);
            osc.start();
            _audioOsc = osc;
        }
        if (_audioCtx.state !== 'running' && !_audioWarned) {
            _audioWarned = true;
            addLog('ℹ️ الصوت معلّق (سياسة المتصفح) - اضغط أي مكان في الصفحة مرة واحدة', 'warning');
        }
    } catch (e) { /* غير حرج */ }
}
function stopAudio() {
    try { if (_audioOsc) { _audioOsc.stop(); _audioOsc.disconnect(); } } catch (e) {}
    _audioOsc = null;
    try { if (_audioCtx && _audioCtx.state !== 'closed') _audioCtx.close(); } catch (e) {}
    _audioCtx = null;
    _audioWarned = false;
}

function sendHeartbeat() {
    if (!isAlive()) return;
    try { chrome.runtime.sendMessage({ action: 'HEARTBEAT', mode: currentMode, lastProgressAt }); } catch (e) { /* السياق انتهى */ }
}

function startKeepAlive() {
    acquireLock();
    ensureAudio();
    if (!_hbTimer) { _hbTimer = setInterval(sendHeartbeat, 20000); }
    sendHeartbeat();
}
function stopKeepAlive() {
    releaseLock();
    stopAudio();
    if (_hbTimer) { clearInterval(_hbTimer); _hbTimer = null; }
}

function setMode(m) {
    currentMode = m;
    touch();
    if (m === 'idle') stopKeepAlive(); else startKeepAlive();
}

['click', 'keydown', 'pointerdown'].forEach(ev =>
    document.addEventListener(ev, () => { if (isAlive() && currentMode !== 'idle') ensureAudio(); }, { capture: true, passive: true })
);
document.addEventListener('visibilitychange', () => { if (isAlive() && currentMode !== 'idle') ensureAudio(); });

// ============================================
// 🧑 محاكاة السلوك البشري
// ============================================
function humanClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width * (0.3 + Math.random() * 0.4);
    const y = rect.top + rect.height * (0.3 + Math.random() * 0.4);
    const o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
    const P = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    el.dispatchEvent(new P('pointerover', { ...o, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseover', o));
    el.dispatchEvent(new MouseEvent('mousemove', o));
    el.dispatchEvent(new P('pointerdown', { ...o, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new P('pointerup', { ...o, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.click();
}
async function humanClickWithHover(el) {
    await rd(80, 220);
    humanClick(el);
}

const SPEEDS = {
    safe:   { k: 1.3, delay: [3500, 6000], breakEvery: [10, 16], breakMs: [20000, 45000] },
    normal: { k: 1.0, delay: [2000, 4000], breakEvery: [12, 18], breakMs: [15000, 40000] },
    fast:   { k: 0.5, delay: [900, 1800],  breakEvery: [30, 45], breakMs: [5000, 11000] }
};
const spd = () => SPEEDS[settings.speed] || SPEEDS.normal;
// تأخير داخلي بين خطوات الواجهة (يتناسب مع السرعة المختارة)
const rd = (a, b) => randomDelay(Math.round(a * spd().k), Math.round(b * spd().k));

function smartDelay() {
    const [a, b] = spd().delay;
    const base = a + Math.random() * (b - a);
    const errorRatio = stats.failed / Math.max(stats.sent + stats.failed, 1);
    return Math.floor(base * (1 + errorRatio * 0.8));
}

let messagesSinceBreak = 0;
let nextBreakAt = 15;
function scheduleBreak() { const [a, b] = spd().breakEvery; nextBreakAt = rand(a, b); }
scheduleBreak();
async function maybeHumanBreak() {
    messagesSinceBreak++;
    if (messagesSinceBreak >= nextBreakAt) {
        const [a, b] = spd().breakMs;
        const ms = rand(a, b);
        addLog(`☕ استراحة قصيرة (${Math.round(ms / 1000)} ثانية) لمحاكاة السلوك البشري...`, 'info');
        await sleep(ms);
        messagesSinceBreak = 0;
        scheduleBreak();
    }
}

// ============================================
// أدوات DOM
// ============================================
function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
}

function normalizeArabic(text) {
    return (text || '')
        .replace(/[\u064B-\u065F\u0670\u0640]/g, '')       // التشكيل والتطويل
        .replace(/[أإآٱ]/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/ى/g, 'ي')
        .replace(/[\u200b-\u200f\u202a-\u202e\u00a0]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

// ============================================
// صفوف المحادثات: Key ثابت + بصمة الصورة
// ============================================
const NAME_CLASS_SELECTOR = 'div.x1vvvo52.xxio538.x12nagc.xeuugli';
const ID_PATTERNS = [
    ['t', /\/t\/(\d+)/],
    ['sel', /[?&]selected_item_id=(\d+)/],
    ['thr', /[?&]thread_id=(\d+)/],
    ['inb', /\/inbox\/(?:[a-z_]+\/)?(\d{6,})/]
];

function idFromHref(href) {
    for (const [kind, re] of ID_PATTERNS) {
        const m = (href || '').match(re);
        if (m) return { kind, id: m[1] };
    }
    return null;
}
function currentUrlId(kind) {
    const p = ID_PATTERNS.find(x => x[0] === kind);
    if (!p) return null;
    const m = location.href.match(p[1]);
    return m ? m[1] : null;
}

function nameOf(el) { return (el.innerText || '').replace(/\s+/g, ' ').trim(); }

function containsOtherName(parent, from) {
    for (const ch of parent.children) {
        if (ch === from) continue;
        if (ch.matches(NAME_CLASS_SELECTOR) || ch.querySelector(NAME_CLASS_SELECTOR)) return true;
    }
    return false;
}

// أكبر حاوية تخص هذا الصف فقط (لا تحتوي صفوفاً أخرى) -> يمنع خلط روابط الصفوف
function getRowScope(nameEl) {
    let scope = nameEl, from = nameEl, cur = nameEl.parentElement;
    for (let i = 0; i < 10 && cur && cur !== document.body; i++) {
        if (containsOtherName(cur, from)) break;
        scope = cur; from = cur; cur = cur.parentElement;
    }
    return scope;
}

function avatarFp(scope) {
    const im = scope.querySelector('img[src], image');
    if (!im) return '';
    const src = im.getAttribute('src') || im.getAttribute('xlink:href') || im.getAttribute('href') || '';
    if (!src || src.startsWith('data:')) return '';
    try { return hashStr(new URL(src, location.href).pathname); } catch (e) { return ''; }
}

const rowCache = new WeakMap();

function buildRow(nameEl) {
    const name = nameOf(nameEl);
    let c = rowCache.get(nameEl);
    if (c && c.name === name) {
        if (!c.fp) c.fp = avatarFp(getRowScope(nameEl));  // الصورة قد تتأخر
    } else {
        const scope = getRowScope(nameEl);
        let info = null;
        const own = nameEl.closest('a[href]');
        if (own) info = idFromHref(own.getAttribute('href'));
        if (!info) {
            for (const a of scope.querySelectorAll('a[href]')) {
                info = idFromHref(a.getAttribute('href'));
                if (info) break;
            }
        }
        c = { name, id: info ? info.id : null, idKind: info ? info.kind : null, fp: avatarFp(scope) };
        rowCache.set(nameEl, c);
    }
    return {
        el: nameEl, name,
        id: c.id, idKind: c.idKind, fp: c.fp,
        key: c.id ? 'id:' + c.id : 'name:' + name
    };
}

let _strategyLogged = false;
function readRows() {
    const els = Array.from(document.querySelectorAll(NAME_CLASS_SELECTOR)).filter(e => nameOf(e).length > 0);
    if (els.length) return els.map(buildRow);

    // خطة بديلة: لو فيسبوك غيّر الكلاسات، نعتمد على روابط المحادثات
    const rows = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
        const info = idFromHref(a.getAttribute('href'));
        if (!info || seen.has(info.id)) continue;
        const first = (a.innerText || '').split('\n').map(s => s.trim()).filter(Boolean)[0];
        if (!first) continue;
        seen.add(info.id);
        rows.push({ el: a, name: first, id: info.id, idKind: info.kind, fp: avatarFp(a), key: 'id:' + info.id });
    }
    if (rows.length && !_strategyLogged) {
        _strategyLogged = true;
        addLog('ℹ️ تم استخدام خطة بديلة لقراءة القائمة (الكلاسات تغيّرت)', 'warning');
    }
    return rows;
}

// ============================================
// حاوية التمرير + مؤشرات الحدود
// ============================================
let listContainer = null;

function findScrollContainer(sampleEl) {
    let el = sampleEl, depth = 0;
    while (el && el !== document.body && depth < 15) {
        const st = getComputedStyle(el);
        if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 5) return el;
        el = el.parentElement; depth++;
    }
    return null;
}
function getListContainer() {
    const first = document.querySelector(NAME_CLASS_SELECTOR) ||
        Array.from(document.querySelectorAll('a[href]')).find(a => idFromHref(a.getAttribute('href')));
    if (!first) return listContainer && listContainer.isConnected ? listContainer : null;
    if (listContainer && listContainer.isConnected && listContainer.contains(first)) return listContainer;
    listContainer = findScrollContainer(first);
    return listContainer;
}
const isAtBottom = (c) => c.scrollTop + c.clientHeight >= c.scrollHeight - 6;
const isAtTop = (c) => c.scrollTop <= 3;

function spinnerVisible(container) {
    const sel = '[role="progressbar"], [aria-busy="true"]';
    for (const scope of [container, container && container.parentElement]) {
        if (!scope) continue;
        for (const el of scope.querySelectorAll(sel)) if (isVisible(el)) return true;
    }
    return false;
}

// ============================================
// مطابقة المحادثة: لا يُكتفى بالاسم وحده عند الغموض
// ============================================
function matchRow(rows, entry) {
    // المفتاح القائم على معرّف فريد دليل قاطع. المفتاح القائم على الاسم فقط ليس دليلاً كافياً.
    if (entry.id) {
        const exact = rows.find(r => r.key === entry.key);
        if (exact) return { row: exact, how: 'key' };
    }

    const n = normalizeArabic(entry.name);
    let cands = rows.filter(r => normalizeArabic(r.name) === n);
    // صف له معرّف مختلف = محادثة أخرى بنفس الاسم -> يُستبعد
    if (entry.id) cands = cands.filter(r => !r.id || r.idKind !== entry.idKind || r.id === entry.id);
    if (!cands.length) return { row: null };

    if (entry.fp) {
        const byFp = cands.filter(r => r.fp && r.fp === entry.fp);
        if (byFp.length === 1) return { row: byFp[0], how: 'name+avatar' };
        if (byFp.length > 1) cands = byFp;
    }
    if (cands.length === 1 && (nameCounts.get(n) || 1) === 1) return { row: cands[0], how: 'name-unique' };
    return { row: null, ambiguous: true };
}

// ============================================
// 📋 تحميل المحادثات (بدون إرسال)
// ============================================
function ingestRows(seen) {
    let added = 0;
    const snapshot = readRows();
    // نفس الاسم بدون معرّف ظاهر أكثر من مرة في نفس اللحظة = محادثات مختلفة قطعاً
    const snapNoId = new Map();
    for (const r of snapshot) if (!r.id) snapNoId.set(r.key, (snapNoId.get(r.key) || 0) + 1);
    for (const [k, cnt] of snapNoId) {
        if (cnt < 2) continue;
        const e = conversationQueue[idxByKey.get(k)];
        if (e && (e.dupN || 1) < cnt) {
            e.dupN = cnt;
            const n = normalizeArabic(e.name);
            nameCounts.set(n, Math.max(nameCounts.get(n) || 0, cnt));
            queueDirty = true;
        }
    }
    for (const r of snapshot) {
        let key = r.key;
        if (seen.has(key)) {
            // نفس الاسم لكن صورة مختلفة = شخص آخر بنفس الاسم
            const prev = fpByKey.get(key);
            if (!r.id && r.fp && prev && r.fp !== prev) {
                key = key + '|' + r.fp;
                if (seen.has(key)) continue;
            } else {
                if (!r.id && r.fp && !prev) {
                    const e = conversationQueue[idxByKey.get(key)];
                    if (e && !e.fp) { e.fp = r.fp; fpByKey.set(key, r.fp); queueDirty = true; }
                }
                continue;
            }
        }
        seen.add(key);
        const entry = { key, name: r.name, id: r.id || null, idKind: r.idKind || null, fp: r.fp || '' };
        conversationQueue.push(entry);
        idxByKey.set(key, conversationQueue.length - 1);
        const n = normalizeArabic(r.name);
        nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
        if (r.fp) fpByKey.set(key, r.fp);
        const cnt = snapNoId.get(r.key) || 0;
        if (!r.id && cnt > 1) {
            entry.dupN = cnt;
            nameCounts.set(n, Math.max(nameCounts.get(n) || 0, cnt));
        }
        added++;
    }
    if (added) { queueDirty = true; touch(); }
    return added;
}

// مسح كامل من الأعلى للأسفل بخطوات متداخلة للتحقق من عدم ضياع أي صف
async function verifySweep(container, seen) {
    let added = 0;
    container.scrollTop = 0;
    await sleep(350);
    added += ingestRows(seen);
    let guard = 0;
    while (!isStopped() && guard++ < 4000) {
        const before = container.scrollTop;
        container.scrollTop = before + Math.max(200, Math.floor(container.clientHeight * 0.8));
        await sleep(170);
        added += ingestRows(seen);
        if (isAtBottom(container) || Math.abs(container.scrollTop - before) < 2) {
            await sleep(500);
            added += ingestRows(seen);
            break;
        }
    }
    return added;
}

async function buildConversationQueue() {
    setMode('loading');
    stopLoadingFlag = false;
    loadingComplete = false;
    await persistState();

    const seen = new Set(conversationQueue.map(c => c.key));
    const startCount = conversationQueue.length;
    addLog(`📋 بدء التحميل (يوجد ${startCount} محادثة محملة مسبقاً)...`, 'info');

    let container = getListContainer();
    if (container) { container.scrollTop = 0; await sleep(300); }
    ingestRows(seen);

    let virtual = !!loadInfo.virtual;
    let verifyCycles = 0;
    let idle = 0;
    let reachedEnd = false;
    let noContainer = 0;
    let lastSave = conversationQueue.length;
    const NEED_IDLE = 3;

    outer:
    while (!isStopped()) {
        // ---- المرحلة 1: النزول حتى نهاية القائمة ----
        while (!isStopped()) {
            ingestRows(seen);
            container = getListContainer();
            if (!container) {
                noContainer++;
                if (noContainer > 4 && seen.size > 0) { reachedEnd = true; break outer; } // القائمة كلها ظاهرة بلا تمرير
                if (noContainer > 12) break outer;
                await sleep(700);
                continue;
            }
            noContainer = 0;

            const beforeH = container.scrollHeight;
            const beforeTop = container.scrollTop;
            const beforeN = seen.size;
            const sample = readRows().slice(0, 6).map(r => r.key);

            if (virtual) container.scrollTop = beforeTop + Math.max(200, Math.floor(container.clientHeight * 0.8));
            else container.scrollTop = container.scrollHeight;
            await sleep(120);

            await waitUntil(
                () => ingestRows(seen) > 0 || container.scrollHeight > beforeH + 4,
                spinnerVisible(container) ? 9000 : 2200, 100
            );

            // كشف الـ virtualization: صفوف اختفت من الـ DOM بعد التمرير
            if (!virtual && sample.length >= 4) {
                const now = new Set(readRows().map(r => r.key));
                const vanished = sample.filter(k => !now.has(k)).length;
                if (vanished >= 3) {
                    virtual = true;
                    loadInfo.virtual = true;
                    addLog('🔎 القائمة بتحمّل الصفوف تدريجياً (virtualized) - تم التحويل للتمرير بخطوات صغيرة', 'info');
                    container.scrollTop = 0;
                    await sleep(400);
                    idle = 0;
                    continue;
                }
            }

            const grew = seen.size > beforeN || container.scrollHeight > beforeH + 4;
            const moved = Math.abs(container.scrollTop - beforeTop) > 3;
            if (grew) idle = 0;
            else if (isAtBottom(container) && !spinnerVisible(container)) { idle++; await sleep(500); }
            else if (!moved) { idle++; await sleep(400); }

            if (conversationQueue.length - lastSave >= 25) {
                lastSave = conversationQueue.length;
                await persistState();
                addLog(`💾 تم تحميل ${conversationQueue.length} محادثة حتى الآن...`, 'info');
            }
            if (idle >= NEED_IDLE) { reachedEnd = true; break; }
        }
        if (isStopped() || !reachedEnd) break;

        // ---- المرحلة 2: تحقق: مسح كامل من الأعلى ----
        verifyCycles++;
        addLog(`🔍 تحقق من اكتمال القائمة (مسح ${verifyCycles})...`, 'info');
        const extra = await verifySweep(container, seen);
        if (extra > 0 && verifyCycles < 4) {
            addLog(`➕ التحقق لقى ${extra} محادثة ناقصة - استكمال التحميل`, 'warning');
            idle = 0; reachedEnd = false;
            continue;
        }
        break;
    }

    const stoppedManually = isStopped();
    loadingComplete = !stoppedManually && reachedEnd;
    loadInfo.withId = conversationQueue.filter(c => c.id).length;
    loadInfo.nameOnly = conversationQueue.length - loadInfo.withId;
    queueDirty = true;
    setMode('idle');
    await persistState({ withQueue: true });

    if (stoppedManually) addLog(`⏹️ تم إيقاف التحميل عند ${conversationQueue.length} محادثة (القائمة غير مكتملة)`, 'warning');
    else if (loadingComplete) addLog(`✅ اكتمل التحميل والتحقق: ${conversationQueue.length} محادثة إجمالاً`, 'success');
    else addLog(`⚠️ التحميل انتهى بدون تأكيد النهاية (${conversationQueue.length} محادثة) - أعد التحميل`, 'warning');

    if (loadInfo.nameOnly > 0) {
        addLog(`⚠️ ${loadInfo.nameOnly} محادثة بدون معرّف فريد (الاعتماد على الاسم + الصورة)`, 'warning');
    }
    const dupEntries = conversationQueue.filter(c => (c.dupN || 0) > 1 && !c.id);
    if (dupEntries.length) {
        const hidden = dupEntries.reduce((a, c) => a + c.dupN - 1, 0);
        addLog(`⚠️ ${dupEntries.length} اسم مكرر بدون معرّف (حوالي ${hidden} محادثة إضافية مخفية خلف نفس الاسم) - سيتم تخطيها للأمان بدل إرسال لمحادثة خطأ: ${dupEntries.slice(0, 5).map(c => c.name).join(' | ')}`, 'warning');
    }
}

// ============================================
// 🖱️ إيجاد المحادثة: بحث موجّه (مش تدوير عشوائي)
// ============================================
function hintDirection(rows, idx) {
    const visIdx = [];
    for (const r of rows) {
        let i = idxByKey.get(r.key);
        if (i === undefined) {
            const n = normalizeArabic(r.name);
            if ((nameCounts.get(n) || 0) === 1) i = conversationQueue.findIndex(c => normalizeArabic(c.name) === n);
        }
        if (i !== undefined && i >= 0) visIdx.push(i);
    }
    if (!visIdx.length) return { dir: idx >= rows.length ? 1 : -1, median: -1 };
    visIdx.sort((a, b) => a - b);
    const median = visIdx[Math.floor(visIdx.length / 2)];
    return { dir: idx > median ? 1 : -1, median };
}

async function locateConversation(entry, idx, opts = {}) {
    const t0 = Date.now();
    const TIME_CAP = opts.timeCap || 150000;

    let rows = readRows();
    let m = matchRow(rows, entry);
    if (m.row) return { row: m.row, how: m.how };
    let sawAmbiguous = !!m.ambiguous;

    let container = getListContainer();
    if (!container) return { row: null, reason: 'not_found' };

    let { dir, median } = hintDirection(rows, idx);

    // قوائم الـ virtualized: قفزة تقديرية قرب مكان المحادثة (بدل البدء من أول القائمة)
    if (loadInfo.virtual && conversationQueue.length > 0 && !opts.full) {
        const ratio = idx / Math.max(conversationQueue.length, 1);
        container.scrollTop = Math.max(0, Math.floor(ratio * container.scrollHeight - container.clientHeight / 2));
        await sleep(350);
        rows = readRows(); m = matchRow(rows, entry);
        if (m.row) return { row: m.row, how: m.how };
        if (m.ambiguous) sawAmbiguous = true;
    }
    if (opts.full) { container.scrollTop = 0; await sleep(300); dir = 1; }

    let flips = 0;
    let steps = 0;
    while (!isStopped() && Date.now() - t0 < TIME_CAP && flips < 2) {
        container = getListContainer() || container;
        const before = container.scrollTop;
        const beforeH = container.scrollHeight;
        const step = Math.max(220, Math.floor(container.clientHeight * 0.8));
        const far = dir > 0 && !loadInfo.virtual && median >= 0 && (idx - median) > 30;

        if (dir > 0) container.scrollTop = far ? container.scrollHeight : Math.min(before + step, container.scrollHeight);
        else container.scrollTop = Math.max(0, before - step);
        steps++;

        await sleep(170);
        const moved = Math.abs(container.scrollTop - before) > 3;
        const atEnd = dir > 0 ? isAtBottom(container) : isAtTop(container);

        rows = readRows(); m = matchRow(rows, entry);
        if (m.row) return { row: m.row, how: m.how };
        if (m.ambiguous) sawAmbiguous = true;

        if (dir > 0 && (atEnd || !moved)) {
            // وصلنا للنهاية: استنى تحميل دفعة جديدة (يتمدد لو في سبينر)
            const grew = await waitUntil(() => {
                const rr = readRows();
                const mm = matchRow(rr, entry);
                if (mm.row) { m = mm; return true; }
                if (mm.ambiguous) sawAmbiguous = true;
                return container.scrollHeight > beforeH + 4;
            }, spinnerVisible(container) ? 7000 : 1500, 120);
            if (m.row) return { row: m.row, how: m.how };
            if (!grew) { flips++; dir = -1; }
        } else if (dir < 0 && (atEnd || !moved)) {
            flips++; dir = 1;
        }
        median = -1; // بعد أول خطوة لا نعتمد على التقدير القديم
    }
    return { row: null, reason: sawAmbiguous ? 'ambiguous' : 'not_found' };
}

// ============================================
// مربع الكتابة + أزرار
// ============================================
function getComposeBox() {
    const boxes = Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"]')).filter(isVisible);
    if (!boxes.length) return null;
    // مربع الرد هو الأقرب لأسفل الصفحة
    return boxes.reduce((a, b) => b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a);
}
function getComposeText() {
    const b = getComposeBox();
    return b ? (b.innerText || '').trim() : '';
}
async function clearCompose() {
    const b = getComposeBox();
    if (!b) return;
    try {
        b.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
    } catch (e) { /* غير حرج */ }
    await sleep(200);
}

function findByLabel(labelText) {
    const els = document.querySelectorAll(`[aria-label*="${labelText}"]`);
    for (const e of els) if (isVisible(e)) return e;
    return null;
}

function findSavedReplyButton() {
    const labels = ['إدراج رد محفوظ', 'Insert saved reply', 'Saved replies', 'الردود المحفوظة', 'رد محفوظ', 'Saved reply'];
    for (const l of labels) {
        const el = findByLabel(l);
        if (el) return el;
    }
    return null;
}

function findSendButton() {
    const box = getComposeBox();
    const boxBottom = box ? box.getBoundingClientRect().bottom : 0;
    const dist = (e) => Math.abs(e.getBoundingClientRect().bottom - boxBottom);
    const enabled = (e) => isVisible(e) && e.getAttribute('aria-disabled') !== 'true';
    const exactLabels = ['إرسال', 'Send'];

    let cands = Array.from(document.querySelectorAll('[aria-label]'))
        .filter(e => exactLabels.includes((e.getAttribute('aria-label') || '').trim()) && enabled(e));
    if (!cands.length) {
        cands = Array.from(document.querySelectorAll('[aria-label*="إرسال"], [aria-label*="Send"]')).filter(enabled);
    }
    if (!cands.length) {
        cands = Array.from(document.querySelectorAll('div[role="button"]'))
            .filter(b => /^(إرسال|Send)$/i.test((b.innerText || '').trim()) && enabled(b));
    }
    if (!cands.length) return null;
    return cands.reduce((a, b) => dist(b) < dist(a) ? b : a);
}

function detectBlocked() {
    const main = document.querySelector('[role="main"]') || document.body;
    const t = main.innerText || '';
    return /لا يمكنك الرد|you can[’']?t reply|this person is unavailable|can[’']?t reply to this conversation/i.test(t);
}

// ============================================
// 🎯 اختيار الرد المحفوظ (مطابقة صارمة + إعادة محاولة)
// ============================================
const PRESSABLE = '[aria-label*="Pressable"]';

function commonAncestor(els) {
    if (!els.length) return null;
    let anc = els[0].parentElement;
    while (anc && !els.every(e => anc.contains(e))) anc = anc.parentElement;
    return anc;
}

function getPopupScope(beforeSet) {
    const all = Array.from(document.querySelectorAll(PRESSABLE)).filter(isVisible);
    const fresh = beforeSet ? all.filter(p => !beforeSet.has(p)) : [];
    if (fresh.length) {
        const dlg = fresh[0].closest('[role="dialog"]');
        return { scope: dlg || commonAncestor(fresh), items: fresh };
    }
    for (const d of document.querySelectorAll('[role="dialog"]')) {
        const items = Array.from(d.querySelectorAll(PRESSABLE)).filter(isVisible);
        if (items.length) return { scope: d, items };
    }
    return null;
}

function firstLine(el) {
    return ((el.innerText || '').split('\n').map(s => s.trim()).filter(Boolean)[0]) || '';
}

function findClickableAncestor(el, root) {
    let cur = el, depth = 0;
    while (cur && cur !== root && cur !== document.body && depth < 12) {
        const label = cur.getAttribute && cur.getAttribute('aria-label');
        const role = cur.getAttribute && cur.getAttribute('role');
        if ((label && label.includes('Pressable')) || ['button', 'listitem', 'menuitem', 'option'].includes(role)) return cur;
        cur = cur.parentElement; depth++;
    }
    return null;
}

// مطابقة العنوان حرفياً (بعد التطبيع) - لا مطابقة جزئية ولا "أول رد" لو في عنوان مطلوب
function pickSavedReply(scope, wanted) {
    const nw = normalizeArabic(wanted);
    const items = Array.from(scope.querySelectorAll(PRESSABLE)).filter(isVisible);

    if (!nw) {
        const first = items.find(p => (p.innerText || '').trim().length > 2);
        return first ? { el: first, method: 'first-reply' } : null;
    }
    // 1) السطر الأول داخل العنصر القابل للنقر = العنوان
    for (const p of items) {
        if (normalizeArabic(firstLine(p)) === nw) return { el: p, method: 'title-firstline' };
    }
    // 2) عنصر heading/نص مطابق ثم أقرب عنصر قابل للنقر
    const textEls = Array.from(scope.querySelectorAll('[role="heading"], span, div'))
        .filter(e => (e.children.length === 0 || e.getAttribute('role') === 'heading') && isVisible(e));
    const found = new Set();
    for (const e of textEls) {
        if (normalizeArabic(e.innerText || e.textContent) === nw) {
            const c = findClickableAncestor(e, scope);
            if (c) found.add(c);
        }
    }
    if (found.size >= 1) return { el: Array.from(found)[0], method: 'title-text', multiple: found.size > 1 };
    return null;
}

function listAvailableTitles(scope) {
    return Array.from(scope.querySelectorAll(PRESSABLE)).filter(isVisible)
        .map(firstLine).filter(Boolean).slice(0, 8);
}

function findScrollableInside(scope) {
    for (const e of scope.querySelectorAll('*')) {
        if (e.scrollHeight > e.clientHeight + 8 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) return e;
    }
    return null;
}

async function closeOpenDialogs() {
    for (let i = 0; i < 3; i++) {
        const open = Array.from(document.querySelectorAll('[role="dialog"]'))
            .filter(d => isVisible(d) && d.querySelector(PRESSABLE));
        if (!open.length) return;
        const closeBtn = open[0].querySelector('[aria-label="Close"], [aria-label="إغلاق"], [aria-label="close"]');
        if (closeBtn) humanClick(closeBtn);
        else {
            const t = document.activeElement || document.body;
            const ev = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
            t.dispatchEvent(new KeyboardEvent('keydown', ev));
            t.dispatchEvent(new KeyboardEvent('keyup', ev));
        }
        await sleep(350);
    }
}

// يرجع { ok, text } أو { ok:false, reason }
async function insertSavedReply() {
    const wanted = (settings.savedReplyTitle || '').trim();
    const ATTEMPTS = 3;
    let lastReason = 'popup_failed';
    let baseline = '';

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        if (isStopped()) return { ok: false, reason: 'stopped' };

        await closeOpenDialogs();
        let before = getComposeText();
        if (attempt === 1) {
            if (before) {
                addLog('ℹ️ مربع الكتابة فيه نص قديم - يتم تنظيفه قبل إدراج الرد', 'info');
                await clearCompose();
                before = getComposeText();
            }
            baseline = before;
        } else if (before && before !== baseline) {
            // الإدراج حصل فعلاً في المحاولة السابقة (متأخراً) - لا نكرره
            return { ok: true, text: before, method: 'late-insert' };
        }

        const btn = findSavedReplyButton();
        if (!btn) {
            lastReason = 'no_button';
            await sleep(700);
            continue;
        }

        const beforeSet = new Set(document.querySelectorAll(PRESSABLE));
        await humanClickWithHover(btn);

        // انتظر ظهور القائمة وتحميل عناصرها (مع تمرير داخلي للبحث عن العنوان)
        let picked = null, scopeInfo = null, scrolls = 0;
        const t0 = Date.now();
        while (Date.now() - t0 < 8000 && !isStopped()) {
            scopeInfo = getPopupScope(beforeSet);
            if (scopeInfo && scopeInfo.scope) {
                picked = pickSavedReply(scopeInfo.scope, wanted);
                if (picked) break;
                const sc = findScrollableInside(scopeInfo.scope) || scopeInfo.scope;
                const bt = sc.scrollTop;
                if (scrolls < 8 && sc.scrollHeight > sc.clientHeight + 8) {
                    sc.scrollTop = bt + Math.max(120, Math.floor(sc.clientHeight * 0.8));
                    scrolls++;
                    await sleep(350);
                    continue;
                }
            }
            await sleep(250);
        }

        if (!scopeInfo) {
            lastReason = 'popup_failed';
            addLog(`⚠️ قائمة الردود المحفوظة لم تظهر (محاولة ${attempt}/${ATTEMPTS})`, 'warning');
            continue;
        }
        if (!picked) {
            lastReason = 'reply_not_found';
            const titles = listAvailableTitles(scopeInfo.scope);
            addLog(`⚠️ الرد "${wanted}" غير موجود في القائمة (محاولة ${attempt}/${ATTEMPTS})${titles.length ? ' - المتاح: ' + titles.join(' | ') : ''}`, 'warning');
            continue;
        }
        if (picked.multiple) addLog(`ℹ️ أكثر من رد بنفس العنوان "${wanted}" - تم اختيار الأول`, 'warning');

        await humanClickWithHover(picked.el);
        const changed = await waitUntil(() => {
            const t = getComposeText();
            return t.length > 0 && t !== before;
        }, 5000, 150);

        if (changed) {
            await closeOpenDialogs();   // لو القائمة لسه مفتوحة
            return { ok: true, text: getComposeText(), method: picked.method };
        }

        // ممكن الإدراج حصل متأخر - افحص قبل إعادة المحاولة عشان ما يتكررش النص
        await sleep(600);
        const late = getComposeText();
        if (late.length > 0 && late !== before) {
            await closeOpenDialogs();
            return { ok: true, text: late, method: picked.method };
        }
        lastReason = 'insert_failed';
        addLog(`⚠️ تم الضغط على الرد لكن مربع الكتابة لم يتغير (محاولة ${attempt}/${ATTEMPTS})`, 'warning');
    }
    await closeOpenDialogs();
    return { ok: false, reason: lastReason };
}

// ============================================
// فتح المحادثة والتحقق منها
// ============================================
async function verifyOpened(entry) {
    const hasBox = await waitUntil(() => !!getComposeBox(), 5000, 150);
    if (!hasBox) return { ok: false, reason: detectBlocked() ? 'blocked' : 'no_compose' };

    if (entry.id && entry.idKind) {
        const cur = currentUrlId(entry.idKind);
        if (cur && cur !== entry.id) {
            const ok = await waitUntil(() => currentUrlId(entry.idKind) === entry.id, 2500, 150);
            if (!ok) return { ok: false, reason: 'wrong_conversation' };
        }
    }
    return { ok: true };
}

async function sendSavedReply() {
    const ins = await insertSavedReply();
    if (!ins.ok) return ins;
    await rd(400, 900);

    const sendBtn = findSendButton();
    if (!sendBtn) return { ok: false, reason: 'no_send_button' };
    await humanClickWithHover(sendBtn);

    const confirmed = await waitUntil(() => getComposeText() !== ins.text, 4500, 150);
    if (!confirmed) return { ok: false, reason: 'send_unconfirmed' };
    return { ok: true };
}

async function processEntry(entry, idx, opts = {}) {
    const loc = await locateConversation(entry, idx, opts);
    if (!loc.row) return { status: isStopped() ? 'stopped' : 'fail', reason: loc.reason || 'not_found' };

    try { loc.row.el.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (e) {}
    await rd(200, 380);
    if (!loc.row.el.isConnected) return { status: 'fail', reason: 'not_found' };
    await humanClickWithHover(loc.row.el);
    if (loc.how !== 'key') addLog(`ℹ️ تم تحديد المحادثة عبر ${loc.how}`, 'info');

    const v = await verifyOpened(entry);
    if (!v.ok) return { status: isStopped() ? 'stopped' : 'fail', reason: v.reason };
    await rd(350, 700);

    const r = await sendSavedReply();
    if (r.ok) return { status: 'sent' };
    return { status: isStopped() ? 'stopped' : 'fail', reason: r.reason };
}

// ============================================
// أسباب الفشل
// ============================================
const REASON_LABEL = {
    not_found: 'لم يتم العثور على المحادثة',
    ambiguous: 'اسم مكرر ولا يمكن التمييز (تم التخطي للأمان)',
    wrong_conversation: 'فُتحت محادثة مختلفة (تم الإلغاء قبل الإرسال)',
    blocked: 'محادثة لا يمكن الرد عليها',
    no_compose: 'مربع الكتابة لم يظهر',
    no_button: 'زر الردود المحفوظة غير موجود',
    popup_failed: 'قائمة الردود المحفوظة لم تفتح',
    reply_not_found: 'الرد المحفوظ المطلوب غير موجود',
    insert_failed: 'الرد لم يُدرج في مربع الكتابة',
    no_send_button: 'زر الإرسال غير موجود',
    send_unconfirmed: 'لم يتأكد الإرسال (لن يُعاد تلقائياً لتجنب التكرار)'
};
// أسباب آمنة لإعادة المحاولة تلقائياً (send_unconfirmed مستبعد لأن الرسالة ربما أُرسلت فعلاً)
const SAFE_RETRY = new Set(['not_found', 'ambiguous', 'wrong_conversation', 'no_compose', 'no_button', 'popup_failed', 'reply_not_found', 'insert_failed', 'no_send_button']);
// أسباب تدل على مشكلة في الواجهة نفسها (تُحسب للإيقاف التلقائي)
const UI_FAIL = new Set(['no_button', 'popup_failed', 'reply_not_found', 'insert_failed', 'no_send_button', 'send_unconfirmed']);

function reasonsSummary() {
    const counts = {};
    for (const k of failedChats) { const r = failReasons[k] || 'unknown'; counts[r] = (counts[r] || 0) + 1; }
    return Object.entries(counts).map(([r, n]) => `${REASON_LABEL[r] || r}: ${n}`).join(' | ');
}

// ============================================
// معالج الرسائل (لا ينفّذ شيئاً قبل اكتمال Initialization)
// ============================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!isAlive()) return false;
    if (request.action === 'HEARTBEAT') {
        sendResponse({ ok: true, mode: currentMode, lastProgressAt, initialized });
        return false;
    }
    ready.then(async () => {
        switch (request.action) {
            case 'LOAD_ONLY':
                setTimeout(() => loadOnlyFlow(), 0);
                sendResponse({ ok: true });
                break;
            case 'SEND_LOADED':
                if (request.settings) {
                    settings = { ...settings, ...request.settings };
                    try { chrome.storage.local.set({ botSettings: settings }); } catch (e) {}
                }
                setTimeout(() => sendOnlyFlow(), 0);
                sendResponse({ ok: true });
                break;
            case 'STOP_ALL':
                stopAll();
                sendResponse({ ok: true });
                break;
            case 'GET_STATE':
                sendResponse({ ok: true, mode: currentMode, loaded: conversationQueue.length, ready: true });
                break;
            case 'RESET':
                await resetAll();
                sendResponse({ ok: true });
                break;
            default:
                sendResponse({ ok: false });
        }
    });
    return true;
});

function stopAll() {
    stopLoadingFlag = true;
    stopSendingFlag = true;
    resumeSending = false;           // إيقاف يدوي = لا استئناف تلقائي
    persistState();
    addLog('⏹️ تم طلب الإيقاف - سيتوقف البوت خلال ثوانٍ', 'warning');
}

async function resetAll() {
    stopLoadingFlag = true;
    stopSendingFlag = true;
    resumeSending = false;
    recovery = { count: 0, start: 0 };
    currentName = ''; statusNote = ''; sendTimes = [];
    setMode('idle');
    processedChats = new Set();
    failedChats = new Set();
    failReasons = {};
    conversationQueue = [];
    queueIndex = 0;
    loadingComplete = false;
    loadInfo = { withId: 0, nameOnly: 0, virtual: false };
    stats = { sent: 0, skipped: 0, failed: 0 };
    messagesSinceBreak = 0;
    recentLogs = [];
    rebuildIndexes();
    await persistState({ withQueue: true });
}

// ============================================
// تدفق: تحميل فقط / إرسال للمحمّل
// ============================================
async function loadOnlyFlow() {
    if (!initialized) { addLog('⏳ الإضافة لسه بتجهّز - حاول بعد لحظة', 'warning'); return; }
    if (currentMode !== 'idle') {
        addLog(`⚠️ فيه عملية شغالة بالفعل (${currentMode}) - أوقفها الأول`, 'warning');
        return;
    }
    await buildConversationQueue();
}

async function stopLoadingIfRunning() {
    if (currentMode !== 'loading') return true;
    addLog('⏸️ إيقاف التحميل أولاً قبل بدء الإرسال...', 'info');
    stopLoadingFlag = true;
    const t0 = Date.now();
    while (currentMode === 'loading' && Date.now() - t0 < 30000) await sleep(300);
    if (currentMode === 'loading') { addLog('❌ التحميل لم يتوقف - حاول مرة أخرى', 'error'); return false; }
    return true;
}

async function sendOnlyFlow(opts = {}) {
    if (!initialized) { addLog('⏳ الإضافة لسه بتجهّز - حاول بعد لحظة', 'warning'); return; }
    if (currentMode === 'sending') { addLog('⚠️ الإرسال شغال بالفعل', 'warning'); return; }
    if (!(await stopLoadingIfRunning())) return;
    if (conversationQueue.length === 0) {
        addLog('❌ لا توجد محادثات محملة بعد - اضغط تحميل أولاً', 'error');
        return;
    }
    if (!opts.resumed) applyStartPosition();
    await runSendAutomation();
}

// يُنفَّذ بعد إعادة تحميل تلقائية: يكمل من نفس المكان بدون تدخل
async function autoResumeFlow() {
    if (!resumeSending || !settings.autoResume || !conversationQueue.length) return;
    addLog('♻️ استئناف تلقائي بعد إعادة تحميل الصفحة...', 'info');
    statusNote = 'استئناف تلقائي';
    const listShown = await waitUntil(() => readRows().length > 0, 45000, 500);
    if (!listShown) {
        addLog('⚠️ القائمة لم تظهر بعد إعادة التحميل - لن يتم الاستئناف التلقائي', 'warning');
        resumeSending = false; statusNote = '';
        await persistState();
        return;
    }
    await sleep(1500);
    statusNote = '';
    await sendOnlyFlow({ resumed: true });
}

// إعادة محاولة كل الفاشلين بأسباب آمنة (من زر في الواجهة)
async function retryFailedFlow() {
    if (!initialized || currentMode !== 'idle') return;
    let earliest = -1, n = 0;
    for (let i = 0; i < conversationQueue.length; i++) {
        const k = conversationQueue[i].key;
        if (failedChats.has(k) && !processedChats.has(k) && SAFE_RETRY.has(failReasons[k] || 'not_found')) {
            failedChats.delete(k); delete failReasons[k]; n++;
            if (earliest < 0) earliest = i;
        }
    }
    if (!n) { addLog('ℹ️ لا يوجد فاشلون قابلون لإعادة المحاولة (المستبعد: غير مؤكد الإرسال لتفادي التكرار)', 'info'); return; }
    stats.failed = Math.max(0, stats.failed - n);
    queueIndex = earliest;
    addLog(`🔄 إعادة محاولة ${n} محادثة فاشلة (من الموضع ${earliest + 1})`, 'info');
    await runSendAutomation();
}

function failedList() {
    const out = [];
    for (const c of conversationQueue) {
        if (failedChats.has(c.key)) out.push({ name: c.name, reason: failReasons[c.key] || 'unknown' });
    }
    return out;
}

// ============================================
// 🎯 البدء من مكان معين
// ============================================
function applyStartPosition() {
    const startName = (settings.startFromName || '').trim();
    const skipCount = Math.max(0, parseInt(settings.skipCount, 10) || 0);

    if (startName) {
        const ns = normalizeArabic(startName);
        let idx = conversationQueue.findIndex(c => normalizeArabic(c.name) === ns);
        if (idx < 0) idx = conversationQueue.findIndex(c => normalizeArabic(c.name).includes(ns));
        if (idx >= 0) {
            queueIndex = idx;
            addLog(`🎯 البدء من المحادثة "${conversationQueue[idx].name}" (الموضع ${idx + 1} من ${conversationQueue.length})`, 'success');
            return;
        }
        addLog(`⚠️ لم يتم العثور على محادثة باسم "${startName}" في المحمّل - سيتم تجاهل هذا الإعداد`, 'warning');
    }

    if (skipCount > 0) {
        queueIndex = Math.min(skipCount, conversationQueue.length);
        addLog(`🎯 تخطي أول ${skipCount} محادثة تماماً - البدء من الموضع ${queueIndex + 1} من ${conversationQueue.length}`, 'success');
        return;
    }

    if (failedChats.size > 0) {
        let earliest = -1, retry = 0;
        for (let i = 0; i < conversationQueue.length; i++) {
            const k = conversationQueue[i].key;
            if (failedChats.has(k) && !processedChats.has(k) && SAFE_RETRY.has(failReasons[k] || 'not_found')) {
                if (earliest < 0) earliest = i;
                failedChats.delete(k); delete failReasons[k]; retry++;
            }
        }
        if (retry > 0) {
            stats.failed = Math.max(0, stats.failed - retry);
            if (earliest >= 0 && earliest < queueIndex) {
                addLog(`🔄 إعادة محاولة ${retry} محادثة فشلت سابقاً (بدءاً من الموضع ${earliest + 1})`, 'info');
                queueIndex = earliest;
            }
        }
    }

    if (queueIndex >= conversationQueue.length && conversationQueue.some(c => !processedChats.has(c.key) && !failedChats.has(c.key))) {
        queueIndex = 0;
        addLog('🔄 الموضع المحفوظ وصل النهاية - إعادة الفحص من البداية (المعالَج هيتخطى تلقائياً)', 'info');
    }
}

// ============================================
// 🛟 التعافي التلقائي: إعادة تحميل الصفحة والمتابعة بدل التوقف
// ============================================
const MAX_RECOVERIES_PER_HOUR = 6;
let RELOAD_WAIT_MS = 25000;
async function recoverByReload(reason) {
    if (!settings.autoRecover) return false;
    const now = Date.now();
    if (!recovery.start || now - recovery.start > 3600000) recovery = { count: 0, start: now };
    if (recovery.count >= MAX_RECOVERIES_PER_HOUR) return false;
    recovery.count++;
    statusNote = `تعافٍ تلقائي ${recovery.count}/${MAX_RECOVERIES_PER_HOUR}`;
    addLog(`🔁 تعافٍ تلقائي (${recovery.count}/${MAX_RECOVERIES_PER_HOUR}): ${reason} - إعادة تحميل الصفحة وسأكمل من نفس المكان`, 'warning');
    resumeSending = true;
    await closeOpenDialogs();
    await persistState();
    await flushLogs();
    try { location.reload(); } catch (e) {}
    await sleep(RELOAD_WAIT_MS);        // لو الصفحة لم تُعاد تحميلها، نكمل بدلاً من التعليق
    statusNote = '';
    return false;
}

// ============================================
// 🚀 حلقة الإرسال الرئيسية (لا تتوقف بسبب "غير موجود")
// ============================================
const RETRY_PASS_REASONS = new Set(['not_found', 'no_compose', 'no_button', 'popup_failed', 'insert_failed', 'no_send_button', 'wrong_conversation']);

async function runSendAutomation() {
    setMode('sending');
    stopSendingFlag = false;
    resumeSending = true;
    statusNote = '';
    await persistState();

    let uiFails = 0, notFoundStreak = 0, okStreak = 0;
    let reloaded = false;
    const MAX_UI = 5;

    const onSent = (entry) => {
        processedChats.add(entry.key);
        failedChats.delete(entry.key); delete failReasons[entry.key];
        stats.sent++;
        sendTimes.push(Date.now()); if (sendTimes.length > 20) sendTimes.shift();
        okStreak++;
        if (okStreak >= 5 && recovery.count) recovery.count = 0;   // رجع يشتغل كويس: صفّر العداد
        uiFails = 0; notFoundStreak = 0;
    };
    const markFail = (entry, reason) => {
        failedChats.add(entry.key); failReasons[entry.key] = reason; stats.failed++;
        okStreak = 0;
    };

    addLog(`🚀 بدء الإرسال من الموضع ${queueIndex + 1}/${conversationQueue.length} (سرعة: ${({ safe: 'آمن', normal: 'عادي', fast: 'سريع' })[settings.speed] || 'عادي'})`, 'success');
    if (!loadingComplete) addLog('⚠️ القائمة غير مؤكدة الاكتمال - سيتم الإرسال للمحمّل فقط (أعد التحميل للتحقق)', 'warning');

    outer:
    while (!isStopped()) {
        try {
            if (queueIndex >= conversationQueue.length) {
                addLog(loadingComplete ? '🏁 انتهى الطابور بالكامل!' : '⏸️ وصلنا آخر المحمّل. حمّل المزيد للمتابعة.', loadingComplete ? 'success' : 'warning');
                break;
            }
            const idx = queueIndex;
            const entry = conversationQueue[idx];

            if (processedChats.has(entry.key) || failedChats.has(entry.key)) {
                queueIndex++; stats.skipped++;
                if (stats.skipped % 25 === 0) await persistState();
                continue;
            }

            currentName = entry.name;
            addLog(`🔄 ${entry.name} (${idx + 1}/${conversationQueue.length})`, 'info');
            const res = await processEntry(entry, idx);
            if (res.status === 'stopped') break;

            if (res.status === 'sent') {
                addLog(`✅ تم الإرسال: "${entry.name}"`, 'success');
                onSent(entry);
                queueIndex++;
                await persistState();
                const d = smartDelay();
                await sleep(d + rand(0, 500));
                await maybeHumanBreak();
                continue;
            }

            const reason = res.reason || 'unknown';
            addLog(`❌ "${entry.name}": ${REASON_LABEL[reason] || reason}`, reason === 'ambiguous' ? 'warning' : 'error');

            if (reason === 'not_found') {
                notFoundStreak++;
                if (notFoundStreak >= 3) {
                    // القائمة غالباً اتغيرت/اتصفّرت: أعد تحميل الصفحة وكمّل من نفس المحادثة بدل الإيقاف
                    if (await recoverByReload('3 محادثات متتالية لم تُوجد في القائمة')) { reloaded = true; break outer; }
                    notFoundStreak = 0;
                }
            } else notFoundStreak = 0;

            markFail(entry, reason);
            queueIndex++;

            if (UI_FAIL.has(reason)) {
                uiFails++;
                if (uiFails === 3) {
                    statusNote = 'تنظيف الواجهة';
                    addLog('🧹 3 أعطال واجهة متتالية - تنظيف القوائم المفتوحة وانتظار قصير', 'warning');
                    await closeOpenDialogs();
                    await sleep(8000);
                    statusNote = '';
                }
                if (uiFails >= MAX_UI) {
                    if (await recoverByReload('أعطال واجهة متتالية')) { reloaded = true; break outer; }
                    addLog(`🛑 توقف: ${MAX_UI} أعطال واجهة متتالية وتعذّر التعافي (راجع الصفحة/عنوان الرد المحفوظ)`, 'error');
                    break;
                }
            } else uiFails = 0;

            await persistState();
            await closeOpenDialogs();
            await rd(900, 1600);
        } catch (error) {
            addLog(`💥 خطأ: ${error.message}`, 'error');
            uiFails++;
            if (uiFails >= MAX_UI) {
                if (await recoverByReload('أخطاء متتالية')) { reloaded = true; break; }
                break;
            }
            await randomDelay(2500, 4000);
        }
    }
    if (reloaded) return;

    // ---- جولة إعادة تلقائية للفاشلين بأسباب مؤقتة ----
    if (!isStopped() && queueIndex >= conversationQueue.length) {
        const retry = [];
        conversationQueue.forEach((c, i) => {
            if (failedChats.has(c.key) && !processedChats.has(c.key) && RETRY_PASS_REASONS.has(failReasons[c.key])) retry.push([c, i]);
        });
        if (retry.length) {
            addLog(`🔁 جولة إعادة تلقائية لـ ${retry.length} محادثة فشلت لأسباب مؤقتة`, 'info');
            let fails = 0;
            for (const [c, i] of retry) {
                if (isStopped() || fails >= 3) break;
                currentName = c.name;
                const res = await processEntry(c, i);
                if (res.status === 'sent') {
                    stats.failed = Math.max(0, stats.failed - 1);
                    addLog(`✅ نجحت الإعادة: "${c.name}"`, 'success');
                    onSent(c);
                    await persistState();
                    const d = smartDelay();
                    await sleep(d + rand(0, 500));
                } else if (res.status === 'fail') {
                    failReasons[c.key] = res.reason || failReasons[c.key];
                    fails++;
                    await closeOpenDialogs();
                }
            }
        }
    }

    resumeSending = false;
    currentName = ''; statusNote = '';
    addLog(`📊 تقرير: ✅${stats.sent} | ❌${stats.failed} | ⏭️${stats.skipped}`, stats.failed > 0 ? 'warning' : 'success');
    if (failedChats.size > 0) addLog(`🧾 أسباب الفشل: ${reasonsSummary()}`, 'warning');

    setMode('idle');
    await persistState();
    await flushLogs();
}

// ============================================
// ✨ الواجهة الجديدة (v8.2): حلقة تقدم + تبويبات + ثيم فاتح/غامق
//    قابلة للسحب والتكبير والتصغير والطي، وتحفظ وضعها
// ============================================
const WIDGET_ID = 'fbsr-widget-host';
const UI_KEY = 'widgetUI';
let _resizeBound = false;

function shouldShowWidget() {
    return location.hostname.includes('facebook.com') && location.pathname.includes('/latest/inbox');
}

const I = {
    load: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>',
    min: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    theme: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
};

const WIDGET_HTML = `
<style>
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, system-ui, -apple-system, sans-serif; }
    button, input { font: inherit; color: inherit; }

    .widget {
        --bg: rgba(14, 16, 22, .92); --surface: rgba(255,255,255,.055); --surface2: rgba(255,255,255,.09);
        --line: rgba(255,255,255,.09); --text: #eef0f5; --muted: #8e94a3; --track: rgba(255,255,255,.1);
        --accent: #7c8cff; --accent2: #35d0ba; --ok: #34d17b; --bad: #ff6b6b; --warn: #f5b942; --info: #6aa8ff;
        --shadow: 0 18px 48px rgba(0,0,0,.5), 0 2px 10px rgba(0,0,0,.35);
        position: relative; width: var(--w, 320px);
        background: var(--bg); backdrop-filter: blur(22px) saturate(1.5); -webkit-backdrop-filter: blur(22px) saturate(1.5);
        border: 1px solid var(--line); border-radius: 20px; box-shadow: var(--shadow);
        color: var(--text); direction: rtl; display: flex; flex-direction: column; overflow: hidden;
        font-size: 12px;
    }
    .widget[data-theme="light"] {
        --bg: rgba(255,255,255,.94); --surface: rgba(20,24,40,.045); --surface2: rgba(20,24,40,.08);
        --line: rgba(20,24,40,.1); --text: #161a28; --muted: #6a7184; --track: rgba(20,24,40,.1);
        --accent: #5b6cf0; --accent2: #12b5a0; --ok: #16a860; --bad: #e5484d; --warn: #d98a00; --info: #2f7de1;
        --shadow: 0 16px 40px rgba(20,24,40,.2), 0 2px 8px rgba(20,24,40,.12);
    }
    .widget.fixedh { height: var(--h, 520px); }
    .widget[hidden], .pill[hidden] { display: none; }

    /* ---------- الرأس ---------- */
    .head { display: flex; align-items: center; gap: 8px; padding: 11px 12px 9px; cursor: grab; user-select: none; touch-action: none; flex-shrink: 0; }
    .head:active { cursor: grabbing; }
    .logo { width: 26px; height: 26px; border-radius: 9px; flex-shrink: 0; display: grid; place-items: center;
        background: linear-gradient(135deg, var(--accent), var(--accent2)); box-shadow: 0 4px 14px rgba(124,140,255,.4); }
    .logo svg { width: 14px; height: 14px; color: #fff; }
    .title { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.2; }
    .title b { font-size: 12.5px; font-weight: 700; letter-spacing: .1px; }
    .title span { font-size: 9.5px; color: var(--muted); }
    .chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 99px; font-size: 10px; font-weight: 700;
        background: var(--surface2); color: var(--muted); white-space: nowrap; flex-shrink: 0; transition: all .25s; }
    .chip i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .chip.idle { color: var(--muted); }
    .chip.loading { color: var(--warn); background: color-mix(in srgb, var(--warn) 16%, transparent); }
    .chip.sending { color: var(--ok); background: color-mix(in srgb, var(--ok) 16%, transparent); }
    .chip.recover { color: var(--info); background: color-mix(in srgb, var(--info) 16%, transparent); }
    .chip.loading i, .chip.sending i, .chip.recover i { animation: pulse 1.3s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .35; transform: scale(.7); } }

    .ib { width: 26px; height: 26px; border: 0; border-radius: 9px; background: transparent; color: var(--muted); cursor: pointer;
        display: grid; place-items: center; flex-shrink: 0; transition: background .2s, color .2s, transform .25s; }
    .ib:hover { background: var(--surface2); color: var(--text); }
    .ib svg { width: 14px; height: 14px; transition: transform .3s; }
    .widget.collapsed #wCollapse svg { transform: rotate(180deg); }

    .slim { height: 3px; background: var(--track); flex-shrink: 0; overflow: hidden; }
    .slim > div { height: 100%; width: 0; background: linear-gradient(90deg, var(--accent), var(--accent2)); transition: width .5s ease; }
    .slim.busy > div { width: 35% !important; animation: slide 1.4s ease-in-out infinite alternate; }
    @keyframes slide { from { transform: translateX(190%); } to { transform: translateX(-20%); } }

    /* ---------- المحتوى ---------- */
    .content { display: flex; flex-direction: column; gap: 10px; padding: 12px; flex: 1; min-height: 0; overflow: hidden; }
    .widget.collapsed .content, .widget.collapsed .grip { display: none; }

    .hero { display: flex; align-items: center; gap: 14px; flex-shrink: 0; }
    .ring { position: relative; width: 84px; height: 84px; flex-shrink: 0; }
    .ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
    .ring .bg { fill: none; stroke: var(--track); stroke-width: 7; }
    .ring .fg { fill: none; stroke: url(#grad); stroke-width: 7; stroke-linecap: round; stroke-dasharray: 226.2; stroke-dashoffset: 226.2; transition: stroke-dashoffset .6s cubic-bezier(.4,0,.2,1); }
    .ring .pct { position: absolute; inset: 0; display: grid; place-items: center; font-size: 19px; font-weight: 800; letter-spacing: -.5px; }
    .ring .pct small { font-size: 10px; font-weight: 600; color: var(--muted); margin-right: 1px; }
    .hmeta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .big { font-size: 22px; font-weight: 800; line-height: 1.05; letter-spacing: -.5px; }
    .big span { font-size: 12px; font-weight: 600; color: var(--muted); letter-spacing: 0; }
    .sub { font-size: 10.5px; color: var(--muted); display: flex; align-items: center; gap: 5px; }
    .sub b { color: var(--text); font-weight: 700; }
    .badge { display: inline-flex; align-items: center; gap: 4px; font-size: 9.5px; font-weight: 700; padding: 2px 8px; border-radius: 99px; width: fit-content; }
    .badge.ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 15%, transparent); }
    .badge.warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 15%, transparent); }

    .now { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 12px; background: var(--surface); flex-shrink: 0; min-height: 34px; }
    .now .dotp { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex-shrink: 0; }
    .now.active .dotp { background: var(--ok); box-shadow: 0 0 0 4px color-mix(in srgb, var(--ok) 20%, transparent); animation: pulse 1.3s ease-in-out infinite; }
    .now .t { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; }
    .now .t small { color: var(--muted); font-size: 10px; margin-left: 4px; }

    .actions { display: grid; grid-template-columns: 1fr 1.25fr .8fr; gap: 7px; flex-shrink: 0; }
    .btn { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 6px; border: 0; border-radius: 12px;
        font-size: 11.5px; font-weight: 700; cursor: pointer; color: #fff; transition: transform .15s, opacity .2s, filter .2s; }
    .btn svg { width: 14px; height: 14px; }
    .btn:hover:not(:disabled) { filter: brightness(1.12); }
    .btn:active:not(:disabled) { transform: scale(.96); }
    .btn:disabled { opacity: .32; cursor: not-allowed; }
    .b-load { background: linear-gradient(135deg, #4f7cff, #3a5bd9); }
    .b-send { background: linear-gradient(135deg, #1fc77a, #10a566); box-shadow: 0 6px 16px rgba(31,199,122,.3); }
    .b-stop { background: linear-gradient(135deg, #ff6b6b, #e0484d); }
    .b-ghost { background: var(--surface2); color: var(--text); }
    .b-danger { background: color-mix(in srgb, var(--bad) 16%, transparent); color: var(--bad); }

    .tabs { display: flex; gap: 3px; padding: 3px; border-radius: 12px; background: var(--surface); flex-shrink: 0; }
    .tab { flex: 1; padding: 6px 2px; border: 0; border-radius: 9px; background: transparent; color: var(--muted); font-size: 10.5px; font-weight: 700; cursor: pointer; transition: all .2s; position: relative; }
    .tab:hover { color: var(--text); }
    .tab.on { background: var(--surface2); color: var(--text); box-shadow: 0 1px 4px rgba(0,0,0,.2); }
    .tab .n { display: inline-block; min-width: 15px; padding: 0 4px; margin-right: 3px; border-radius: 99px; font-size: 9px; background: color-mix(in srgb, var(--bad) 22%, transparent); color: var(--bad); }

    .pane { display: none; flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 6px; }
    .pane.on { display: flex; flex-direction: column; gap: 8px; }
    .pane::-webkit-scrollbar, .list::-webkit-scrollbar { width: 4px; }
    .pane::-webkit-scrollbar-thumb, .list::-webkit-scrollbar-thumb { background: var(--track); border-radius: 4px; }

    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
    .card { padding: 10px 11px; border-radius: 13px; background: var(--surface); display: flex; flex-direction: column; gap: 5px; }
    .card .k { font-size: 10px; color: var(--muted); font-weight: 600; }
    .card .v { font-size: 20px; font-weight: 800; letter-spacing: -.5px; line-height: 1; }
    .card .bar { height: 3px; border-radius: 3px; background: var(--track); overflow: hidden; }
    .card .bar i { display: block; height: 100%; width: 0; border-radius: 3px; transition: width .5s; }
    .c-ok .v { color: var(--ok); } .c-ok .bar i { background: var(--ok); }
    .c-bad .v { color: var(--bad); } .c-bad .bar i { background: var(--bad); }
    .c-warn .v { color: var(--warn); } .c-warn .bar i { background: var(--warn); }
    .c-info .v { color: var(--info); } .c-info .bar i { background: var(--info); }
    .note { font-size: 10px; color: var(--muted); line-height: 1.55; padding: 0 2px; }

    .filters { display: flex; gap: 5px; flex-shrink: 0; }
    .f { padding: 3px 10px; border: 0; border-radius: 99px; background: var(--surface); color: var(--muted); font-size: 10px; font-weight: 700; cursor: pointer; }
    .f.on { background: var(--accent); color: #fff; }
    .list { flex: 1; min-height: 60px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
    .le { font-size: 10.5px; line-height: 1.5; padding: 5px 9px; border-radius: 8px; background: var(--surface); border-right: 3px solid var(--track); word-break: break-word; color: var(--muted); }
    .le.success { border-color: var(--ok); color: var(--text); } .le.error { border-color: var(--bad); color: var(--text); } .le.warning { border-color: var(--warn); color: var(--text); }
    .empty { text-align: center; color: var(--muted); font-size: 11px; padding: 22px 8px; }

    .fchips { display: flex; flex-wrap: wrap; gap: 5px; flex-shrink: 0; }
    .fc { font-size: 10px; padding: 3px 9px; border-radius: 99px; background: color-mix(in srgb, var(--bad) 14%, transparent); color: var(--bad); font-weight: 700; }
    .fi { display: flex; justify-content: space-between; gap: 8px; font-size: 10.5px; padding: 6px 9px; border-radius: 8px; background: var(--surface); }
    .fi span:first-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fi span:last-child { color: var(--muted); font-size: 9.5px; white-space: nowrap; }
    .row2 { display: flex; gap: 7px; flex-shrink: 0; }

    .field { display: flex; flex-direction: column; gap: 4px; }
    .field label { font-size: 10px; color: var(--muted); font-weight: 700; }
    .field input[type=text], .field input[type=number] { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; font-size: 11.5px; outline: none; transition: border-color .2s, box-shadow .2s; width: 100%; }
    .field input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
    .field input::placeholder { color: var(--muted); opacity: .6; }
    .hint { font-size: 9.5px; color: var(--muted); line-height: 1.5; }
    .seg { display: flex; gap: 3px; padding: 3px; border-radius: 11px; background: var(--surface); }
    .seg button { flex: 1; padding: 6px 2px; border: 0; border-radius: 8px; background: transparent; color: var(--muted); font-size: 10.5px; font-weight: 700; cursor: pointer; }
    .seg button.on { background: var(--accent); color: #fff; }
    .sw { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; border-radius: 11px; background: var(--surface); cursor: pointer; }
    .sw div { display: flex; flex-direction: column; gap: 1px; }
    .sw b { font-size: 11px; font-weight: 700; } .sw small { font-size: 9.5px; color: var(--muted); }
    .sw input { display: none; }
    .sw .tg { width: 34px; height: 20px; border-radius: 99px; background: var(--track); position: relative; flex-shrink: 0; transition: background .25s; }
    .sw .tg::after { content: ''; position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .25s; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
    .sw input:checked + .tg { background: var(--ok); }
    .sw input:checked + .tg::after { transform: translateX(-14px); }

    .toast { position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%) translateY(20px); background: var(--text); color: var(--bg); padding: 6px 14px; border-radius: 99px; font-size: 10.5px; font-weight: 700; opacity: 0; pointer-events: none; transition: all .3s; z-index: 5; }
    .toast.show { opacity: .95; transform: translateX(-50%) translateY(0); }

    .grip { position: absolute; bottom: 0; width: 20px; height: 20px; z-index: 3; touch-action: none; opacity: .5; transition: opacity .2s; }
    .grip:hover { opacity: 1; }
    .grip.r { right: 0; cursor: nwse-resize; background: linear-gradient(135deg, transparent 55%, var(--muted) 55%, var(--muted) 63%, transparent 63%, transparent 72%, var(--muted) 72%, var(--muted) 80%, transparent 80%); border-bottom-right-radius: 20px; }
    .grip.l { left: 0; cursor: nesw-resize; background: linear-gradient(225deg, transparent 55%, var(--muted) 55%, var(--muted) 63%, transparent 63%, transparent 72%, var(--muted) 72%, var(--muted) 80%, transparent 80%); border-bottom-left-radius: 20px; }

    .pill { display: flex; align-items: center; gap: 9px; padding: 8px 14px 8px 12px; border-radius: 99px; direction: rtl; cursor: grab; user-select: none; touch-action: none;
        background: var(--bg, rgba(14,16,22,.92)); border: 1px solid rgba(255,255,255,.12); box-shadow: 0 10px 28px rgba(0,0,0,.45); color: #eef0f5; font-size: 11.5px; font-weight: 700; backdrop-filter: blur(16px); }
    .pill .pd { width: 8px; height: 8px; border-radius: 50%; background: #8e94a3; }
    .pill .pd.sending { background: #34d17b; animation: pulse 1.3s infinite; } .pill .pd.loading { background: #f5b942; animation: pulse 1.1s infinite; } .pill .pd.recover { background: #6aa8ff; animation: pulse 1s infinite; }
</style>

<div class="widget" id="widget" data-theme="dark">
    <div class="head" id="wHead" title="اسحب لتحريك الويدجيت">
        <div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 20l1.2-4.8A8.4 8.4 0 1 1 21 11.5z"/></svg></div>
        <div class="title"><b>FB Responder</b><span id="wSub">v8.2 · جاهز</span></div>
        <span class="chip idle" id="wChip"><i></i><em id="wChipT" style="font-style:normal">جاهز</em></span>
        <button class="ib" id="wTheme" title="تبديل الثيم">${I.theme}</button>
        <button class="ib" id="wCollapse" title="طي / فتح">${I.chev}</button>
        <button class="ib" id="wMin" title="تصغير لزر عائم">${I.min}</button>
    </div>
    <div class="slim" id="wSlim"><div id="wSlimFill"></div></div>

    <div class="content" id="wContent">
        <div class="hero">
            <div class="ring">
                <svg viewBox="0 0 84 84"><defs><linearGradient id="grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c8cff"/><stop offset="1" stop-color="#35d0ba"/></linearGradient></defs>
                    <circle class="bg" cx="42" cy="42" r="36"/><circle class="fg" id="wRing" cx="42" cy="42" r="36"/></svg>
                <div class="pct"><span id="wPct">0</span><small>%</small></div>
            </div>
            <div class="hmeta">
                <div class="big"><span id="wDone">0</span> <span>/ <span id="wTotal">0</span></span></div>
                <div class="sub" id="wRate">السرعة: <b>—</b></div>
                <div class="sub" id="wEta">المتبقي: <b>—</b></div>
                <span class="badge warn" id="wVerify">لم يتم التحميل بعد</span>
            </div>
        </div>

        <div class="now" id="wNow"><span class="dotp"></span><div class="t" id="wNowT">في انتظار الأوامر</div></div>

        <div class="actions">
            <button class="btn b-load" id="wLoadBtn" disabled>${I.load}<span>تحميل</span></button>
            <button class="btn b-send" id="wSendBtn" disabled>${I.send}<span>إرسال</span></button>
            <button class="btn b-stop" id="wStopBtn" disabled>${I.stop}<span>إيقاف</span></button>
        </div>

        <div class="tabs" id="wTabs">
            <button class="tab on" data-tab="ov">نظرة</button>
            <button class="tab" data-tab="log">السجل</button>
            <button class="tab" data-tab="fail">الأعطال<span class="n" id="wFailN" hidden>0</span></button>
            <button class="tab" data-tab="set">الإعدادات</button>
        </div>

        <div class="pane on" id="pane-ov">
            <div class="grid">
                <div class="card c-ok"><span class="k">ناجح</span><span class="v" id="wSent">0</span><div class="bar"><i id="wBarSent"></i></div></div>
                <div class="card c-bad"><span class="k">فاشل</span><span class="v" id="wFailed">0</span><div class="bar"><i id="wBarFail"></i></div></div>
                <div class="card c-warn"><span class="k">متخطى</span><span class="v" id="wSkipped">0</span><div class="bar"><i id="wBarSkip"></i></div></div>
                <div class="card c-info"><span class="k">محمّل</span><span class="v" id="wLoaded">0</span><div class="bar"><i id="wBarLoad"></i></div></div>
            </div>
            <div class="note" id="wNote"></div>
        </div>

        <div class="pane" id="pane-log">
            <div class="filters" id="wFilters">
                <button class="f on" data-f="all">الكل</button><button class="f" data-f="ok">نجاح</button><button class="f" data-f="bad">أخطاء</button>
            </div>
            <div class="list" id="wLog"></div>
        </div>

        <div class="pane" id="pane-fail">
            <div class="fchips" id="wFchips"></div>
            <div class="row2">
                <button class="btn b-ghost" id="wRetryBtn" style="flex:1">${I.retry}<span>إعادة محاولة الفاشلين</span></button>
                <button class="btn b-ghost" id="wCopyBtn" style="flex:.7">${I.copy}<span>نسخ</span></button>
            </div>
            <div class="list" id="wFailList"></div>
        </div>

        <div class="pane" id="pane-set">
            <div class="field"><label>عنوان الرد المحفوظ (مطابقة حرفية)</label><input type="text" id="wReplyTitle" placeholder="BM AUTO" /></div>
            <div class="field"><label>السرعة</label>
                <div class="seg" id="wSpeed"><button data-s="safe">آمن</button><button data-s="normal" class="on">عادي</button><button data-s="fast">سريع</button></div>
                <span class="hint">السريع يقلل التأخير بين الرسائل - يزيد احتمال تقييد فيسبوك للحساب، والعادي هو الموصى به.</span>
            </div>
            <label class="sw"><div><b>تعافٍ تلقائي</b><small>لو القائمة اتغيرت أو الواجهة علقت: إعادة تحميل الصفحة بدل الإيقاف</small></div><input type="checkbox" id="wAutoRecover" checked><span class="tg"></span></label>
            <label class="sw"><div><b>استئناف تلقائي</b><small>يكمل الإرسال لوحده بعد إعادة تحميل الصفحة</small></div><input type="checkbox" id="wAutoResume" checked><span class="tg"></span></label>
            <div class="field"><label>تخطي أول (عدد) محادثة</label><input type="number" id="wSkipCount" min="0" placeholder="0" /><span class="hint">مثال: 100 = يتجاهل أول 100 ويبدأ من 101</span></div>
            <div class="field"><label>أو البدء من محادثة اسمها</label><input type="text" id="wStartFrom" placeholder="اترك فارغاً للبدء من الأول" /></div>
            <button class="btn b-danger" id="wResetBtn">إعادة ضبط كاملة</button>
        </div>
    </div>

    <div class="toast" id="wToast"></div>
    <div class="grip l" id="wGripL" title="اسحب لتغيير الحجم"></div>
    <div class="grip r" id="wGripR" title="اسحب لتغيير الحجم"></div>
</div>

<div class="pill" id="wPill" hidden title="اضغط للفتح - اسحب للتحريك"><span class="pd" id="wPillDot"></span><span id="wPillText">FB Bot</span></div>`;

async function initWidget() {
    if (!isAlive()) return;
    if (document.getElementById(WIDGET_ID)) return;
    if (!shouldShowWidget()) return;

    let saved = null;
    try { saved = (await chrome.storage.local.get(UI_KEY))[UI_KEY]; } catch (e) {}
    if (document.getElementById(WIDGET_ID)) return;

    const host = document.createElement('div');
    host.id = WIDGET_ID;
    host.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;direction:rtl;';
    document.documentElement.appendChild(host);

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = WIDGET_HTML;
    const $ = (id) => root.getElementById(id);
    const widget = $('widget'), pill = $('wPill'), head = $('wHead');
    ['keydown', 'keyup', 'keypress'].forEach(ev => root.addEventListener(ev, e => e.stopPropagation()));

    // ---------- حالة الواجهة ----------
    const ui = Object.assign({ x: null, y: 14, w: 320, h: 540, collapsed: false, min: false, tab: 'ov', theme: 'dark' }, saved || {});
    if (typeof ui.x !== 'number') ui.x = Math.max(8, window.innerWidth - ui.w - 14);
    const maxW = () => Math.min(680, window.innerWidth - 16);
    const maxH = () => Math.min(860, window.innerHeight - 24);
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    let saveTimer = null;
    function saveUI(now) {
        const run = () => { try { chrome.storage.local.set({ [UI_KEY]: ui }); } catch (e) {} };
        if (now) { run(); return; }
        clearTimeout(saveTimer); saveTimer = setTimeout(run, 300);
    }
    function place() {
        ui.w = clamp(ui.w, 260, maxW());
        ui.h = clamp(ui.h, 300, maxH());
        const curW = ui.min ? (pill.getBoundingClientRect().width || 100) : ui.w;
        ui.x = clamp(ui.x, 60 - curW, window.innerWidth - 60);
        ui.y = clamp(ui.y, 0, window.innerHeight - 40);
        host.style.left = ui.x + 'px'; host.style.top = ui.y + 'px';
        widget.style.setProperty('--w', ui.w + 'px');
        widget.style.setProperty('--h', ui.h + 'px');
    }
    function applyUI() {
        widget.hidden = ui.min; pill.hidden = !ui.min;
        widget.classList.toggle('collapsed', ui.collapsed);
        widget.classList.toggle('fixedh', !ui.collapsed);
        widget.dataset.theme = ui.theme;
        root.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === ui.tab));
        root.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + ui.tab));
        place();
        lastFailKey = ''; lastLogKey = '';
    }

    // ---------- السحب ----------
    function enableDrag(handle, ignoreSel, onTap) {
        let st = null;
        handle.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            if (ignoreSel && e.target.closest(ignoreSel)) return;
            st = { sx: e.clientX, sy: e.clientY, x: ui.x, y: ui.y, moved: false };
            try { handle.setPointerCapture(e.pointerId); } catch (err) {}
            e.preventDefault();
        });
        handle.addEventListener('pointermove', (e) => {
            if (!st) return;
            const dx = e.clientX - st.sx, dy = e.clientY - st.sy;
            if (!st.moved && Math.hypot(dx, dy) < 4) return;
            st.moved = true; ui.x = st.x + dx; ui.y = st.y + dy; place();
        });
        const end = (e) => {
            if (!st) return;
            const s = st; st = null;
            try { handle.releasePointerCapture(e.pointerId); } catch (err) {}
            if (s.moved) saveUI(); else if (onTap) onTap(e);
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    }
    enableDrag(head, 'button', null);
    enableDrag(pill, null, () => { ui.min = false; applyUI(); saveUI(); });
    head.addEventListener('dblclick', (e) => { if (e.target.closest('button')) return; ui.min = true; applyUI(); saveUI(); });

    // ---------- تغيير الحجم ----------
    function enableResize(grip, side) {
        let st = null;
        grip.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            st = { sx: e.clientX, sy: e.clientY, x: ui.x, w: ui.w, h: ui.h };
            try { grip.setPointerCapture(e.pointerId); } catch (err) {}
            e.preventDefault(); e.stopPropagation();
        });
        grip.addEventListener('pointermove', (e) => {
            if (!st) return;
            const dx = e.clientX - st.sx, dy = e.clientY - st.sy;
            if (side === 'r') ui.w = clamp(st.w + dx, 260, maxW());
            else { const w = clamp(st.w - dx, 260, maxW()); ui.x = st.x + (st.w - w); ui.w = w; }
            if (!ui.collapsed) ui.h = clamp(st.h + dy, 300, maxH());
            place();
        });
        const end = (e) => { if (!st) return; st = null; try { grip.releasePointerCapture(e.pointerId); } catch (err) {} saveUI(); };
        grip.addEventListener('pointerup', end);
        grip.addEventListener('pointercancel', end);
    }
    enableResize($('wGripR'), 'r');
    enableResize($('wGripL'), 'l');

    if (!_resizeBound) {
        _resizeBound = true;
        window.addEventListener('resize', () => { const h = document.getElementById(WIDGET_ID); if (h && h._fbsrPlace) h._fbsrPlace(); });
    }
    host._fbsrPlace = place;

    // ---------- أدوات صغيرة ----------
    const txt = (el, v) => { v = String(v); if (el.textContent !== v) el.textContent = v; };
    let toastT = null;
    function toast(msg) {
        const t = $('wToast'); t.textContent = msg; t.classList.add('show');
        clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800);
    }

    // ---------- الإعدادات ----------
    const wReplyTitle = $('wReplyTitle'), wSkipCount = $('wSkipCount'), wStartFrom = $('wStartFrom');
    const wAutoRecover = $('wAutoRecover'), wAutoResume = $('wAutoResume');
    function fillSettings() {
        wReplyTitle.value = settings.savedReplyTitle || 'BM AUTO';
        wSkipCount.value = settings.skipCount || 0;
        wStartFrom.value = settings.startFromName || '';
        wAutoRecover.checked = settings.autoRecover !== false;
        wAutoResume.checked = settings.autoResume !== false;
        root.querySelectorAll('#wSpeed button').forEach(b => b.classList.toggle('on', b.dataset.s === (settings.speed || 'normal')));
    }
    function saveWidgetSettings() {
        settings.savedReplyTitle = wReplyTitle.value.trim() || 'BM AUTO';
        settings.skipCount = Math.max(0, parseInt(wSkipCount.value, 10) || 0);
        settings.startFromName = wStartFrom.value.trim();
        settings.autoRecover = wAutoRecover.checked;
        settings.autoResume = wAutoResume.checked;
        try { chrome.storage.local.set({ botSettings: settings }); } catch (e) {}
    }
    fillSettings();
    [wReplyTitle, wSkipCount, wStartFrom].forEach(i => { i.addEventListener('change', saveWidgetSettings); i.addEventListener('blur', saveWidgetSettings); });
    [wAutoRecover, wAutoResume].forEach(i => i.addEventListener('change', saveWidgetSettings));
    root.querySelectorAll('#wSpeed button').forEach(b => b.addEventListener('click', () => {
        settings.speed = b.dataset.s; scheduleBreak();
        fillSettings(); saveWidgetSettings();
    }));

    // ---------- أزرار الرأس والتبويبات ----------
    $('wCollapse').addEventListener('click', () => { ui.collapsed = !ui.collapsed; applyUI(); saveUI(); });
    $('wMin').addEventListener('click', () => { ui.min = true; applyUI(); saveUI(); });
    $('wTheme').addEventListener('click', () => { ui.theme = ui.theme === 'dark' ? 'light' : 'dark'; applyUI(); saveUI(); });
    root.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => { ui.tab = t.dataset.tab; applyUI(); saveUI(); updateWidget(); }));

    let logFilter = 'all';
    root.querySelectorAll('#wFilters .f').forEach(f => f.addEventListener('click', () => {
        logFilter = f.dataset.f;
        root.querySelectorAll('#wFilters .f').forEach(x => x.classList.toggle('on', x === f));
        lastLogKey = ''; updateWidget();
    }));

    // ---------- أزرار التحكم ----------
    $('wLoadBtn').addEventListener('click', () => { saveWidgetSettings(); loadOnlyFlow(); });
    $('wSendBtn').addEventListener('click', () => { saveWidgetSettings(); sendOnlyFlow(); });
    $('wStopBtn').addEventListener('click', () => stopAll());
    $('wRetryBtn').addEventListener('click', () => { saveWidgetSettings(); retryFailedFlow(); });
    $('wCopyBtn').addEventListener('click', async () => {
        const lines = failedList().map(f => `${f.name}\t${REASON_LABEL[f.reason] || f.reason}`).join('\n');
        if (!lines) { toast('لا يوجد فاشلون'); return; }
        try { await navigator.clipboard.writeText(lines); toast('تم نسخ القائمة'); }
        catch (e) {
            const ta = document.createElement('textarea'); ta.value = lines; document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); toast('تم نسخ القائمة'); } catch (e2) { toast('تعذّر النسخ'); }
            ta.remove();
        }
    });
    $('wResetBtn').addEventListener('click', async () => {
        if (!confirm('هترجع الإضافة زي أول ما ثبّتها (مسح كل البيانات). متأكد؟')) return;
        await resetAll();
        try { await chrome.storage.local.clear(); } catch (e) {}
        settings = { savedReplyTitle: 'BM AUTO', skipCount: 0, startFromName: '', speed: 'normal', autoRecover: true, autoResume: true };
        fillSettings(); saveWidgetSettings(); saveUI(true);
    });

    // ---------- التحديث الدوري ----------
    let lastLogKey = '', lastFailKey = '';
    const fmtDur = (min) => {
        if (!isFinite(min) || min <= 0) return '—';
        if (min < 1) return 'أقل من دقيقة';
        if (min < 60) return `${Math.round(min)} د`;
        const h = Math.floor(min / 60), m = Math.round(min % 60);
        return `${h} س ${m} د`;
    };
    function rateInfo() {
        if (sendTimes.length < 3) return { perMin: 0 };
        const span = (sendTimes[sendTimes.length - 1] - sendTimes[0]) / 60000;
        return { perMin: span > 0 ? (sendTimes.length - 1) / span : 0 };
    }

    function updateWidget() {
        if (!isAlive()) { clearInterval(timer); host.remove(); return; }
        const loaded = conversationQueue.length;
        const done = Math.min(queueIndex, loaded);
        const pct = loaded > 0 ? Math.round((done / loaded) * 100) : 0;
        const remaining = Math.max(0, loaded - done);
        const { perMin } = rateInfo();

        txt($('wDone'), done); txt($('wTotal'), loaded); txt($('wPct'), pct);
        $('wRing').style.strokeDashoffset = String(226.2 * (1 - pct / 100));
        $('wSlimFill').style.width = pct + '%';

        txt($('wSent'), stats.sent); txt($('wFailed'), stats.failed); txt($('wSkipped'), stats.skipped); txt($('wLoaded'), loaded);
        const tot = Math.max(loaded, 1);
        $('wBarSent').style.width = Math.min(100, stats.sent / tot * 100) + '%';
        $('wBarFail').style.width = Math.min(100, stats.failed / tot * 100) + '%';
        $('wBarSkip').style.width = Math.min(100, stats.skipped / tot * 100) + '%';
        $('wBarLoad').style.width = loaded > 0 ? '100%' : '0%';

        $('wRate').innerHTML = `السرعة: <b>${perMin > 0 ? perMin.toFixed(1) + ' / د' : '—'}</b>`;
        $('wEta').innerHTML = `المتبقي: <b>${remaining}</b>${perMin > 0 && currentMode === 'sending' ? ' · ' + fmtDur(remaining / perMin) : ''}`;

        const vb = $('wVerify');
        if (loaded === 0) { vb.className = 'badge warn'; txt(vb, 'لم يتم التحميل بعد'); }
        else if (loadingComplete) { vb.className = 'badge ok'; txt(vb, '✔ القائمة مكتملة ومتحقق منها'); }
        else { vb.className = 'badge warn'; txt(vb, '⚠ غير مؤكدة الاكتمال'); }

        // الحالة
        const chip = $('wChip'), now = $('wNow');
        let chipCls = 'idle', chipTxt = 'جاهز', sub = 'جاهز', nowTxt = 'في انتظار الأوامر', active = false;
        const busy = currentMode !== 'idle';
        if (!initialized) { chipCls = 'loading'; chipTxt = 'تهيئة'; sub = 'استرجاع الحالة...'; nowTxt = 'استرجاع الحالة المحفوظة...'; }
        else if (statusNote) { chipCls = 'recover'; chipTxt = 'تعافٍ'; sub = statusNote; nowTxt = statusNote; active = true; }
        else if (currentMode === 'loading') { chipCls = 'loading'; chipTxt = 'يحمّل'; sub = `تحميل ${loaded} محادثة`; nowTxt = `جاري تحميل القائمة... ${loaded} محادثة`; active = true; }
        else if (currentMode === 'sending') { chipCls = 'sending'; chipTxt = 'يرسل'; sub = `${done} من ${loaded}`; nowTxt = currentName || 'جاري الإرسال...'; active = true; }
        else if (loaded > 0) { chipTxt = 'متوقف'; sub = `متوقف عند ${done} من ${loaded}`; nowTxt = remaining > 0 ? `جاهز للمتابعة - المتبقي ${remaining}` : 'اكتملت القائمة'; }
        chip.className = 'chip ' + chipCls; txt($('wChipT'), chipTxt); txt($('wSub'), 'v8.2 · ' + sub);
        now.classList.toggle('active', active);
        $('wNowT').innerHTML = '';
        const nt = $('wNowT'); nt.textContent = nowTxt;
        $('wSlim').classList.toggle('busy', currentMode === 'loading');

        $('wLoadBtn').disabled = !initialized || busy;
        $('wSendBtn').disabled = !initialized || busy || loaded === 0;
        $('wStopBtn').disabled = !initialized || !busy;

        const fn = $('wFailN');
        fn.hidden = stats.failed === 0 && failedChats.size === 0;
        txt(fn, failedChats.size);

        txt($('wPillText'), busy ? (currentMode === 'loading' ? `تحميل ${loaded}` : `${done}/${loaded}`) : (loaded ? `${done}/${loaded}` : 'FB Bot'));
        $('wPillDot').className = 'pd ' + (statusNote ? 'recover' : currentMode === 'sending' ? 'sending' : currentMode === 'loading' ? 'loading' : '');

        // ملاحظة النظرة العامة
        const parts = [];
        if (loadInfo.virtual) parts.push('القائمة بتحمّل تدريجياً (تم التعامل معها تلقائياً)');
        if (loadInfo.nameOnly > 0) parts.push(`${loadInfo.nameOnly} محادثة بدون معرّف فريد`);
        if (recovery.count > 0) parts.push(`تعافي تلقائي: ${recovery.count}/${MAX_RECOVERIES_PER_HOUR} هذه الساعة`);
        txt($('wNote'), parts.join(' · '));

        // السجل
        if (ui.tab === 'log' && !ui.collapsed) {
            const key = logFilter + '|' + recentLogs.length + '|' + (recentLogs.length ? recentLogs[recentLogs.length - 1].message : '');
            if (key !== lastLogKey) {
                lastLogKey = key;
                const list = $('wLog'); list.innerHTML = '';
                const items = recentLogs.filter(l => logFilter === 'all' || (logFilter === 'ok' ? l.type === 'success' : (l.type === 'error' || l.type === 'warning')));
                if (!items.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'لا توجد سجلات'; list.appendChild(e); }
                for (const l of items.slice(-40)) {
                    const d = document.createElement('div'); d.className = 'le ' + (l.type || 'info'); d.textContent = l.message; list.appendChild(d);
                }
                list.scrollTop = list.scrollHeight;
            }
        }
        // الأعطال
        if (ui.tab === 'fail' && !ui.collapsed) {
            const key = failedChats.size + '|' + stats.failed + '|' + currentMode;
            if (key !== lastFailKey) {
                lastFailKey = key;
                const chips = $('wFchips'), list = $('wFailList');
                chips.innerHTML = ''; list.innerHTML = '';
                const fl = failedList();
                const counts = {};
                fl.forEach(f => { counts[f.reason] = (counts[f.reason] || 0) + 1; });
                Object.entries(counts).forEach(([r, n]) => { const c = document.createElement('span'); c.className = 'fc'; c.textContent = `${REASON_LABEL[r] || r}: ${n}`; chips.appendChild(c); });
                if (!fl.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'لا توجد أعطال 🎉'; list.appendChild(e); }
                fl.slice(-80).reverse().forEach(f => {
                    const d = document.createElement('div'); d.className = 'fi';
                    const a = document.createElement('span'); a.textContent = f.name;
                    const b = document.createElement('span'); b.textContent = REASON_LABEL[f.reason] || f.reason;
                    d.appendChild(a); d.appendChild(b); list.appendChild(d);
                });
            }
            $('wRetryBtn').disabled = busy || failedChats.size === 0;
        }
    }

    applyUI();
    updateWidget();
    const timer = setInterval(updateWidget, 700);
}

// ============================================
// تشغيل: Initialization أولاً ثم الويدجيت ثم الاستئناف التلقائي (لو لزم)
// ============================================
initState().then(() => {
    initWidget();
    setInterval(() => {
        if (!isAlive()) return;
        if (shouldShowWidget() && !document.getElementById(WIDGET_ID)) initWidget();
    }, 2000);
    if (resumeSending) setTimeout(() => { autoResumeFlow(); }, 1500);
});

if (typeof globalThis !== 'undefined' && globalThis.__FBSR_TEST__) {
    globalThis.__FBSR_API__ = {
        matchRow, normalizeArabic, pickSavedReply, readRows, ingestRows, rebuildIndexes,
        setQueue: (q) => { conversationQueue = q; rebuildIndexes(); },
        getQueue: () => conversationQueue, ready, sleep, waitUntil, applyStartPosition,
        setSettings: (s) => { settings = { ...settings, ...s }; }, SAFE_RETRY,
        getState: () => ({ currentMode, initialized, queueIndex, failedChats, failReasons, loadingComplete, loadInfo, resumeSending, recovery, stats }),
        buildConversationQueue, locateConversation, setIndexState: () => rebuildIndexes(),
        runSendAutomation, retryFailedFlow, recoverByReload, processEntryStub: (fn) => { processEntry = fn; },
        smartDelay, SPEEDS, setReloadWait: (ms) => { RELOAD_WAIT_MS = ms; }
    };
}

})();
