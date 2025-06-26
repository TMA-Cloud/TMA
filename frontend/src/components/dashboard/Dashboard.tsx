import React from "react";
import { StorageChart } from "./StorageChart";
import { RecentFiles } from "./RecentFiles";
import { useApp } from "../../contexts/AppContext";
import { Upload, FolderPlus, Share2, Star } from "lucide-react";

export const Dashboard: React.FC = () => {
  const { files, setUploadModalOpen, createFolder } = useApp();

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
      onClick: () => {
        const name = window.prompt("Folder name");
        if (name) createFolder(name);
      },
    },
    {
      title: "Share Files",
      icon: Share2,
      color: "bg-purple-500 hover:bg-purple-600",
      onClick: () => {},
    },
    {
      title: "Starred Items",
      icon: Star,
      color: "bg-yellow-500 hover:bg-yellow-600",
      onClick: () => {},
    },
  ];

  const stats = [
    {
      label: "Total Files",
      value: files.filter((f) => f.type === "file").length,
    },
    {
      label: "Folders",
      value: files.filter((f) => f.type === "folder").length,
    },
    { label: "Shared", value: files.filter((f) => f.shared).length },
    { label: "Starred", value: files.filter((f) => f.starred).length },
  ];

  return (
    <div className="p-6 space-y-6">
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
            className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-200 dark:border-gray-700"
          >
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {stat.value}
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
                  p-4 rounded-xl text-white transition-colors duration-200
                  flex flex-col items-center space-y-2 ${action.color}
                `}
              >
                <Icon className="w-6 h-6" />
                <span className="text-sm font-medium">{action.title}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main content */}
      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <StorageChart
            used={15 * 1024 * 1024 * 1024}
            total={100 * 1024 * 1024 * 1024}
          />
        </div>
        <div className="lg:col-span-2">
          <RecentFiles files={files} />
        </div>
      </div>
    </div>
  );
};
