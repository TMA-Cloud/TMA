import React, { useState, Suspense, lazy } from 'react';
import { ThemeProvider } from './contexts/ThemeProvider';
import { ThemeToggle } from './components/layout/ThemeToggle';
import { AppProvider } from './contexts/AppProvider';
import { useApp } from './contexts/AppContext';
import { AuthProvider } from './contexts/AuthProvider';
import { useAuth } from './contexts/AuthContext';
import { ToastProvider } from './hooks/ToastProvider';
import { useSignupStatus } from './components/settings/hooks/useSignupStatus';
import { useIsMobile } from './hooks/useIsMobile';
import { Sidebar } from './components/layout/Sidebar';
import { Header } from './components/layout/Header';
import { useScrollEdge } from './motion';

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

function scrollToTopFast(el: HTMLElement, durationMs = 180) {
  // Respect reduced-motion preference
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
    el.scrollTo({ top: 0, behavior: 'auto' });
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
const Dashboard = lazy(() => import('./components/dashboard/Dashboard'));
const FileManager = lazy(() => import('./components/fileManager/FileManager'));
const Settings = lazy(() => import('./components/settings/Settings'));
const MobileAppContent = lazy(() => import('./components/mobile/MobileAppContent'));

// Lazy load modals (conditionally rendered)
const UploadModal = lazy(() =>
  import('./components/upload/UploadModal').then(mod => ({
    default: mod.UploadModal,
  }))
);
const UploadProgress = lazy(() =>
  import('./components/upload/UploadProgress').then(mod => ({
    default: mod.UploadProgress,
  }))
);
const CreateFolderModal = lazy(() =>
  import('./components/folder/CreateFolderModal').then(mod => ({
    default: mod.CreateFolderModal,
  }))
);
const ImageViewerModal = lazy(() =>
  import('./components/viewer/ImageViewerModal').then(mod => ({
    default: mod.ImageViewerModal,
  }))
);
const DocumentViewerModal = lazy(() =>
  import('./components/viewer/DocumentViewerModal').then(mod => ({
    default: mod.DocumentViewerModal,
  }))
);
const RenameModal = lazy(() =>
  import('./components/fileManager/RenameModal').then(mod => ({
    default: mod.RenameModal,
  }))
);
const ShareLinkModal = lazy(() =>
  import('./components/fileManager/ShareLinkModal').then(mod => ({
    default: mod.ShareLinkModal,
  }))
);

// Lazy load auth components
const LoginForm = lazy(() =>
  import('./components/auth/LoginForm').then(mod => ({
    default: mod.LoginForm,
  }))
);
const SignupForm = lazy(() =>
  import('./components/auth/SignupForm').then(mod => ({
    default: mod.SignupForm,
  }))
);

/**
 * A spinner is a status report, not decoration, so it stays quiet: one ring,
 * no colour beyond the accent that marks the moving part.
 */
const PageLoadingFallback: React.FC = () => (
  <div className="flex items-center justify-center h-full min-h-[400px]">
    <div className="text-center">
      <div className="w-8 h-8 mx-auto mb-3 border-2 border-[var(--fill-tertiary)] border-t-[var(--accent)] rounded-full animate-spin"></div>
      <p className="type-footnote text-[var(--label-tertiary)]">Loading…</p>
    </div>
  </div>
);

const AppContent: React.FC = () => {
  const {
    currentPath,
    folderStack,
    sidebarOpen,
    uploadProgress,
    setUploadProgress,
    setIsUploadProgressInteracting,
    cancelUpload,
  } = useApp();
  const isMobile = useIsMobile();
  // One hook feeds both pieces of chrome that depend on this scroller: the
  // header's soft edge and the overlay scrollbar.
  const { ref: mainRef, scrolled: contentScrolled } = useScrollEdge<HTMLElement>();
  const navScrollRef = React.useRef<{ page: string; stackLen: number }>({
    page: currentPath[0] ?? '',
    stackLen: folderStack.length,
  });

  // Reset main scroll when changing top-level page or drilling into a folder — not when going up (back / breadcrumb),
  // so returning to a parent list keeps scroll position and the highlighted row can stay in view
  React.useEffect(() => {
    if (isMobile) return;
    const page = currentPath[0] ?? '';
    const stackLen = folderStack.length;
    const prev = navScrollRef.current;
    const pageChanged = page !== prev.page;
    const wentDeeper = stackLen > prev.stackLen;
    navScrollRef.current = { page, stackLen };

    if ((pageChanged || wentDeeper) && mainRef.current) {
      scrollToTopFast(mainRef.current, 180);
    }
  }, [currentPath, folderStack.length, isMobile, mainRef]);

  const renderContent = () => {
    const currentPage = currentPath[0];

    switch (currentPage) {
      case 'Dashboard':
        return (
          <div className="animate-fadeIn">
            <Suspense fallback={<PageLoadingFallback />}>
              <Dashboard />
            </Suspense>
          </div>
        );
      case 'Settings':
        return (
          <div className="animate-fadeIn">
            <Suspense fallback={<PageLoadingFallback />}>
              <Settings />
            </Suspense>
          </div>
        );
      case 'My Files':
      case 'Shared':
      case 'Starred':
      case 'Trash':
      default:
        return (
          <div className="animate-fadeIn pb-32">
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
    <div className="h-screen bg-[var(--canvas)] flex overflow-hidden">
      <Sidebar />

      <div
        className={`flex-1 flex flex-col overflow-hidden transition-[margin] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${!sidebarOpen ? 'lg:ml-0' : ''}`}
      >
        {/* The header floats over the scroller rather than taking a strip out
            of it, so `contentScrolled` is what tells it whether anything is
            actually passing underneath. */}
        <Header contentScrolled={contentScrolled} />

        <main ref={mainRef} className="scroller flex-1 overflow-y-auto">
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
            setUploadProgress(prev => prev.filter(item => item.id !== id));
          }}
          onInteractionChange={setIsUploadProgressInteracting}
          onCancel={cancelUpload}
        />
      </Suspense>
    </div>
  );
};

const AuthGate: React.FC = () => {
  const { user, loading } = useAuth();
  const [view, setView] = useState<'login' | 'signup'>('login');
  const [error, setError] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('error') === 'signup_disabled' ? 'Signup is currently disabled' : null;
  });

  const { signupEnabled, loadingSignupStatus } = useSignupStatus();

  // Clean up the error query param after mount
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('error')) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Derived: if signup got disabled while user was viewing signup, fall back to login UI
  // and surface a contextual error
  const signupDisabled = !loadingSignupStatus && !signupEnabled;
  const effectiveView: 'login' | 'signup' = signupDisabled ? 'login' : view;
  const effectiveError = error ?? (view === 'signup' && signupDisabled ? 'Signup is currently disabled.' : null);

  if (loading || loadingSignupStatus) {
    return (
      <div className="h-screen flex items-center justify-center bg-[var(--canvas)]">
        <div className="text-center animate-fadeIn">
          <div className="w-9 h-9 mx-auto mb-4 border-2 border-[var(--fill-tertiary)] border-t-[var(--accent)] rounded-full animate-spin"></div>
          <p className="type-footnote text-[var(--label-tertiary)]">Loading…</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-screen flex items-center justify-center bg-[var(--canvas)] relative">
        <div className="absolute top-5 right-5 z-50">
          <ThemeToggle />
        </div>
        {effectiveError && (
          <div
            className="absolute top-5 left-1/2 -translate-x-1/2 z-50 material-regular material-edge rounded-2xl px-4 py-2.5 type-footnote vibrant text-[var(--destructive-text)] animate-slideDown"
            role="alert"
          >
            {effectiveError}
          </div>
        )}
        <Suspense fallback={<PageLoadingFallback />}>
          {effectiveView === 'login' || !signupEnabled ? (
            <LoginForm
              signupEnabled={signupEnabled}
              onSwitch={() => {
                if (signupEnabled) {
                  setView('signup');
                  setError(null);
                }
              }}
            />
          ) : (
            <SignupForm
              onSwitch={() => {
                setView('login');
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
