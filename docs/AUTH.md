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
