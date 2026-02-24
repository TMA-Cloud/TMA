import React from 'react';
import { Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { Modal } from '../../ui/Modal';
import type { ActiveSession } from '../../../utils/api';

interface SessionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeSessions: ActiveSession[];
  loadingSessions: boolean;
  revokingSessionId: string | null;
  onRefresh: () => void;
  onRevokeSession: (sessionId: string) => void;
}

const getDeviceInfo = (ua: string) => {
  if (ua.includes('Mobile') || ua.includes('Android') || ua.includes('iPhone')) {
    return 'Mobile';
  }
  if (ua.includes('Windows')) return 'Windows';
  if (ua.includes('Mac')) return 'Mac';
  if (ua.includes('Linux')) return 'Linux';
  return 'Unknown';
};

export const SessionsModal: React.FC<SessionsModalProps> = ({
  isOpen,
  onClose,
  activeSessions,
  loadingSessions,
  revokingSessionId,
  onRefresh,
  onRevokeSession,
}) => {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Active Sessions" size="lg">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {activeSessions.length > 0
              ? `${activeSessions.length} active session${activeSessions.length === 1 ? '' : 's'}`
              : 'No active sessions'}
          </p>
          <button
            onClick={onRefresh}
            disabled={loadingSessions}
            className={`
              px-3 py-1 text-sm rounded-lg transition-colors duration-200 border
              ${
                loadingSessions
                  ? 'border-gray-300 dark:border-gray-600 text-gray-400 cursor-not-allowed'
                  : 'border-blue-500 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20'
              }
            `}
          >
            {loadingSessions ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        {loadingSessions ? (
          <p className="text-center text-gray-600 dark:text-gray-300 flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading sessions...
          </p>
        ) : activeSessions.length === 0 ? (
          <p className="text-center text-gray-600 dark:text-gray-300">No active sessions found.</p>
        ) : (
          <div className="space-y-3 overflow-y-auto max-h-[60vh]">
            {activeSessions.map(session => {
              const isRevoking = revokingSessionId === session.id;
              const userAgent = session.user_agent || 'Unknown device';
              const ipAddress = session.ip_address || 'Unknown location';
              const createdAt = new Date(session.created_at);
              const lastActivity = new Date(session.last_activity);
              const isCurrentSession = session.isCurrent || false;

              return (
                <div
                  key={session.id}
                  className="flex flex-col gap-3 p-4 rounded-xl bg-gray-50/70 dark:bg-gray-900/60 border border-gray-200 dark:border-gray-700"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          {getDeviceInfo(userAgent)}
                        </p>
                        {isCurrentSession && (
                          <span className="px-2 py-0.5 text-xs rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
                            Current
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-600 dark:text-gray-400 mb-1">
                        {userAgent.length > 60 ? `${userAgent.slice(0, 60)}...` : userAgent}
                      </p>
                      <div className="text-xs text-gray-500 dark:text-gray-500 space-y-0.5">
                        <p>IP: {ipAddress}</p>
                        <p>Created: {format(new Date(createdAt), "MMM d, yyyy 'at' h:mm a")}</p>
                        <p>Last activity: {format(new Date(lastActivity), "MMM d, yyyy 'at' h:mm a")}</p>
                      </div>
                    </div>
                    {!isCurrentSession && (
                      <button
                        onClick={() => onRevokeSession(session.id)}
                        disabled={isRevoking}
                        className={`
                          px-3 py-1.5 text-xs rounded-lg transition-colors duration-200 border
                          ${
                            isRevoking
                              ? 'border-gray-300 dark:border-gray-600 text-gray-400 cursor-not-allowed'
                              : 'border-red-500/40 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30'
                          }
                        `}
                      >
                        {isRevoking ? (
                          <span className="flex items-center gap-1">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Revoking...
                          </span>
                        ) : (
                          'Revoke'
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
};
