// background.js v8.2
// - Alarm كل 30 ثانية (الحد الأدنى المسموح في Chrome الحديث)
// - تسجيل التاب تلقائياً من الـ Heartbeat (حتى لو التشغيل من الويدجيت)
// - منع Chrome من إلغاء (discard) تاب البوت أثناء التشغيل
// - كشف التاب المعلّق: لا تقدّم فعلي لمدة طويلة -> تنبيه + شارة "!"
const ALARM = 'keepAlive';
const PERIOD_MIN = 0.5;          // 30 ثانية
const STALE_MS = 150000;         // لا تقدّم لمدة 150 ثانية = مشتبه تعليق

function ensureAlarm() {
    chrome.alarms.get(ALARM).then(a => {
        if (!a || a.periodInMinutes !== PERIOD_MIN) {
            chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MIN, delayInMinutes: PERIOD_MIN });
        }
    }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => { console.log('[FB Bot v8.2] installed'); ensureAlarm(); });
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();

async function pushLog(message, type = 'warning') {
    try {
        const d = await chrome.storage.local.get('botLog');
        const logs = (d.botLog || []).concat({ message: `[${new Date().toLocaleTimeString('ar')}] ${message}`, type }).slice(-150);
        await chrome.storage.local.set({ botLog: logs });
    } catch (e) {}
}
function setBadge(text) {
    try {
        chrome.action.setBadgeText({ text });
        if (text) chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    } catch (e) {}
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== ALARM) return;
    const d = await chrome.storage.local.get(['botTabId', 'currentMode', 'hbMissed', 'hbAlerted']);
    if (!d.botTabId || !d.currentMode || d.currentMode === 'idle') {
        setBadge('');
        if (d.hbMissed || d.hbAlerted) await chrome.storage.local.set({ hbMissed: 0, hbAlerted: false });
        return;
    }

    try { await chrome.tabs.get(d.botTabId); }
    catch (e) {
        await chrome.storage.local.set({ currentMode: 'idle', hbMissed: 0, hbAlerted: false });
        setBadge('');
        return;
    }
    try { await chrome.tabs.update(d.botTabId, { autoDiscardable: false }); } catch (e) {}

    let problem = null;
    try {
        const res = await chrome.tabs.sendMessage(d.botTabId, { action: 'HEARTBEAT' });
        if (res && res.lastProgressAt && Date.now() - res.lastProgressAt > STALE_MS) {
            problem = `التاب لا يحرز تقدماً منذ ${Math.round((Date.now() - res.lastProgressAt) / 1000)} ثانية (ربما معلّق أو الصفحة تتأخر)`;
        } else if (!res || res.initialized === false) {
            problem = null;
        }
        if (!problem) await chrome.storage.local.set({ hbMissed: 0 });
    } catch (e) {
        const missed = (d.hbMissed || 0) + 1;
        await chrome.storage.local.set({ hbMissed: missed });
        if (missed >= 2) problem = 'التاب لا يستجيب للـ Heartbeat (تم تجميده أو إغلاق سكريبت الصفحة)';
    }

    if (problem) {
        setBadge('!');
        if (!d.hbAlerted) {
            await chrome.storage.local.set({ hbAlerted: true });
            await pushLog('⚠️ ' + problem + ' - افتح التاب وخلّيه ظاهر');
        }
    } else {
        setBadge('');
        if (d.hbAlerted) await chrome.storage.local.set({ hbAlerted: false });
    }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
    const d = await chrome.storage.local.get('botTabId');
    if (d.botTabId === tabId) {
        await chrome.storage.local.set({ currentMode: 'idle', hbMissed: 0, hbAlerted: false });
        setBadge('');
    }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.action === 'HEARTBEAT') {
        if (sender.tab && msg.mode && msg.mode !== 'idle') {
            chrome.storage.local.set({ botTabId: sender.tab.id });
            chrome.tabs.update(sender.tab.id, { autoDiscardable: false }).catch(() => {});
        }
        sendResponse({ ok: true });
    }
    return false;
});
