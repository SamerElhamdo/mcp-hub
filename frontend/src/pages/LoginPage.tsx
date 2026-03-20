import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setStoredUiToken } from "@/api";

export default function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnUrl = searchParams.get("returnUrl") || "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [useToken, setUseToken] = useState(false);

  const handleTokenSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = token.trim();
    if (!t) {
      setError("أدخل التوكن");
      return;
    }
    setStoredUiToken(t);
    window.location.href = returnUrl;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || data.message || "فشل تسجيل الدخول");
        return;
      }
      if (data.token) {
        setStoredUiToken(data.token);
      }
      window.location.href = returnUrl;
    } catch {
      setError("خطأ في الاتصال");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-background via-background to-muted/30">
      <Card className="w-full max-w-md border-border/50 shadow-xl shadow-primary/5">
        <CardHeader className="text-center pb-2">
          <CardTitle className="text-2xl font-bold text-primary">MCP Hub</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">تسجيل الدخول</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 rounded-lg bg-destructive/20 text-destructive text-sm">
                {error}
              </div>
            )}
            <div>
              <Label htmlFor="email">البريد الإلكتروني</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="password">كلمة المرور</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="mt-1"
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "جاري..." : "دخول"}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              ليس لديك حساب؟{" "}
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => navigate(`/register?returnUrl=${encodeURIComponent(returnUrl)}`)}
              >
                إنشاء حساب
              </button>
            </p>
            <p className="text-center text-xs text-muted-foreground">
              <button
                type="button"
                className="hover:underline"
                onClick={() => setUseToken(!useToken)}
              >
                {useToken ? "تسجيل بالبريد" : "تسجيل بالتوكن"}
              </button>
            </p>
          </form>
          {useToken && (
            <form onSubmit={handleTokenSubmit} className="mt-4 pt-4 border-t border-border space-y-4">
              <div>
                <Label htmlFor="token">توكن الواجهة (MCP_HUB_UI_TOKEN)</Label>
                <Input
                  id="token"
                  type="password"
                  placeholder="التوكن"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  className="mt-1"
                />
              </div>
              <Button type="submit" variant="secondary" className="w-full">دخول بالتوكن</Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
