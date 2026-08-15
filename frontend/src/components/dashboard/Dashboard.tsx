import React, { useEffect, useRef, useState } from 'react';
import { RecentFiles } from './RecentFiles';
import { useApp, type FileItem } from '../../contexts/AppContext';
import { useAuth } from '../../contexts/AuthContext';
import { Upload, FolderPlus, Share2, Star } from 'lucide-react';
import { apiGet, getRecentFiles } from '../../utils/api';
import { mapFileResponse } from '../../utils/fileUtils';
import { SPRING_PRESETS, useReducedMotion, useSpring } from '../../motion';

interface FileStats {
  totalFiles: number;
  totalFolders: number;
  sharedCount: number;
  starredCount: number;
}

/** Rows the recent panel shows. The server returns exactly this many. */
const RECENT_LIMIT = 5;

/**
 * A number that springs to its value reads as the figure arriving rather than
 * a slot machine settling: it starts fast, decelerates into place, and — being
 * a spring — simply retargets if the next poll lands mid-count.
 */
const StatValue: React.FC<{ value: number }> = ({ value }) => {
  const nodeRef = useRef<HTMLParagraphElement>(null);
  const spring = useSpring(0, SPRING_PRESETS.move);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    return spring.subscribe(current => {
      const node = nodeRef.current;
      if (node) node.textContent = String(Math.round(current));
    });
  }, [spring]);

  useEffect(() => {
    if (reducedMotion) spring.jump(value);
    else spring.setTarget(value);
  }, [value, spring, reducedMotion]);

  // Tabular figures stop the column jittering as digits change width.
  return <p ref={nodeRef} className="type-title-1 text-[var(--label)] tabular-nums" />;
};

export const Dashboard: React.FC = () => {
  const { setUploadModalOpen, setCreateFolderModalOpen, setCurrentPath } = useApp();
  const { can } = useAuth();
  const [stats, setStats] = useState<FileStats>({
    totalFiles: 0,
    totalFolders: 0,
    sharedCount: 0,
    starredCount: 0,
  });
  const [recentFiles, setRecentFiles] = useState<FileItem[]>([]);

  useEffect(() => {
    // Both panels are a snapshot of the same moment, so they refresh together
    // and one failing does not blank the other.
    const fetchStats = async () => {
      const [statsResult, recentResult] = await Promise.allSettled([
        apiGet<FileStats>('/api/files/stats'),
        getRecentFiles(RECENT_LIMIT),
      ]);

      // Failures leave the last good values on screen: a dropped poll should
      // not empty a panel that was correct a minute ago.
      if (statsResult.status === 'fulfilled') setStats(statsResult.value);
      if (recentResult.status === 'fulfilled') setRecentFiles(recentResult.value.map(mapFileResponse));
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

  // The two navigation tiles are always available; the two that start a write
  // are dropped for sub-users who lack the upload grant.
  const quickActions = [
    ...(can('files.upload')
      ? [
          {
            title: 'Upload files',
            icon: Upload,
            tint: 'var(--accent)',
            isPrimary: true,
            onClick: () => setUploadModalOpen(true),
          },
          {
            title: 'New folder',
            icon: FolderPlus,
            tint: 'var(--positive)',
            isPrimary: false,
            onClick: () => setCreateFolderModalOpen(true),
          },
        ]
      : []),
    {
      title: 'Shared',
      icon: Share2,
      tint: 'var(--accent)',
      isPrimary: false,
      onClick: () => setCurrentPath(['Shared']),
    },
    {
      title: 'Starred',
      icon: Star,
      tint: 'var(--warning)',
      isPrimary: false,
      onClick: () => setCurrentPath(['Starred']),
    },
  ];

  const statsData = [
    { label: 'Files', value: stats.totalFiles },
    { label: 'Folders', value: stats.totalFolders },
    { label: 'Shared', value: stats.sharedCount },
    { label: 'Starred', value: stats.starredCount },
  ];

  return (
    <div className="px-6 md:px-8 pt-6 pb-16">
      <div className="space-y-8 max-w-5xl mx-auto">
        {/* Welcome section */}
        <div>
          <h1 className="type-title-1 text-[var(--label)]">Welcome back</h1>
          <p className="type-callout text-[var(--label-secondary)] mt-1">Here is where your files stand today.</p>
        </div>

        {/* Stats — a status report, so it is quiet: no tile competes with the
            actions below it. */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {statsData.map(stat => (
            <div key={stat.label} className="card flex flex-col items-start justify-center px-5 py-4">
              <StatValue value={stat.value} />
              <p className="type-caption text-[var(--label-tertiary)] mt-0.5">{stat.label}</p>
            </div>
          ))}
        </div>

        {/* Quick Actions */}
        <div>
          <h2 className="type-title-3 text-[var(--label)] mb-3">Quick actions</h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {quickActions.map(action => {
              const Icon = action.icon;
              return (
                <button
                  key={action.title}
                  onClick={action.onClick}
                  className={`pressable-lg card flex flex-col items-start gap-3 p-5 text-left hover:border-[var(--separator-strong)] ${
                    action.isPrimary ? 'border-[var(--accent-ring)] bg-[var(--accent-fill)]' : ''
                  }`}
                >
                  <Icon className="w-5 h-5" style={{ color: action.tint }} strokeWidth={2} />
                  <span className="type-callout type-emphasized text-[var(--label)]">{action.title}</span>
                </button>
              );
            })}
          </div>
        </div>

        <RecentFiles files={recentFiles} />
      </div>
    </div>
  );
};

export default Dashboard;
