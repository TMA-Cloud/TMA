import React from 'react';

interface SettingsSectionProps {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  description?: string;
  children: React.ReactNode;
  index?: number;
}

export const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  icon: Icon,
  description,
  children,
  index = 0,
}) => {
  return (
    <div
      className="relative overflow-hidden card-premium hover-lift spacing-card"
      style={{
        animation: 'slideUp 0.45s cubic-bezier(0.16, 1, 0.3, 1) both',
        animationDelay: `${index * 80}ms`,
      }}
    >
      <div className="flex flex-wrap items-center gap-5 mb-8">
        <div className="p-4 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-300">
          <Icon className="w-6 h-6 icon-muted" />
        </div>
        <div>
          <h3 className="text-2xl md:text-3xl font-bold text-gray-900 dark:text-gray-100 tracking-tight mb-2">
            {title}
          </h3>
          {description && <p className="text-base text-gray-500/80 dark:text-gray-400/80">{description}</p>}
        </div>
      </div>

      <div className="space-y-5">{children}</div>
    </div>
  );
};
