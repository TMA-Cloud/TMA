import React, { useEffect, useState } from "react";
import { RecentFiles } from "./RecentFiles";
import { useApp } from "../../contexts/AppContext";
import { Upload, FolderPlus, Share2, Star } from "lucide-react";
import { apiGet } from "../../utils/api";

interface FileStats {
  totalFiles: number;
  totalFolders: number;
  sharedCount: number;
  starredCount: number;
}

export const Dashboard: React.FC = () => {
  const {
    files,
    setUploadModalOpen,
    setCreateFolderModalOpen,
    setCurrentPath,
  } = useApp();
  const [stats, setStats] = useState<FileStats>({
    totalFiles: 0,
    totalFolders: 0,
    sharedCount: 0,
    starredCount: 0,
  });

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const data = await apiGet<FileStats>("/api/files/stats");
        setStats(data);
      } catch {
        // Error handled silently - stats will show as unavailable
      }
    };

    fetchStats();

    // Refresh stats periodically, but pause when tab is hidden to save resources
    let interval: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      // Only poll if tab is visible
      if (document.visibilityState === "visible") {
        interval = setInterval(fetchStats, 60000); // Refresh every 60 seconds (reduced from 30s)
      }
    };

    const stopPolling = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Tab became visible - fetch immediately and start polling
        fetchStats();
        startPolling();
      } else {
        // Tab is hidden - stop polling to save resources
        stopPolling();
      }
    };

    // Start polling if tab is visible
    startPolling();

    // Listen for visibility changes
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const quickActions = [
    {
      title: "Upload Files",
      icon: Upload,
      isPrimary: true,
      hoverColor:
        "hover:border-blue-500/50 hover:bg-blue-500/10 dark:hover:bg-blue-500/20",
      onClick: () => setUploadModalOpen(true),
    },
    {
      title: "Create Folder",
      icon: FolderPlus,
      isPrimary: false,
      hoverColor:
        "hover:border-green-500/50 hover:bg-green-500/10 dark:hover:bg-green-500/20",
      onClick: () => setCreateFolderModalOpen(true),
    },
    {
      title: "Share Files",
      icon: Share2,
      isPrimary: false,
      hoverColor:
        "hover:border-purple-500/50 hover:bg-purple-500/10 dark:hover:bg-purple-500/20",
      onClick: () => setCurrentPath(["Shared"]),
    },
    {
      title: "Starred Items",
      icon: Star,
      isPrimary: false,
      hoverColor:
        "hover:border-yellow-500/50 hover:bg-yellow-500/10 dark:hover:bg-yellow-500/20",
      onClick: () => setCurrentPath(["Starred"]),
    },
  ];

  const fileCount = stats.totalFiles;
  const folderCount = stats.totalFolders;
  const sharedCount = stats.sharedCount;
  const starredCount = stats.starredCount;

  const statsData = [
    { label: "Total Files", value: fileCount },
    { label: "Folders", value: folderCount },
    { label: "Shared", value: sharedCount },
    { label: "Starred", value: starredCount },
  ];

  const [animatedStats, setAnimatedStats] = useState([0, 0, 0, 0]);
  useEffect(() => {
    const durations = [600, 700, 800, 900] as const;
    const values = [fileCount, folderCount, sharedCount, starredCount];
    durations.forEach((duration, i) => {
      const val = values[i];
      if (val === undefined) return;
      let start = 0;
      const end = val;
      const step = Math.ceil(end / (duration / 16));
      const animate = () => {
        start += step;
        if (start > end) start = end;
        setAnimatedStats((prev) => {
          const copy = [...prev];
          copy[i] = start;
          return copy;
        });
        if (start < end) setTimeout(animate, 16);
      };
      animate();
    });
  }, [fileCount, folderCount, sharedCount, starredCount]);

  return (
    <div className="p-6 md:p-8 space-y-8 bg-gradient-to-br from-gray-50 to-white dark:from-slate-900 dark:to-slate-950 min-h-screen">
      {/* Welcome section */}
      <div>
        <h1 className="text-3xl md:text-4xl font-bold text-gray-900 dark:text-gray-100 mb-2 tracking-tight">
          Welcome back!
        </h1>
        <p className="text-sm md:text-base text-gray-600/80 dark:text-gray-400/80">
          Here's what's happening with your files today!
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {statsData.map((stat, index) => (
          <div
            key={index}
            className="card-premium hover-lift flex flex-col items-center justify-center p-4 md:p-5 animate-fadeIn"
          >
            <p className="text-2xl md:text-3xl font-semibold text-gray-700/90 dark:text-gray-300/90 transition-all duration-200 mb-1.5">
              {animatedStats[index]}
            </p>
            <p className="text-xs text-gray-500/70 dark:text-gray-400/70 font-medium uppercase tracking-wide">
              {stat.label}
            </p>
          </div>
        ))}
      </div>

      {/* Quick Actions */}
      <div>
        <h2 className="text-xl md:text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4 tracking-tight">
          Quick Actions
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {quickActions.map((action, index) => {
            const Icon = action.icon;
            return (
              <button
                key={index}
                onClick={action.onClick}
                className={`
                  group p-4 md:p-5 rounded-xl transition-all duration-200
                  flex flex-col items-center space-y-2
                  border border-gray-300/30 dark:border-gray-700/50
                  bg-white dark:bg-slate-800
                  text-gray-900 dark:text-gray-100
                  hover-lift
                  focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:ring-offset-2 focus:ring-offset-transparent
                  active:scale-95
                  ${
                    action.isPrimary
                      ? "border-blue-500/30 bg-blue-50/50 dark:bg-blue-900/20 dark:border-blue-500/30"
                      : ""
                  }
                  ${action.hoverColor}
                `}
              >
                <Icon
                  className={`w-6 h-6 md:w-7 md:h-7 transition-colors duration-200 ${
                    action.isPrimary
                      ? "text-blue-600 dark:text-blue-400"
                      : "text-gray-600 dark:text-gray-400 group-hover:text-gray-900 dark:group-hover:text-gray-100"
                  }`}
                />
                <span className="text-sm font-semibold tracking-tight">
                  {action.title}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main content */}
      <div>
        <RecentFiles files={files} />
      </div>
    </div>
  );
};
