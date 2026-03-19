# المصادقة في MCP Hub

## التوكنات

| التوكن | المتغير | الحماية |
|-------|---------|---------|
| **واجهة الويب** | `MCP_HUB_UI_TOKEN` | `/` و `/api/*` |
| **نقطة MCP** | `MCP_HOST_TOKEN` | `/mcp` و `/messages` |

---

## إعداد عميل MCP مع MCP_HOST_TOKEN

عند تعيين `MCP_HOST_TOKEN`، أضف الـ headers في إعداد العميل:

### Cursor
```json
{
  "mcpServers": {
    "Hub": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_HOST_TOKEN"
      }
    }
  }
}
```

### Claude Desktop
```json
{
  "mcpServers": {
    "Hub": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_HOST_TOKEN"
      }
    }
  }
}
```

---

## Claude.ai مع OAuth

عند تعيين `MCP_HOST_TOKEN`، يدعم MCP Hub **OAuth 2.0** تلقائياً. Claude.ai يتصل عبر OAuth:

1. **Settings** → **Connectors** → **Add** → **Add custom connector**
2. **Name:** مثلاً `MCP Hub`
3. **Remote MCP server URL:** `https://your-domain.com/mcp`
4. اضغط **Add** ثم **Connect**

**ملاحظة:** إذا كان Hub خلف reverse proxy، عيّن `MCP_HUB_PUBLIC_URL`:
```
MCP_HUB_PUBLIC_URL=https://mcp.yourdomain.com
```

### كلمة مرور الموافقة (اختياري)

لتقييد من يمكنه الاتصال، عيّن `MCP_OAUTH_APPROVAL_PASSWORD`:

```
MCP_OAUTH_APPROVAL_PASSWORD=كلمة-المرور-السرية
```

عند الاتصال، ستظهر صفحة تطلب إدخال كلمة المرور قبل إكمال OAuth. شاركها فقط مع من تريد منحهم الوصول.

---

## كيف تمت الموافقة بدون إدخال توكن؟

التوكن (`MCP_HOST_TOKEN`) موجود **على السيرفر فقط** — أنت لا تدخله في Claude.ai.

### التدفق:

1. **أنت تضغط Connect** في Claude.ai ← هذا يعتبر موافقتك على الاتصال.
2. **Claude يفتح المتصفح** ويوجهك إلى `/oauth/authorize` على Hub.
3. **Hub يصدر كوداً مؤقتاً** ويُعيد التوجيه فوراً إلى Claude (بدون صفحة تسجيل دخول).
4. **Claude يتبادل الكود مع Hub** عبر `/oauth/token` (اتصال سيرفر-إلى-سيرفر).
5. **Hub يعيد التوكن** (`MCP_HOST_TOKEN`) كـ access token لـ Claude.
6. **Claude يحفظ التوكن** ويستخدمه في كل طلبات MCP التالية.

### الأمان:

- التوكن لا يظهر أبداً في المتصفح أو للمستخدم.
- PKCE يضمن أن الكود المؤقت لا يُستبدل إلا من قبل من بدأ الطلب.
- `redirect_uri` مقيد بـ Claude فقط (`claude.ai`, `claude.com`).

---

## استخدام التوكن في الرابط (?token=xxx)

بعض العملاء (مثل **Cloud Code**، VS Code للويب، أو بيئات سحابية أخرى) **لا تدعم تمرير headers** في إعداد MCP. استخدم التوكن في الرابط مباشرة:

```json
{
  "mcpServers": {
    "Hub": {
      "url": "https://your-hub.example.com/mcp?token=YOUR_MCP_HOST_TOKEN"
    }
  }
}
```

أو بصيغة URL فقط:
```
https://your-hub.example.com/mcp?token=YOUR_MCP_HOST_TOKEN
```

**ملاحظة:** إذا كان عميلك يدعم `headers` (مثل Cursor أو Claude Desktop)، يُفضّل استخدام headers بدلاً من التوكن في الرابط لأسباب أمنية.

---

## استكشاف الأخطاء: "Couldn't reach the MCP server"

1. **تأكد من التوكن**:
   - إذا كان العميل يدعم headers: `"headers": { "Authorization": "Bearer YOUR_TOKEN" }`
   - إذا كان العميل لا يدعم headers (Cloud Code، إلخ): أضف التوكن في الرابط: `"url": "https://.../mcp?token=YOUR_TOKEN"`

2. **تحقق من الرابط**: جرّب فتح `https://mcp.whatsnow.io/api/health` في المتصفح — يجب أن يعيد JSON.

3. **SSL/الشبكة**: تأكد أن الشهادة صالحة وأن السيرفر يعمل.

4. **CORS**: تم تفعيل CORS على `/mcp` و `/messages` تلقائياً.

---

## مفاتيح خوادم MCP (dokploy-mcp، إلخ)

**لا تحتاج لتمرير مفاتيح المصادقة يدوياً عند استخدام MCP.**

### كيف يعمل

1. **إضافة الخادم**: تضيف خادم MCP (مثل dokploy-mcp) من الواجهة أو API
2. **تخزين المفاتيح**: تُحفظ `DOKPLOY_API_KEY` وغيرها في:
   - **PostgreSQL** (عند استخدام `--database-url`)
   - **ملف الإعداد** (عند استخدام `--config`)
3. **عند الاستخدام**: عندما تستدعي أداة من Cursor/Claude:
   - العميل يرسل الطلب إلى Hub مع `MCP_HOST_TOKEN` فقط
   - Hub يستخرج المفاتيح من قاعدة البيانات/الملف
   - Hub ينفذ الأداة على الخادم باستخدام المفاتيح المخزنة

### الخلاصة

| ما تمرره أنت | ما يخزنه النظام |
|--------------|------------------|
| `MCP_HOST_TOKEN` — للاتصال بالـ Hub | مفاتيح كل خادم (API keys، إلخ) |
| مرة واحدة في إعداد Cursor/Claude | في PostgreSQL أو ملف الإعداد |

**MCP_HOST_TOKEN** = توكن Master للاتصال بالـ Hub فقط  
**مفاتيح الخوادم** = مخزنة في Hub، تُستخدم تلقائياً عند تنفيذ الأدوات
