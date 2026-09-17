import { useState, useEffect, useCallback } from "react";
import NavBar from "./components/NavBar";
import ViewerPage from "./components/ViewerPage";
import TriggerPage from "./components/TriggerPage";
import CostPage from "./components/CostPage";
import LoginPage from "./components/LoginPage";
import LocalBackendStatus from "./components/LocalBackendStatus";
import LocalCostPage from "./components/LocalCostPage";
import LocalVideoWorkspace from "./components/LocalVideoWorkspace";
import { getSession, signOut, loadAuthConfig } from "./auth";
import { IS_LOCAL_BACKEND } from "./config";

function App() {
  const [activePage, setActivePage] = useState<"viewer" | "trigger" | "cost">(
    "trigger",
  );
  const [isAuthenticated, setIsAuthenticated] = useState(IS_LOCAL_BACKEND);
  const [authLoading, setAuthLoading] = useState(!IS_LOCAL_BACKEND);
  const [backendReady, setBackendReady] = useState(false);
  const [viewerRefresh, setViewerRefresh] = useState(0);
  const refreshResults = useCallback(() => setViewerRefresh((value) => value + 1), []);

  useEffect(() => {
    if (IS_LOCAL_BACKEND) return;
    async function checkAuth() {
      try {
        await loadAuthConfig();
        const session = await getSession();
        setIsAuthenticated(session !== null);
      } catch {
        setIsAuthenticated(false);
      } finally {
        setAuthLoading(false);
      }
    }
    checkAuth();
  }, []);

  const handleLoginSuccess = () => {
    setIsAuthenticated(true);
  };

  const handleSignOut = async () => {
    await signOut();
    setIsAuthenticated(false);
  };

  if (authLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-[var(--on-surface-muted)]">Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage onLoginSuccess={handleLoginSuccess} />;
  }

  if (IS_LOCAL_BACKEND) return <LocalVideoWorkspace />;

  return (
    <div className="flex flex-col min-h-screen font-[var(--font-body)]">
      <header className="px-6 py-3 bg-[var(--surface-container-low)] flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold font-[var(--font-display)] text-[var(--on-surface)]">
            VisionEcho
          </h1>
          {IS_LOCAL_BACKEND && (
            <p className="mt-1 text-xs text-[var(--on-surface-muted)]">
              Azure + Local · 中文 / English 口述解说
            </p>
          )}
        </div>
        {!IS_LOCAL_BACKEND && <button
          onClick={handleSignOut}
          className="text-sm text-[var(--on-surface-muted)] hover:text-[var(--on-surface)] transition-colors"
        >
          Sign Out
        </button>}
      </header>
      {IS_LOCAL_BACKEND && <LocalBackendStatus onReadyChange={setBackendReady} />}
      <NavBar activePage={activePage} onNavigate={setActivePage} />
      <div style={{ display: activePage === "viewer" ? "contents" : "none" }}>
        <ViewerPage key={viewerRefresh} />
      </div>
      <div style={{ display: activePage === "trigger" ? "contents" : "none" }}>
        <TriggerPage
          processingReady={!IS_LOCAL_BACKEND || backendReady}
          onExecutionComplete={IS_LOCAL_BACKEND ? refreshResults : undefined}
        />
      </div>
      <div style={{ display: activePage === "cost" ? "contents" : "none" }}>
        {IS_LOCAL_BACKEND ? <LocalCostPage /> : <CostPage />}
      </div>
    </div>
  );
}

export default App;
