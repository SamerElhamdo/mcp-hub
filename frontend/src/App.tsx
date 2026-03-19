import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  api,
  getStoredUiToken,
  setStoredUiToken,
  clearStoredUiToken,
  type ServerInfo,
  type HealthResponse,
  type ConfigResponse,
  type ServerConfig,
  type ToolInfo,
} from "./api";
import { useToast } from "./hooks/use-toast";

function escapeHtml(s: string) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function parseJsonOrDefault<T>(str: string, def: T): T {
  try {
    if (!str?.trim()) return def;
    return JSON.parse(str) as T;
  } catch {
    return def;
  }
}

export default function App() {
  const { toasts, toast } = useToast();
  const [needsAuth, setNeedsAuth] = useState(false);
  const [authToken, setAuthToken] = useState("");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [connectionUrl, setConnectionUrl] = useState("");
  const [serverModalOpen, setServerModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [serverForm, setServerForm] = useState<Partial<ServerConfig>>({});
  const [importJson, setImportJson] = useState("");
  const [testServer, setTestServer] = useState("");
  const [testTool, setTestTool] = useState("");
  const [testArgs, setTestArgs] = useState('{}');
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [activeTab, setActiveTab] = useState<"stdio" | "remote">("stdio");

  const loadData = useCallback(async () => {
    try {
      const [h, c] = await Promise.all([
        api<HealthResponse>("/health"),
        api<ConfigResponse>("/config"),
      ]);
      setNeedsAuth(false);
      setHealth(h);
      setConfig(c);
      setServers(h.servers || []);
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 401) {
        setNeedsAuth(true);
      } else {
        setHealth({ state: "error" });
        setServers([]);
      }
    }
  }, []);

  useEffect(() => {
    setConnectionUrl(window.location.origin + "/mcp");
  }, []);

  useEffect(() => {
    loadData();
    const t = setInterval(loadData, 5000);
    return () => clearInterval(t);
  }, [loadData]);

  const copyUrl = () => {
    navigator.clipboard.writeText(connectionUrl);
    toast("تم النسخ");
  };

  const allServerNames = [
    ...new Set([
      ...servers.map((s) => s.name),
      ...Object.keys(config?.config?.mcpServers || {}),
    ]),
  ];
  const serverMap = new Map(servers.map((s) => [s.name, s]));

  const openAddModal = () => {
    setEditingName(null);
    setServerForm({ command: "npx", args: [] });
    setActiveTab("stdio");
    setServerModalOpen(true);
  };

  const openEditModal = (name: string) => {
    const cfg = config?.config?.mcpServers?.[name];
    if (!cfg) return;
    setEditingName(name);
    setServerForm({
      ...cfg,
      args: Array.isArray(cfg.args) ? cfg.args : cfg.args ? [cfg.args] : [],
    });
    setActiveTab(cfg.url ? "remote" : "stdio");
    setServerModalOpen(true);
  };

  const saveServer = async () => {
    const nameInput = activeTab === "stdio"
      ? document.getElementById("serverName") as HTMLInputElement
      : document.getElementById("serverNameRemote") as HTMLInputElement;
    const n = nameInput?.value?.trim();
    if (!n) {
      toast("اسم الخادم مطلوب", "error");
      return;
    }
    const mcpServers = { ...(config?.config?.mcpServers || {}) };
    if (editingName && editingName !== n) delete mcpServers[editingName];
    if (activeTab === "stdio") {
      const command = (document.getElementById("serverCommand") as HTMLInputElement)?.value || "npx";
      const argsStr = (document.getElementById("serverArgs") as HTMLTextAreaElement)?.value || "[]";
      const envStr = (document.getElementById("serverEnv") as HTMLTextAreaElement)?.value || "{}";
      mcpServers[n] = {
        command,
        args: parseJsonOrDefault(argsStr, []),
        env: parseJsonOrDefault(envStr, {}),
      };
    } else {
      const url = (document.getElementById("serverUrl") as HTMLInputElement)?.value?.trim();
      if (!url) {
        toast("رابط الخادم مطلوب", "error");
        return;
      }
      const headersStr = (document.getElementById("serverHeaders") as HTMLTextAreaElement)?.value || "{}";
      mcpServers[n] = {
        url,
        headers: parseJsonOrDefault(headersStr, {}),
        type: "sse",
      };
    }
    try {
      await api("/config", {
        method: "POST",
        body: JSON.stringify({ mcpServers }),
      });
      toast("تم الحفظ");
      setServerModalOpen(false);
      loadData();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const deleteServer = async (name: string) => {
    if (!confirm(`حذف الخادم "${name}"؟`)) return;
    const mcpServers = { ...(config?.config?.mcpServers || {}) };
    delete mcpServers[name];
    try {
      await api("/config", {
        method: "POST",
        body: JSON.stringify({ mcpServers }),
      });
      toast("تم الحذف");
      loadData();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const toggleServer = async (name: string, isConnected: boolean) => {
    try {
      if (isConnected) {
        await api("/servers/stop", {
          method: "POST",
          body: JSON.stringify({ server_name: name }),
        });
        toast("تم الإيقاف");
      } else {
        await api("/servers/start", {
          method: "POST",
          body: JSON.stringify({ server_name: name }),
        });
        toast("تم التشغيل");
      }
      loadData();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const importConfig = async () => {
    try {
      const parsed = parseJsonOrDefault<{ mcpServers?: Record<string, ServerConfig>; servers?: Record<string, ServerConfig> }>(importJson, {});
      const incoming = parsed.mcpServers || parsed.servers || {};
      const mcpServers = { ...(config?.config?.mcpServers || {}), ...incoming };
      await api("/config", {
        method: "POST",
        body: JSON.stringify({ mcpServers }),
      });
      toast("تم الاستيراد");
      setImportModalOpen(false);
      setImportJson("");
      loadData();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const runTest = async () => {
    if (!testServer || !testTool) {
      toast("اختر الخادم والأداة", "error");
      return;
    }
    setTestResult(null);
    try {
      const args = parseJsonOrDefault(testArgs, {});
      const res = await api<{ result?: unknown }>("/servers/tools", {
        method: "POST",
        body: JSON.stringify({
          server_name: testServer,
          tool: testTool,
          arguments: args,
        }),
      });
      setTestResult({
        ok: true,
        text: JSON.stringify(res.result, null, 2),
      });
    } catch (e) {
      setTestResult({
        ok: false,
        text: (e as Error).message,
      });
    }
  };

  const toolsForServer = testServer ? (serverMap.get(testServer)?.capabilities?.tools || []) : [];
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    const token = authToken.trim();
    if (!token) {
      toast("أدخل التوكن", "error");
      return;
    }
    setStoredUiToken(token);
    setAuthToken("");
    setNeedsAuth(false);
    loadData();
  };

  const handleLogout = () => {
    clearStoredUiToken();
    setNeedsAuth(true);
    setHealth(null);
    setConfig(null);
    setServers([]);
  };

  if (needsAuth) {
    return (
      <div className="max-w-md mx-auto p-6 mt-16">
        <Card>
          <CardHeader>
            <CardTitle>تسجيل الدخول للواجهة</CardTitle>
            <p className="text-sm text-muted-foreground">
              أدخل توكن الواجهة (MCP_HUB_UI_TOKEN) للوصول
            </p>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <Label htmlFor="uiToken">التوكن</Label>
                <Input
                  id="uiToken"
                  type="password"
                  placeholder="توكن الواجهة"
                  value={authToken}
                  onChange={(e) => setAuthToken(e.target.value)}
                  autoComplete="current-password"
                  className="mt-1"
                />
              </div>
              <Button type="submit" className="w-full">دخول</Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  const statusVariant =
    health?.state === "ready"
      ? "success"
      : health?.state === "error"
        ? "destructive"
        : "warning";

  return (
    <div className="max-w-3xl mx-auto p-6">
      <header className="flex justify-between items-center pb-4 mb-6 border-b border-border">
        <h1 className="text-2xl font-bold">MCP Hub</h1>
        <div className="flex items-center gap-3">
          {getStoredUiToken() && (
            <Button variant="ghost" size="sm" onClick={handleLogout}>
              خروج
            </Button>
          )}
          <Badge variant={statusVariant}>
          <span className="w-1.5 h-1.5 rounded-full bg-current" />
          {health?.state === "ready" ? "متصل" : health?.state || "جاري التحميل..."}
          </Badge>
        </div>
      </header>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            رابط الاتصال
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 items-center bg-background rounded-lg p-3 font-mono text-sm">
            <Input
              readOnly
              value={connectionUrl}
              className="border-0 bg-transparent focus-visible:ring-0"
            />
            <Button size="sm" onClick={copyUrl}>
              نسخ
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            استخدم في Cursor أو Claude Desktop
          </p>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            خوادم MCP
          </CardTitle>
        </CardHeader>
        <CardContent>
          {allServerNames.length === 0 ? (
            <p className="text-center py-8 text-muted-foreground">
              لا توجد خوادم. أضف خادم أو استورد إعداد MCP Studio / VS Code.
            </p>
          ) : (
            <ul className="space-y-2">
              {allServerNames.map((name) => {
                const s = serverMap.get(name) || {
                  name,
                  status: "disabled",
                  transportType: config?.config?.mcpServers?.[name]?.url ? "sse" : "stdio",
                };
                return (
                  <li
                    key={name}
                    className="flex items-center justify-between p-3 rounded-lg border border-border bg-background hover:border-muted-foreground/30 transition-colors flex-wrap gap-2"
                  >
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="font-semibold">{s.name}</span>
                      <Badge
                        variant={
                          s.status === "connected"
                            ? "success"
                            : ["error", "disconnected"].includes(s.status)
                              ? "destructive"
                              : "warning"
                        }
                      >
                        {s.status || "—"}
                      </Badge>
                      <span className="text-xs text-muted-foreground px-2 py-0.5 bg-card rounded">
                        {s.transportType || "stdio"}
                      </span>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setTestServer(name);
                          setTestTool("");
                        }}
                      >
                        اختبار
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => openEditModal(name)}
                      >
                        تعديل
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => toggleServer(name, s.status === "connected")}
                      >
                        {s.status === "connected" ? "إيقاف" : "تشغيل"}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => deleteServer(name)}
                      >
                        حذف
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {config?.canEdit && (
            <div className="flex gap-2 mt-4">
              <Button onClick={openAddModal}>+ إضافة خادم</Button>
              <Button variant="secondary" onClick={() => setImportModalOpen(true)}>
                استيراد JSON
              </Button>
            </div>
          )}
          {!config?.canEdit && config !== null && (
            <p className="text-warning text-sm mt-2">
              التعديل غير متاح: شغّل mcp-hub مع --config path/to/file.json
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            اختبار أداة
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <Label>الخادم</Label>
              <Select value={testServer} onValueChange={(v) => { setTestServer(v); setTestTool(""); }}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="-- اختر --" />
                </SelectTrigger>
                <SelectContent>
                  {allServerNames.map((n) => (
                    <SelectItem key={n} value={n}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>الأداة</Label>
              <Select value={testTool} onValueChange={setTestTool}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="-- اختر --" />
                </SelectTrigger>
                <SelectContent>
                  {toolsForServer.map((t: ToolInfo) => (
                    <SelectItem key={t.name} value={t.name}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="mb-4">
            <Label>المعاملات (JSON)</Label>
            <Textarea
              className="mt-1"
              placeholder='{"key": "value"}'
              value={testArgs}
              onChange={(e) => setTestArgs(e.target.value)}
            />
          </div>
          <Button onClick={runTest}>تشغيل الاختبار</Button>
          {testResult && (
            <pre
              className={`mt-4 p-4 rounded-lg text-sm overflow-auto max-h-60 ${
                testResult.ok ? "bg-success/20 text-success" : "bg-destructive/20 text-destructive"
              }`}
            >
              {escapeHtml(testResult.text)}
            </pre>
          )}
        </CardContent>
      </Card>

      <Dialog open={serverModalOpen} onOpenChange={setServerModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingName ? "تعديل خادم" : "إضافة خادم"}</DialogTitle>
          </DialogHeader>
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "stdio" | "remote")}>
            <TabsList>
              <TabsTrigger value="stdio">STDIO</TabsTrigger>
              <TabsTrigger value="remote">بعيد (URL)</TabsTrigger>
            </TabsList>
            <TabsContent value="stdio">
              <div className="space-y-4">
                <div>
                  <Label>اسم الخادم</Label>
                  <Input
                    id="serverName"
                    placeholder="dokploy-mcp"
                    defaultValue={editingName || ""}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>الأمر</Label>
                  <Input
                    id="serverCommand"
                    placeholder="npx"
                    defaultValue={serverForm.command || "npx"}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>المعاملات (args) - JSON</Label>
                  <Textarea
                    id="serverArgs"
                    placeholder='["-y", "package-name"]'
                    defaultValue={JSON.stringify(serverForm.args || [], null, 2)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>متغيرات البيئة (JSON)</Label>
                  <Textarea
                    id="serverEnv"
                    placeholder='{"KEY": "value"}'
                    defaultValue={JSON.stringify(serverForm.env || {}, null, 2)}
                    className="mt-1"
                  />
                </div>
              </div>
            </TabsContent>
            <TabsContent value="remote">
              <div className="space-y-4">
                <div>
                  <Label>اسم الخادم</Label>
                  <Input
                    id="serverNameRemote"
                    placeholder="my-remote-mcp"
                    defaultValue={editingName || ""}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>رابط الخادم</Label>
                  <Input
                    id="serverUrl"
                    placeholder="https://mcp.example.com/sse"
                    defaultValue={serverForm.url || ""}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>Headers (JSON)</Label>
                  <Textarea
                    id="serverHeaders"
                    placeholder='{"Authorization": "Bearer ${env:API_KEY}"}'
                    defaultValue={JSON.stringify(serverForm.headers || {}, null, 2)}
                    className="mt-1"
                  />
                </div>
              </div>
            </TabsContent>
          </Tabs>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setServerModalOpen(false)}>
              إلغاء
            </Button>
            <Button onClick={saveServer}>حفظ</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={importModalOpen} onOpenChange={setImportModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>استيراد JSON</DialogTitle>
          </DialogHeader>
          <div>
            <Label>الصق إعداد MCP Studio أو VS Code (<code>servers</code> أو <code>mcpServers</code>)</Label>
            <Textarea
              className="mt-2 min-h-[120px]"
              placeholder='{"mcpServers": {...}}'
              value={importJson}
              onChange={(e) => setImportJson(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setImportModalOpen(false)}>
              إلغاء
            </Button>
            <Button onClick={importConfig}>استيراد</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] flex flex-col-reverse gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`px-4 py-2 rounded-lg text-sm ${
              t.type === "success" ? "bg-success text-white" :
              t.type === "error" ? "bg-destructive text-white" : "bg-primary text-white"
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
