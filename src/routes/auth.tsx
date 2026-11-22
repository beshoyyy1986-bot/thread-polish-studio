import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/auth")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "تسجيل الدخول — FBBlaster Pro" },
      { name: "description", content: "سجّل الدخول لإدارة صفحاتك وجلسات الإرسال." },
      { property: "og:title", content: "تسجيل الدخول — FBBlaster Pro" },
      { property: "og:description", content: "سجّل الدخول لإدارة صفحاتك وجلسات الإرسال." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  beforeLoad: async () => {
    if (
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("mode") === "reset"
    )
      return;
    const { data } = await supabase.auth.getSession();
    if (data.session) throw redirect({ to: "/dashboard" });
  },
  component: AuthPage,
});

function authErrorMessage(err: unknown): string {
  const e = err as { code?: string; message?: string } | null;
  const code = e?.code ?? "";
  const msg = (e?.message ?? String(err)).toLowerCase();
  if (code === "weak_password" || msg.includes("weak") || msg.includes("easy to guess"))
    return "كلمة المرور قصيرة جداً (أقل حاجة 6 حروف).";
  if (code === "invalid_credentials" || msg.includes("invalid login"))
    return "البريد أو كلمة المرور غلط.";
  if (code === "user_already_exists" || msg.includes("already registered"))
    return "الحساب ده موجود بالفعل، سجّلي الدخول بدل إنشاء حساب.";
  if (code === "email_not_confirmed" || msg.includes("not confirmed"))
    return "لازم تأكدي البريد الأول من الرسالة اللي وصلتك.";
  if (code === "over_email_send_rate_limit" || msg.includes("rate limit"))
    return "محاولات كتير في وقت قصير، استني شوية وجربي تاني.";
  return e?.message ?? String(err);
}

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"in" | "up" | "request-reset" | "reset">(() => {
    return typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("mode") === "reset"
      ? "reset"
      : "in";
  });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const cleanEmail = email.trim();
    try {
      if (mode === "request-reset") {
        const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
          redirectTo: `${window.location.origin}/auth?mode=reset`,
        });
        if (error) throw error;
        toast.success("لو البريد مسجل، هيوصلك رابط تغيير كلمة المرور.");
      } else if (mode === "reset") {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        toast.success("تم تغيير كلمة المرور. يمكنك تسجيل الدخول الآن.");
        await supabase.auth.signOut();
        window.history.replaceState({}, "", "/auth");
        setPassword("");
        setMode("in");
      } else if (mode === "in") {
        const { error } = await supabase.auth.signInWithPassword({ email: cleanEmail, password });
        if (error) throw error;
        navigate({ to: "/dashboard", replace: true });
      } else {
        const { data, error } = await supabase.auth.signUp({
          email: cleanEmail,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        if (data.session) navigate({ to: "/dashboard", replace: true });
        else toast.success("تم إنشاء الحساب، سجّل الدخول.");
      }
    } catch (err) {
      toast.error(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const isPasswordForm = mode === "in" || mode === "up" || mode === "reset";
  const title =
    mode === "request-reset"
      ? "استعادة كلمة المرور"
      : mode === "reset"
        ? "اختيار كلمة مرور جديدة"
        : mode === "in"
          ? "سجّل الدخول للمتابعة"
          : "إنشاء حساب جديد";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-5 rounded-2xl border border-border bg-card p-7 shadow-glow"
      >
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-bold tracking-tight">
            <span className="text-brand">FB</span>Blaster{" "}
            <span className="text-muted-foreground text-base">Pro</span>
          </h1>
          <p className="text-sm text-muted-foreground">{title}</p>
        </div>
        {mode !== "reset" && (
          <div className="space-y-2">
            <Label htmlFor="email">البريد الإلكتروني</Label>
            <Input
              id="email"
              type="email"
              dir="ltr"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        )}
        {isPasswordForm && (
          <div className="space-y-2">
            <Label htmlFor="password">
              {mode === "in" ? "كلمة المرور" : "كلمة المرور الجديدة"}
            </Label>
            <Input
              id="password"
              type="password"
              dir="ltr"
              autoComplete={mode === "in" ? "current-password" : "new-password"}
              minLength={6}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        )}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy
            ? "..."
            : mode === "in"
              ? "دخول"
              : mode === "up"
                ? "إنشاء حساب"
                : mode === "request-reset"
                  ? "إرسال رابط التغيير"
                  : "حفظ كلمة المرور الجديدة"}
        </Button>
        {mode === "in" && (
          <button
            type="button"
            className="w-full text-center text-sm text-muted-foreground hover:text-foreground"
            onClick={() => setMode("request-reset")}
          >
            نسيت كلمة المرور؟
          </button>
        )}
        {(mode === "in" || mode === "up") && (
          <button
            type="button"
            className="w-full text-center text-sm text-muted-foreground hover:text-foreground"
            onClick={() => setMode(mode === "in" ? "up" : "in")}
          >
            {mode === "in" ? "أول مرة؟ أنشئ حساباً" : "عندي حساب بالفعل"}
          </button>
        )}
        {(mode === "request-reset" || mode === "reset") && (
          <button
            type="button"
            className="w-full text-center text-sm text-muted-foreground hover:text-foreground"
            onClick={() => setMode("in")}
          >
            العودة لتسجيل الدخول
          </button>
        )}
      </form>
    </div>
  );
}
