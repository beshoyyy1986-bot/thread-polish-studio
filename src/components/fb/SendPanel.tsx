import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import type { Tables } from "@/integrations/supabase/types";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { parseCookies } from "@/lib/cookies";
import { sessionsQuery } from "@/lib/fb-store";
import {
  closeSession,
  openSession,
  reattachSession,
  startRemoteView,
  syncSessions,
} from "@/lib/fb.functions";
import { Panel } from "./Panel";
import { cn } from "@/lib/utils";
import { ActivityLog } from "./ActivityLog";
import type { LogEntry, Logger } from "./use-log";

type Profile = Tables<"fb_profiles">;
type PageRow = Tables<"fb_pages">;
type Session = Tables<"cloud_sessions">;

const fmt = (n: number) => n.toLocaleString("en-US");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const statusLabel: Record<
  string,
  { text: string; variant: "success" | "warning" | "danger" | "muted" }
> = {
  open: { text: "متصلة", variant: "success" },
  opening: { text: "جاري التجهيز", variant: "warning" },
  lost: { text: "غير متصلة", variant: "warning" },
  close_failed: { text: "فشل الإغلاق", variant: "danger" },
};

export function SendPanel(props: {
  userId: string;
  profile: Profile;
  pages: PageRow[];
  selectedPageId?: string | undefined;
  onSelectPage: (id: string) => void;
  log: Logger;
  entries: LogEntry[];
}) {
  const { profile, selectedPageId: pageId, log } = props;
  const qc = useQueryClient();
  const { data: sessions = [] } = useQuery({ ...sessionsQuery(), refetchInterval: 15000 });

  const openFn = useServerFn(openSession);
  const closeFn = useServerFn(closeSession);
  const syncFn = useServerFn(syncSessions);
  const reattachFn = useServerFn(reattachSession);
  const viewFn = useServerFn(startRemoteView);

  const [cookies, setCookies] = useState(profile.cookies);
  const [fbUrl, setFbUrl] = useState(profile.fb_url);
  useEffect(() => {
    setCookies(profile.cookies);
    setFbUrl(profile.fb_url);
  }, [profile.id, profile.cookies, profile.fb_url]);

  const [opening, setOpening] = useState(false);
  const [remoteViews, setRemoteViews] = useState<Record<string, string>>({});
  const [viewLoading, setViewLoading] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["stats", profile.id, pageId] });
    qc.invalidateQueries({ queryKey: ["sessions"] });
  };

  // Reconcile recorded sessions with what is really running on the account.
  useEffect(() => {
    syncFn()
      .then((r) => {
        if (r.adopted)
          log(`🔎 وُجدت ${r.adopted} جلسة مفتوحة على حسابك لم تكن مسجلة — ظاهرة بالأسفل`, "warn");
        qc.invalidateQueries({ queryKey: ["sessions"] });
      })
      .catch((e) => log("⚠️ " + errText(e), "warn"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  async function saveSettings() {
    const { error } = await supabase
      .from("fb_profiles")
      .update({ cookies, fb_url: fbUrl.trim() || "https://www.facebook.com/messages" })
      .eq("id", profile.id);
    if (error) throw error;
    qc.invalidateQueries({ queryKey: ["profiles"] });
  }

  async function openOne() {
    try {
      parseCookies(cookies);
    } catch (e) {
      toast.error(errText(e));
      return;
    }
    setOpening(true);
    try {
      await saveSettings();
      log("🖥️ فتح متصفح سحابي بالإضافة...", "info");
      const r = await openFn({ data: { profileId: profile.id } });
      log(r.loggedIn ? "✅ المتصفح جاهز والإضافة متركبة" : "⚠️ المتصفح فتح لكن فيسبوك طلب تسجيل الدخول — راجع الكوكيز", r.loggedIn ? "ok" : "warn");
    } catch (e) {
      log("❌ " + errText(e), "err");
    } finally {
      setOpening(false);
      refresh();
    }
  }

  async function close(s: Session) {
    if (!confirm("إغلاق هذا المتصفح السحابي نهائياً؟")) return;
    const r = await closeFn({ data: { sessionId: s.id } }).catch((e) => ({
      closed: false,
      detail: errText(e),
    }));
    if (r.closed) log("🗑 تم إغلاق الجلسة والتأكد من إغلاقها", "ok");
    else log("❌ لم يتم التأكد من الإغلاق: " + r.detail, "err");
    refresh();
  }

  async function closeAll() {
    if (!confirm("إغلاق كل المتصفحات السحابية؟")) return;
    for (const s of sessions) {
      const r = await closeFn({ data: { sessionId: s.id } }).catch((e) => ({
        closed: false,
        detail: errText(e),
      }));
      log(r.closed ? `🗑 أُغلقت ${s.label}` : `❌ ${s.label}: ${r.detail}`, r.closed ? "ok" : "err");
    }
    refresh();
  }

  async function reattach(s: Session) {
    try {
      await reattachFn({ data: { sessionId: s.id, profileId: profile.id } });
      log("🔗 تم إعادة الاتصال بالجلسة", "ok");
    } catch (e) {
      log("❌ " + errText(e), "err");
    }
    refresh();
  }

  async function view(s: Session, separateTab = false) {
    const w = separateTab ? window.open("about:blank", "_blank") : null;
    if (separateTab && !w) {
      toast.error("اسمح بالنوافذ المنبثقة لهذا الموقع ثم حاول مرة أخرى");
      return;
    }
    if (w) w.opener = null;
    setViewLoading(s.id);
    try {
      const url = remoteViews[s.id] ?? (await viewFn({ data: { sessionId: s.id } })).url;
      setRemoteViews((views) => ({ ...views, [s.id]: url }));
      if (w) w.location.href = url;
    } catch (e) {
      w?.close();
      toast.error(errText(e));
    } finally {
      setViewLoading(null);
    }
  }

  function hideView(sessionId: string) {
    setRemoteViews((views) => {
      const { [sessionId]: _, ...rest } = views;
      return rest;
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto lg:w-80">
        <Panel title="حساب فيسبوك (للمتصفح)">
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">الكوكيز (JSON أو c_user=..; xs=..)</Label>
              <Textarea
                dir="ltr"
                rows={3}
                className="font-mono text-[11px]"
                value={cookies}
                onChange={(e) => setCookies(e.target.value)}
                onBlur={() => saveSettings().catch(() => {})}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">رابط صندوق الرسائل</Label>
              <Input
                dir="ltr"
                value={fbUrl}
                onChange={(e) => setFbUrl(e.target.value)}
                onBlur={() => saveSettings().catch(() => {})}
              />
            </div>
          </div>
        </Panel>

        <Button onClick={openOne} disabled={opening}>
          {opening ? "جاري الفتح..." : "🖥️ فتح متصفح بالإضافة"}
        </Button>
        <Button variant="soft-destructive" onClick={closeAll} disabled={!sessions.length}>
          🗑 حذف كل الجلسات المفتوحة
        </Button>
      </aside>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-semibold text-muted-foreground">
            المتصفحات السحابية ({sessions.length})
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              syncFn()
                .then(refresh)
                .catch((e) => toast.error(errText(e)))
            }
          >
            🔄 مزامنة مع حسابي
          </Button>
        </div>
        <div className="grid min-h-[120px] flex-1 auto-rows-min gap-3 overflow-y-auto p-3 md:grid-cols-2">
          {sessions.length === 0 && (
            <div className="col-span-full flex h-24 items-center justify-center text-sm text-muted-foreground">
              لا توجد متصفحات مفتوحة
            </div>
          )}
          {sessions.map((s) => {
            const st = statusLabel[s.status] ?? { text: s.status, variant: "muted" as const };
            return (
              <div key={s.id} className={cn("rounded-lg border border-border bg-secondary/50 p-3", remoteViews[s.id] && "col-span-full")}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium" dir="ltr">
                      {s.label}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {new Date(s.created_at).toLocaleString("en-US")}
                    </div>
                  </div>
                  <Badge variant={st.variant}>{st.text}</Badge>
                </div>
                {s.last_error && (
                  <div className="mt-2 text-[11px] text-warning">{s.last_error}</div>
                )}
                {remoteViews[s.id] && (
                  <div className="mt-3 overflow-hidden rounded-md border border-border bg-background">
                    <iframe
                      src={remoteViews[s.id]}
                      title={`العرض المباشر ${s.label}`}
                      className="h-[75vh] min-h-[480px] w-full"
                      allow="clipboard-read; clipboard-write"
                    />
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="soft"
                    disabled={viewLoading === s.id}
                    onClick={() => (remoteViews[s.id] ? hideView(s.id) : view(s))}
                  >
                    {viewLoading === s.id
                      ? "جاري التشغيل..."
                      : remoteViews[s.id]
                        ? "إخفاء العرض"
                        : "🖥️ عرض هنا"}
                  </Button>
                  <Button
                    size="sm"
                    variant="soft"
                    disabled={viewLoading === s.id}
                    onClick={() => view(s, true)}
                  >
                    ↗ تكبير في تاب
                  </Button>
                  {s.status !== "open" && s.status !== "close_failed" && (
                    <Button size="sm" variant="soft" onClick={() => reattach(s)}>
                      🔗 اتصال
                    </Button>
                  )}
                  <Button size="sm" variant="soft-destructive" onClick={() => close(s)}>
                    🗑 حذف الجلسة
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="shrink-0 border-t border-border">
          <button
            type="button"
            className="flex h-9 w-full items-center justify-between gap-3 px-3 text-start text-xs text-muted-foreground hover:bg-secondary/50"
            aria-expanded={logOpen}
            onClick={() => setLogOpen((open) => !open)}
          >
            <span className="shrink-0 font-medium">سجل العمليات ({props.entries.length})</span>
            <span className="truncate">
              {props.entries.at(-1)?.text ?? "جاهز — اضغط لعرض التفاصيل"}
            </span>
            <span aria-hidden="true">{logOpen ? "−" : "+"}</span>
          </button>
          {logOpen && (
            <ActivityLog
              entries={props.entries}
              className="h-32 border-t border-border px-3 py-1 text-[10px] leading-4"
            />
          )}
        </div>
      </div>
    </div>
  );
}
