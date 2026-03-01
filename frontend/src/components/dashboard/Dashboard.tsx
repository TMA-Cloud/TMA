import React, { useEffect, useState } from 'react';
import { RecentFiles } from './RecentFiles';
import { useApp } from '../../contexts/AppContext';
import { Upload, FolderPlus, Share2, Star } from 'lucide-react';
import { apiGet } from '../../utils/api';

interface FileStats {
  totalFiles: number;
  totalFolders: number;
  sharedCount: number;
  starredCount: number;
}

export const Dashboard: React.FC = () => {
  const { files, setUploadModalOpen, setCreateFolderModalOpen, setCurrentPath } = useApp();
  const [stats, setStats] = useState<FileStats>({
    totalFiles: 0,
    totalFolders: 0,
    sharedCount: 0,
    starredCount: 0,
  });

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const data = await apiGet<FileStats>('/api/files/stats');
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
      if (document.visibilityState === 'visible') {
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
      if (document.visibilityState === 'visible') {
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
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const quickActions = [
    {
      title: 'Upload Files',
      icon: Upload,
      isPrimary: true,
      hoverColor: 'hover:border-[#5b8def]/30 hover:bg-[#5b8def]/10 dark:hover:bg-[#5b8def]/20',
      onClick: () => setUploadModalOpen(true),
    },
    {
      title: 'Create Folder',
      icon: FolderPlus,
      isPrimary: false,
      hoverColor: 'hover:border-emerald-400/30 hover:bg-emerald-500/10 dark:hover:bg-emerald-500/20',
      onClick: () => setCreateFolderModalOpen(true),
    },
    {
      title: 'Share Files',
      icon: Share2,
      isPrimary: false,
      hoverColor: 'hover:border-violet-400/30 hover:bg-violet-500/10 dark:hover:bg-violet-500/20',
      onClick: () => setCurrentPath(['Shared']),
    },
    {
      title: 'Starred Items',
      icon: Star,
      isPrimary: false,
      hoverColor: 'hover:border-amber-400/30 hover:bg-amber-500/10 dark:hover:bg-amber-500/20',
      onClick: () => setCurrentPath(['Starred']),
    },
  ];

  const fileCount = stats.totalFiles;
  const folderCount = stats.totalFolders;
  const sharedCount = stats.sharedCount;
  const starredCount = stats.starredCount;

  const statsData = [
    { label: 'Total Files', value: fileCount },
    { label: 'Folders', value: folderCount },
    { label: 'Shared', value: sharedCount },
    { label: 'Starred', value: starredCount },
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
        setAnimatedStats(prev => {
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
    <div className="p-6 md:p-8 min-h-screen bg-gradient-to-br from-[#e8ecf1] via-[#eef2f6] to-[#e2e7ee] dark:from-[#0f172a] dark:via-[#1e293b] dark:to-[#1a2332]">
      <div className="space-y-8 max-w-6xl mx-auto">
        {/* Welcome section */}
        <div>
          <h1 className="text-3xl md:text-4xl font-bold text-slate-800 dark:text-slate-100 mb-2 tracking-tight">
            Welcome back
          </h1>
          <p className="text-sm md:text-base text-slate-600 dark:text-slate-400">
            Here's what's happening with your files today.
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {statsData.map((stat, index) => (
            <div
              key={index}
              className="card-premium hover-lift flex flex-col items-center justify-center p-5 md:p-6 animate-fadeIn rounded-2xl"
            >
              <p className="text-2xl md:text-3xl font-semibold text-slate-700 dark:text-slate-200 transition-all duration-300 mb-1.5">
                {animatedStats[index]}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-medium uppercase tracking-wide">
                {stat.label}
              </p>
            </div>
          ))}
        </div>

        {/* Quick Actions */}
        <div>
          <h2 className="text-xl md:text-2xl font-bold text-slate-800 dark:text-slate-100 mb-4 tracking-tight">
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
                  group p-5 md:p-6 rounded-2xl transition-all duration-300 ease-out
                  flex flex-col items-center gap-2
                  border border-slate-200/60 dark:border-slate-700/50
                  bg-[#f0f3f7] dark:bg-slate-800/80
                  text-slate-800 dark:text-slate-100
                  hover-lift
                  focus:outline-none focus:ring-2 focus:ring-[#5b8def]/40 focus:ring-offset-2 focus:ring-offset-transparent
                  active:scale-[0.98]
                  ${
                    action.isPrimary
                      ? 'border-[#5b8def]/25 bg-[#5b8def]/8 dark:bg-[#5b8def]/15 dark:border-[#5b8def]/30'
                      : ''
                  }
                  ${action.hoverColor}
                `}
                >
                  <Icon
                    className={`w-6 h-6 md:w-7 md:h-7 transition-colors duration-300 ${
                      action.isPrimary
                        ? 'text-[#4a7edb] dark:text-blue-400'
                        : 'text-slate-500 dark:text-slate-400 group-hover:text-slate-700 dark:group-hover:text-slate-200'
                    }`}
                  />
                  <span className="text-sm font-semibold tracking-tight">{action.title}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <RecentFiles files={files} />
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
