import React from "react";
import { ThemeProvider } from "./contexts/ThemeContext";
import { AppProvider, useApp } from "./contexts/AppContext";
import { ToastProvider } from "./hooks/useToast";
import { Sidebar } from "./components/layout/Sidebar";
import { Header } from "./components/layout/Header";
import { Dashboard } from "./components/dashboard/Dashboard";
import { FileManager } from "./components/fileManager/FileManager";
import { Settings } from "./components/settings/Settings";
import { UploadModal } from "./components/upload/UploadModal";

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
    </div>
  );
};

function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AppProvider>
          <AppContent />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
