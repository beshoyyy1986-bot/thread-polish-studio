import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { countConversations, getPages, type FbPage } from "@/lib/facebook";
import { pagesQuery, profilesQuery } from "@/lib/fb-store";
import { closeSession, whoOwns } from "@/lib/fb.functions";
import { PagesPanel } from "@/components/fb/PagesPanel";
import { SendPanel } from "@/components/fb/SendPanel";
import { useLog } from "@/components/fb/use-log";

type Search = {
  tab?: "pages" | "send" | undefined;
  p?: string | undefined;
  pg?: string | undefined;
};

export const Route = createFileRoute("/_authenticated/dashboard")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    tab: s["tab"] === "send" ? "send" : s["tab"] === "pages" ? "pages" : undefined,
    p: typeof s["p"] === "string" ? s["p"] : undefined,
    // Page ids look numeric, so a hand-typed URL may arrive parsed as a number.
    pg:
      typeof s["pg"] === "string"
        ? s["pg"]
        : typeof s["pg"] === "number"
          ? String(s["pg"])
          : undefined,
  }),
  head: () => ({
    meta: [
      { title: "لوحة التحكم — FBBlaster Pro" },
      {
        name: "description",
        content: "صفحاتك، عدد المحادثات الفعلية، استخراج العملاء والإرسال مع الاستكمال.",
      },
      { property: "og:title", content: "لوحة التحكم — FBBlaster Pro" },
      {
        property: "og:description",
        content: "صفحاتك، عدد المحادثات الفعلية، استخراج العملاء والإرسال مع الاستكمال.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const { user } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/dashboard" });
  const qc = useQueryClient();
  const { entries, log } = useLog();
  const ownerFn = useServerFn(whoOwns);
  const closeSessionFn = useServerFn(closeSession);
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    ownerFn()
      .then((r) => setAllowed(r.allowed))
      .catch(() => setAllowed(false));
  }, [ownerFn]);

  const { data: profiles } = useQuery(profilesQuery());
  const creating = useRef(false);
  useEffect(() => {
    if (profiles && profiles.length === 0 && !creating.current) {
      creating.current = true;
      supabase
        .from("fb_profiles")
        .insert({ user_id: user.id, name: "الرئيسي" })
        .then(() => qc.invalidateQueries({ queryKey: ["profiles"] }));
    }
  }, [profiles, user.id, qc]);

  const profile = profiles?.find((p) => p.id === search.p) ?? profiles?.[0];
  const tab = search.tab ?? "pages";
  const { data: pages = [] } = useQuery(pagesQuery(profile?.id));

  const setSearch = (patch: Partial<Search>) =>
    navigate({ search: (s) => ({ ...s, ...patch }), replace: true });

  // Page access tokens come from the saved user token and are only kept in memory.
  const [tokens, setTokens] = useState<Map<string, FbPage>>(new Map());
  const [tokensLoading, setTokensLoading] = useState(false);
  const [tokensError, setTokensError] = useState<string | null>(null);
  const [countingAll, setCountingAll] = useState(false);
  const [countProgress, setCountProgress] = useState("");

  const loadPages = useCallback(
    async (token: string, profileId: string): Promise<FbPage[] | null> => {
      setTokensLoading(true);
      setTokensError(null);
      try {
        const list = await getPages(token);
        setTokens(new Map(list.map((page) => [page.id, page])));
        if (list.length) {
          const { error } = await supabase.from("fb_pages").upsert(
            list.map((page) => ({
              profile_id: profileId,
              page_id: page.id,
              user_id: user.id,
              name: page.name,
              fan_count: page.fan_count ?? 0,
              updated_at: new Date().toISOString(),
            })),
            { onConflict: "profile_id,page_id" },
          );
          if (error) throw error;
        }
        await qc.invalidateQueries({ queryKey: ["pages", profileId] });
        log(`✅ تم جلب ${list.length} صفحة`, "ok");
        return list;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setTokensError(msg);
        log("❌ " + msg, "err");
        return null;
      } finally {
        setTokensLoading(false);
      }
    },
    [qc, user.id, log],
  );

  // After a refresh, reload page access automatically from the saved token.
  useEffect(() => {
    setTokens(new Map());
    if (profile?.access_token) loadPages(profile.access_token, profile.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]);

  async function countPageConversations(profileId: string, availablePages: FbPage[]) {
    if (!availablePages.length) {
      toast.error("لم يتم العثور على صفحات متاحة لهذا التوكن");
      return;
    }
    setCountingAll(true);
    try {
      for (const [index, page] of availablePages.entries()) {
        setCountProgress(`${index + 1}/${availablePages.length} — ${page.name}`);
        try {
          const result = await countConversations(
            page,
            async (count) => {
              const { error } = await supabase
                .from("fb_pages")
                .update({
                  conversation_count: count,
                  count_complete: false,
                  counted_at: new Date().toISOString(),
                })
                .eq("profile_id", profileId)
                .eq("page_id", page.id);
              if (error) throw error;
            },
            () => false,
          );
          const { error } = await supabase
            .from("fb_pages")
            .update({
              conversation_count: result.count,
              count_complete: result.complete,
              counted_at: new Date().toISOString(),
            })
            .eq("profile_id", profileId)
            .eq("page_id", page.id);
          if (error) throw error;
          log(`💬 ${page.name}: ${result.count.toLocaleString("en-US")} محادثة`, "ok");
        } catch (error) {
          log(
            `⚠️ تعذر عدّ محادثات ${page.name}: ${error instanceof Error ? error.message : String(error)}`,
            "warn",
          );
        }
        await qc.invalidateQueries({ queryKey: ["pages", profileId] });
      }
    } finally {
      setCountingAll(false);
      setCountProgress("");
    }
  }

  async function refreshPagesAndCount(token: string, profileId: string) {
    if (countingAll) return;
    const list = await loadPages(token, profileId);
    if (list) await countPageConversations(profileId, list);
  }

  async function saveToken(token: string) {
    if (!profile) return;
    const { error } = await supabase
      .from("fb_profiles")
      .update({ access_token: token })
      .eq("id", profile.id);
    if (error) {
      toast.error("تعذر حفظ التوكن");
      return;
    }
    await qc.invalidateQueries({ queryKey: ["profiles"] });
    await refreshPagesAndCount(token, profile.id);
  }

  async function countAllConversations() {
    if (!profile?.access_token) {
      toast.error("احفظ توكن فيسبوك صالحًا أولًا");
      return;
    }
    await refreshPagesAndCount(profile.access_token, profile.id);
  }

  async function addProfile() {
    const name = prompt("اسم البروفايل الجديد");
    if (!name?.trim()) return;
    const { data } = await supabase
      .from("fb_profiles")
      .insert({ user_id: user.id, name: name.trim() })
      .select()
      .single();
    await qc.invalidateQueries({ queryKey: ["profiles"] });
    if (data) setSearch({ p: data.id, pg: undefined });
  }

  async function deleteProfile() {
    if (!profile) return;
    const isLastProfile = (profiles?.length ?? 0) <= 1;
    const action = isLastProfile ? "حذف وإعادة ضبط" : "حذف";
    if (
      !confirm(
        `${action} "${profile.name}" نهائيًا؟ سيتم إغلاق جلساته السحابية وحذف الصفحات والعملاء والإحصاءات المحفوظة المرتبطة به. ${isLastProfile ? "سيُنشأ بروفايل فارغ جديد لإعادة ضبط الأداة." : ""}`,
      )
    )
      return;

    const { data: linkedSessions, error: sessionReadError } = await supabase
      .from("cloud_sessions")
      .select("id,status")
      .eq("profile_id", profile.id);
    if (sessionReadError) {
      toast.error("تعذر قراءة جلسات البروفايل؛ لم يتم حذفه");
      return;
    }

    for (const session of linkedSessions ?? []) {
      if (!["opening", "open", "lost", "close_failed"].includes(session.status)) continue;
      try {
        const result = await closeSessionFn({ data: { sessionId: session.id } });
        if (!result.closed) throw new Error(result.detail);
      } catch (error) {
        toast.error(
          `تعذر إغلاق جلسة سحابية؛ لم يتم حذف البروفايل. ${error instanceof Error ? error.message : ""}`,
        );
        return;
      }
    }

    const { error: sessionDeleteError } = await supabase
      .from("cloud_sessions")
      .delete()
      .eq("profile_id", profile.id);
    if (sessionDeleteError) {
      toast.error("تعذر حذف جلسات البروفايل؛ لم يتم حذفه");
      return;
    }

    const { error } = await supabase.from("fb_profiles").delete().eq("id", profile.id);
    if (error) {
      toast.error("تعذر حذف البروفايل");
      return;
    }
    creating.current = false;
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["profiles"] }),
      qc.invalidateQueries({ queryKey: ["pages"] }),
      qc.invalidateQueries({ queryKey: ["stats"] }),
    ]);
    setTokens(new Map());
    setSearch({ p: undefined, pg: undefined });
    toast.success(isLastProfile ? "تمت إعادة ضبط الأداة" : "تم حذف البروفايل وبياناته");
  }

  async function signOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  if (allowed === false) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="max-w-md text-muted-foreground">
          هذا الحساب غير مصرح له باستخدام الأداة. الأداة مخصصة لحساب المالك فقط.
        </p>
        <Button variant="soft" onClick={signOut}>
          تسجيل الخروج
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-sidebar px-5 py-2.5">
        <div className="text-lg font-bold tracking-tight">
          <span className="text-brand">FB</span>Blaster{" "}
          <span className="text-xs text-muted-foreground">Pro</span>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <nav className="flex gap-1 rounded-lg bg-secondary p-1" aria-label="التنقل الرئيسي">
            {(["pages", "send"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setSearch({ tab: t })}
                aria-current={tab === t ? "page" : undefined}
                className={cn(
                  "rounded-md px-4 py-1.5 text-sm transition",
                  tab === t
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t === "pages" ? "📊 الصفحات والعملاء" : "🖥️ المتصفحات"}
              </button>
            ))}
          </nav>
          <Button
            size="sm"
            variant="soft"
            onClick={() => void countAllConversations()}
            disabled={countingAll || tokensLoading || !profile?.access_token}
          >
            {countingAll ? `⏳ ${countProgress || "جاري العد"}` : "🔄 تحديث الصفحات والمحادثات"}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            value={profile?.id ?? ""}
            onChange={(e) => setSearch({ p: e.target.value, pg: undefined })}
          >
            {profiles?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Button size="sm" variant="soft" onClick={addProfile}>
            + بروفايل
          </Button>
          <Button
            size="sm"
            variant="soft-destructive"
            onClick={deleteProfile}
            aria-label="حذف البروفايل"
            title="حذف البروفايل أو إعادة ضبط الأداة"
          >
            حذف البروفايل
          </Button>
          <Button size="sm" variant="ghost" onClick={signOut}>
            خروج
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden p-4">
        {!profile ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            جاري التحميل...
          </div>
        ) : tab === "pages" ? (
          <div className="h-full min-h-0">
            <PagesPanel
              userId={user.id}
              profile={profile}
              pages={pages}
              tokens={tokens}
              tokensLoading={tokensLoading}
              tokensError={tokensError}
              onSaveToken={saveToken}
              selectedPageId={search.pg}
              onSelectPage={(id) => setSearch({ pg: id })}
              log={log}
            />
          </div>
        ) : (
          <SendPanel
            userId={user.id}
            profile={profile}
            pages={pages}
            selectedPageId={search.pg}
            onSelectPage={(id) => setSearch({ pg: id })}
            log={log}
            entries={entries}
          />
        )}
      </main>
    </div>
  );
}
