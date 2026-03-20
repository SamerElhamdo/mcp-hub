import { StrictMode, Component } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";

const basename = (import.meta as { env?: { VITE_BASE_PATH?: string } }).env?.VITE_BASE_PATH?.replace(/\/$/, "") || "";
import App from "./App";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import "./index.css";

class ErrorBoundary extends Component<{ children: React.ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", flexDirection: "column", gap: "1rem", fontFamily: "system-ui", color: "#f85149", padding: "2rem", textAlign: "center" }}>
          <p>حدث خطأ في التطبيق</p>
          <button onClick={() => location.reload()} style={{ padding: "8px 16px", background: "#238636", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer" }}>إعادة التحميل</button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
    <BrowserRouter basename={basename}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/*" element={<App />} />
      </Routes>
    </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>
);
