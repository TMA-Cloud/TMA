import React from 'react';

interface SettingsSectionProps {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  description?: string;
  children: React.ReactNode;
  index?: number;
}

export const SettingsSection: React.FC<SettingsSectionProps> = ({ title, icon: Icon, description, children }) => {
  return (
    <div
      className="relative"
      style={{
        animation: 'slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1) both',
      }}
    >
      <div className="flex items-center gap-4 mb-6">
        <div className="p-3 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-300">
          <Icon className="w-6 h-6 icon-muted" />
        </div>
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 tracking-tight">{title}</h2>
          {description && <p className="text-sm text-gray-500/80 dark:text-gray-400/80 mt-0.5">{description}</p>}
        </div>
      </div>

      <div className="space-y-4">{children}</div>
    </div>
  );
};
