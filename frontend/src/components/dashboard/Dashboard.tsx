import React, { useEffect, useState, useMemo } from "react";
import { StorageChart } from "./StorageChart";
import { RecentFiles } from "./RecentFiles";
import { useApp } from "../../contexts/AppContext";
import { Upload, FolderPlus, Share2, Star } from "lucide-react";
import { useStorageUsage } from "../../hooks/useStorageUsage";

export const Dashboard: React.FC = () => {
  const {
    files,
    setUploadModalOpen,
    setCreateFolderModalOpen,
    setCurrentPath,
  } = useApp();
  const { usage, loading } = useStorageUsage();

  const quickActions = [
    {
      title: "Upload Files",
      icon: Upload,
      color: "bg-blue-500 hover:bg-blue-600",
      onClick: () => setUploadModalOpen(true),
    },
    {
      title: "Create Folder",
      icon: FolderPlus,
      color: "bg-green-500 hover:bg-green-600",
      onClick: () => setCreateFolderModalOpen(true),
    },
    {
      title: "Share Files",
      icon: Share2,
      color: "bg-purple-500 hover:bg-purple-600",
      onClick: () => setCurrentPath(["Shared with Me"]),
    },
    {
      title: "Starred Items",
      icon: Star,
      color: "bg-yellow-500 hover:bg-yellow-600",
      onClick: () => setCurrentPath(["Starred"]),
    },
  ];

  const fileCount = useMemo(
    () => files.filter((f) => f.type === "file").length,
    [files],
  );
  const folderCount = useMemo(
    () => files.filter((f) => f.type === "folder").length,
    [files],
  );
  const sharedCount = useMemo(
    () => files.filter((f) => f.shared).length,
    [files],
  );
  const starredCount = useMemo(
    () => files.filter((f) => f.starred).length,
    [files],
  );

  const stats = [
    { label: "Total Files", value: fileCount },
    { label: "Folders", value: folderCount },
    { label: "Shared", value: sharedCount },
    { label: "Starred", value: starredCount },
  ];

  const [animatedStats, setAnimatedStats] = useState([0, 0, 0, 0]);
  useEffect(() => {
    const durations = [600, 700, 800, 900];
    const values = [fileCount, folderCount, sharedCount, starredCount];
    values.forEach((val, i) => {
      let start = 0;
      const end = val;
      const duration = durations[i];
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
    <div className="p-6 space-y-6 bg-[radial-gradient(ellipse_at_top_left,_var(--tw-gradient-stops))] from-blue-50/40 via-white/80 to-transparent dark:from-blue-900/20 dark:via-gray-900/80 dark:to-transparent min-h-screen">
      {/* Welcome section */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
          Welcome back!
        </h1>
        <p className="text-gray-600 dark:text-gray-400">
          Here's what's happening with your files today.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat, index) => (
          <div
            key={index}
            className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-200 dark:border-gray-700 shadow-md flex flex-col items-center animate-bounceIn"
          >
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 transition-all duration-500">
              {animatedStats[index]}
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {stat.label}
            </p>
          </div>
        ))}
      </div>

      {/* Quick Actions */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
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
                  p-4 rounded-xl text-white transition-all duration-200
                  flex flex-col items-center space-y-2 ${action.color} shadow-md hover:scale-105 hover:shadow-xl
                `}
              >
                <Icon className="w-7 h-7 animate-bounceIn" />
                <span className="text-base font-semibold tracking-tight">
                  {action.title}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main content */}
      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <StorageChart
            used={usage?.used || 0}
            total={usage?.total || 0}
            free={usage?.free || 0}
            loading={loading || !usage}
          />
        </div>
        <div className="lg:col-span-2">
          <RecentFiles files={files} />
        </div>
      </div>
    </div>
  );
};
