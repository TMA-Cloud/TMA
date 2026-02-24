import React, { useState, Suspense, lazy } from "react";
import { ThemeProvider } from "./contexts/ThemeProvider";
import { AppProvider } from "./contexts/AppProvider";
import { useApp } from "./contexts/AppContext";
import { AuthProvider } from "./contexts/AuthProvider";
import { useAuth } from "./contexts/AuthContext";
import { ToastProvider } from "./hooks/ToastProvider";
import { useSignupStatus } from "./components/settings/hooks/useSignupStatus";
import { useIsMobile } from "./hooks/useIsMobile";
import { Sidebar } from "./components/layout/Sidebar";
import { Header } from "./components/layout/Header";

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

function scrollToTopFast(el: HTMLElement, durationMs = 180) {
  // Respect reduced-motion preference
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
    el.scrollTo({ top: 0, behavior: "auto" });
    return;
  }

  const startTop = el.scrollTop;
  if (startTop <= 0) return;

  const start = performance.now();
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / durationMs);
    const eased = easeOutCubic(t);
    el.scrollTop = Math.round(startTop * (1 - eased));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Lazy load main page components (using default exports for cleaner syntax)
const Dashboard = lazy(() => import("./components/dashboard/Dashboard"));
const FileManager = lazy(() => import("./components/fileManager/FileManager"));
const Settings = lazy(() => import("./components/settings/Settings"));
const MobileAppContent = lazy(
  () => import("./components/mobile/MobileAppContent"),
);

// Lazy load modals (conditionally rendered)
const UploadModal = lazy(() =>
  import("./components/upload/UploadModal").then((mod) => ({
    default: mod.UploadModal,
  })),
);
const UploadProgress = lazy(() =>
  import("./components/upload/UploadProgress").then((mod) => ({
    default: mod.UploadProgress,
  })),
);
const CreateFolderModal = lazy(() =>
  import("./components/folder/CreateFolderModal").then((mod) => ({
    default: mod.CreateFolderModal,
  })),
);
const ImageViewerModal = lazy(() =>
  import("./components/viewer/ImageViewerModal").then((mod) => ({
    default: mod.ImageViewerModal,
  })),
);
const DocumentViewerModal = lazy(() =>
  import("./components/viewer/DocumentViewerModal").then((mod) => ({
    default: mod.DocumentViewerModal,
  })),
);
const RenameModal = lazy(() =>
  import("./components/fileManager/RenameModal").then((mod) => ({
    default: mod.RenameModal,
  })),
);
const ShareLinkModal = lazy(() =>
  import("./components/fileManager/ShareLinkModal").then((mod) => ({
    default: mod.ShareLinkModal,
  })),
);

// Lazy load auth components
const LoginForm = lazy(() =>
  import("./components/auth/LoginForm").then((mod) => ({
    default: mod.LoginForm,
  })),
);
const SignupForm = lazy(() =>
  import("./components/auth/SignupForm").then((mod) => ({
    default: mod.SignupForm,
  })),
);

// Loading fallback component
const PageLoadingFallback: React.FC = () => (
  <div className="flex items-center justify-center h-full min-h-[400px]">
    <div className="text-center">
      <div className="w-12 h-12 mx-auto mb-4 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
      <p className="text-sm text-gray-600 dark:text-gray-400">Loading...</p>
    </div>
  </div>
);

const AppContent: React.FC = () => {
  const {
    currentPath,
    sidebarOpen,
    uploadProgress,
    setUploadProgress,
    setIsUploadProgressInteracting,
  } = useApp();
  const isMobile = useIsMobile();
  const mainRef = React.useRef<HTMLElement | null>(null);

  // Ensure the main scroll container resets to top whenever the path changes
  React.useEffect(() => {
    if (!isMobile && mainRef.current) {
      scrollToTopFast(mainRef.current, 180);
    }
  }, [currentPath, isMobile]);

  const renderContent = () => {
    const currentPage = currentPath[0];

    switch (currentPage) {
      case "Dashboard":
        return (
          <div className="animate-fadeIn">
            <Suspense fallback={<PageLoadingFallback />}>
              <Dashboard />
            </Suspense>
          </div>
        );
      case "Settings":
        return (
          <div className="animate-fadeIn">
            <Suspense fallback={<PageLoadingFallback />}>
              <Settings />
            </Suspense>
          </div>
        );
      case "My Files":
      case "Shared":
      case "Starred":
      case "Trash":
      default:
        return (
          <div className="animate-fadeIn">
            <Suspense fallback={<PageLoadingFallback />}>
              <FileManager />
            </Suspense>
          </div>
        );
    }
  };

  if (isMobile) {
    // Dedicated mobile layout / UX
    return (
      <Suspense fallback={<PageLoadingFallback />}>
        <MobileAppContent />
      </Suspense>
    );
  }

  return (
    <div className="h-screen bg-gray-50 dark:bg-slate-900 flex overflow-hidden">
      <Sidebar />

      <div
        className={`flex-1 flex flex-col overflow-hidden transition-all duration-300 ${!sidebarOpen ? "lg:ml-0" : ""}`}
      >
        <Header />

        <main ref={mainRef} className="flex-1 overflow-y-auto">
          {renderContent()}
        </main>
      </div>

      <Suspense fallback={null}>
        <UploadModal />
        <CreateFolderModal />
        <ImageViewerModal />
        <DocumentViewerModal />
        <RenameModal />
        <ShareLinkModal />
        <UploadProgress
          uploads={uploadProgress}
          onDismiss={(id: string) => {
            setUploadProgress((prev) => prev.filter((item) => item.id !== id));
          }}
          onInteractionChange={setIsUploadProgressInteracting}
        />
      </Suspense>
    </div>
  );
};

const AuthGate: React.FC = () => {
  const { user, loading } = useAuth();
  const [view, setView] = useState<"login" | "signup">("login");
  const [error, setError] = useState<string | null>(null);

  const { signupEnabled, loadingSignupStatus } = useSignupStatus();

  // If signup is disabled, force view to login
  React.useEffect(() => {
    if (!loadingSignupStatus && !signupEnabled && view === "signup") {
      setView("login");
      setError("Signup is currently disabled.");
    }
  }, [signupEnabled, loadingSignupStatus, view]);

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

  if (loading || loadingSignupStatus) {
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
        <Suspense fallback={<PageLoadingFallback />}>
          {view === "login" || !signupEnabled ? (
            <LoginForm
              signupEnabled={signupEnabled}
              onSwitch={() => {
                if (signupEnabled) {
                  setView("signup");
                  setError(null);
                }
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
        </Suspense>
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
