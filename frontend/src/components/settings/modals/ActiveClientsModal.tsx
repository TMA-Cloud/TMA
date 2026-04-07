import React from 'react';
import { Loader2, Monitor } from 'lucide-react';
import { format } from 'date-fns';
import { Modal } from '../../ui/Modal';
import type { ActiveClient } from '../../../utils/api';

interface ActiveClientsModalProps {
  isOpen: boolean;
  onClose: () => void;
  clients: ActiveClient[];
  loading: boolean;
  onRefresh: () => void;
}

function platformLabel(platform: string | null): string {
  if (!platform) return 'Unknown';
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  return platform;
}

export const ActiveClientsModal: React.FC<ActiveClientsModalProps> = ({
  isOpen,
  onClose,
  clients,
  loading,
  onRefresh,
}) => {
  const versionGroups = new Map<string, number>();
  for (const c of clients) {
    versionGroups.set(c.appVersion, (versionGroups.get(c.appVersion) ?? 0) + 1);
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Active Desktop Clients" size="lg">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {clients.length > 0
              ? `${clients.length} active client${clients.length === 1 ? '' : 's'}`
              : 'No active desktop clients'}
          </p>
          <button
            onClick={onRefresh}
            disabled={loading}
            className={`
              px-3 py-1 text-sm rounded-lg transition-colors duration-200 border
              ${
                loading
                  ? 'border-gray-300 dark:border-gray-600 text-gray-400 cursor-not-allowed'
                  : 'border-blue-500 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20'
              }
            `}
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        {versionGroups.size > 1 && (
          <div className="flex flex-wrap gap-2">
            {[...versionGroups.entries()].map(([ver, count]) => (
              <span
                key={ver}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800"
              >
                v{ver}
                <span className="font-semibold">&times; {count}</span>
              </span>
            ))}
          </div>
        )}

        {loading ? (
          <p className="text-center text-gray-600 dark:text-gray-300 flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading clients...
          </p>
        ) : clients.length === 0 ? (
          <p className="text-center text-gray-600 dark:text-gray-300">
            No Electron desktop clients have reported in the last 5 minutes
          </p>
        ) : (
          <div className="space-y-3 overflow-y-auto max-h-[60vh]">
            {clients.map(client => (
              <div
                key={client.id}
                className="flex flex-col gap-2 p-4 rounded-xl bg-[#dfe3ea]/95 dark:bg-gray-900/60 border border-gray-200 dark:border-gray-700"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <Monitor className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {client.userName || client.userEmail}
                      </p>
                    </div>
                    {client.userName && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 ml-6 mb-1">{client.userEmail}</p>
                    )}
                    <div className="text-xs text-gray-500 dark:text-gray-500 space-y-0.5 ml-6">
                      <p>
                        Platform: {platformLabel(client.platform)} &middot; Version:{' '}
                        <span className="font-semibold text-gray-700 dark:text-gray-300">v{client.appVersion}</span>
                      </p>
                      {client.ipAddress && <p>IP: {client.ipAddress}</p>}
                      <p>Last seen: {format(new Date(client.lastSeenAt), "MMM d, yyyy 'at' h:mm a")}</p>
                    </div>
                  </div>
                  <span className="px-2.5 py-1 text-xs rounded-full bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800 whitespace-nowrap">
                    v{client.appVersion}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
};
