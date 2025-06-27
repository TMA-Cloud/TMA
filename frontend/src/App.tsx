import React, { useState } from "react";
import { ThemeProvider } from "./contexts/ThemeContext";
import { AppProvider, useApp } from "./contexts/AppContext";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { ToastProvider } from "./hooks/useToast";
import { Sidebar } from "./components/layout/Sidebar";
import { Header } from "./components/layout/Header";
import { Dashboard } from "./components/dashboard/Dashboard";
import { FileManager } from "./components/fileManager/FileManager";
import { Settings } from "./components/settings/Settings";
import { UploadModal } from "./components/upload/UploadModal";
import { CreateFolderModal } from "./components/folder/CreateFolderModal";
import { ImageViewerModal } from "./components/viewer/ImageViewerModal";
import { LoginForm } from "./components/auth/LoginForm";
import { SignupForm } from "./components/auth/SignupForm";

const AppContent: React.FC = () => {
  const { currentPath, sidebarOpen } = useApp();

  const renderContent = () => {
    const currentPage = currentPath[0];

    switch (currentPage) {
      case "Dashboard":
        return <Dashboard />;
      case "Settings":
        return <Settings />;
      case "My Files":
      case "Shared with Me":
      case "Starred":
      case "Trash":
      default:
        return <FileManager />;
    }
  };

  return (
    <div className="h-screen bg-gray-50 dark:bg-gray-900 flex overflow-hidden">
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
    </div>
  );
};

const AuthGate: React.FC = () => {
  const { user, loading } = useAuth();
  const [view, setView] = useState<"login" | "signup">("login");

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        Loading...
      </div>
    );
  }

  if (!user) {
    return view === "login" ? (
      <div className="h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <LoginForm onSwitch={() => setView("signup")} />
      </div>
    ) : (
      <div className="h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <SignupForm onSwitch={() => setView("login")} />
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
