import React, { useState } from "react";
import { ThemeProvider } from "./contexts/ThemeProvider";
import { AppProvider } from "./contexts/AppProvider";
import { useApp } from "./contexts/AppContext";
import { AuthProvider } from "./contexts/AuthProvider";
import { useAuth } from "./contexts/AuthContext";
import { ToastProvider } from "./hooks/ToastProvider";
import { useIsMobile } from "./hooks/useIsMobile";
import { Sidebar } from "./components/layout/Sidebar";
import { Header } from "./components/layout/Header";
import { Dashboard } from "./components/dashboard/Dashboard";
import { FileManager } from "./components/fileManager/FileManager";
import { Settings } from "./components/settings/Settings";
import { UploadModal } from "./components/upload/UploadModal";
import { CreateFolderModal } from "./components/folder/CreateFolderModal";
import { ImageViewerModal } from "./components/viewer/ImageViewerModal";
import { DocumentViewerModal } from "./components/viewer/DocumentViewerModal";
import { RenameModal } from "./components/fileManager/RenameModal";
import { ShareLinkModal } from "./components/fileManager/ShareLinkModal";
import { LoginForm } from "./components/auth/LoginForm";
import { SignupForm } from "./components/auth/SignupForm";
import { MobileAppContent } from "./components/mobile/MobileAppContent";

const AppContent: React.FC = () => {
  const { currentPath, sidebarOpen } = useApp();
  const isMobile = useIsMobile();

  const renderContent = () => {
    const currentPage = currentPath[0];

    switch (currentPage) {
      case "Dashboard":
        return (
          <div className="animate-fadeIn">
            <Dashboard />
          </div>
        );
      case "Settings":
        return (
          <div className="animate-fadeIn">
            <Settings />
          </div>
        );
      case "My Files":
      case "Shared":
      case "Starred":
      case "Trash":
      default:
        return (
          <div className="animate-fadeIn">
            <FileManager />
          </div>
        );
    }
  };

  if (isMobile) {
    // Dedicated mobile layout / UX
    return <MobileAppContent />;
  }

  return (
    <div className="h-screen bg-gray-50 dark:bg-slate-900 flex overflow-hidden">
      <Sidebar />

      <div
        className={`flex-1 flex flex-col overflow-hidden transition-all duration-300 ${!sidebarOpen ? "lg:ml-0" : ""}`}
      >
        <Header />

        <main className="flex-1 overflow-y-auto">{renderContent()}</main>
      </div>

      <UploadModal />
      <CreateFolderModal />
      <ImageViewerModal />
      <DocumentViewerModal />
      <RenameModal />
      <ShareLinkModal />
    </div>
  );
};

const AuthGate: React.FC = () => {
  const { user, loading } = useAuth();
  const [view, setView] = useState<"login" | "signup">("login");
  const [error, setError] = useState<string | null>(null);

  // Check for error in URL (e.g., from Google OAuth callback)
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const errorParam = params.get("error");
    if (errorParam === "signup_disabled") {
      setError("Signup is currently disabled");
      setView("login");
      // Clean up URL
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-950">
        <div className="text-center animate-fadeIn">
          <div className="w-16 h-16 mx-auto mb-4 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-lg font-semibold text-gray-700 dark:text-gray-300 animate-pulse">
            Loading...
          </p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        {error && (
          <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-red-500 text-white px-4 py-2 rounded-lg shadow-lg z-50">
            {error}
          </div>
        )}
        {view === "login" ? (
          <LoginForm
            onSwitch={() => {
              setView("signup");
              setError(null);
            }}
          />
        ) : (
          <SignupForm
            onSwitch={() => {
              setView("login");
              setError(null);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
};

function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <AuthGate />
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
