import React, { useRef, useState } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { User as UserIcon, Upload as UploadIcon } from "lucide-react";

export const Profile: React.FC = () => {
  const { user } = useAuth();
  const [avatar, setAvatar] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!user) return null;

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => setAvatar(ev.target?.result as string);
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="p-6 bg-white/80 dark:bg-gray-900/80 backdrop-blur-md rounded-2xl border border-gray-200 dark:border-gray-700 shadow-xl w-96 mx-auto mt-8 space-y-4">
      <div className="flex flex-col items-center space-y-3 mb-4">
        <div className="relative group">
          <div className="w-20 h-20 rounded-full bg-blue-500 flex items-center justify-center shadow-lg overflow-hidden animate-bounceIn">
            {avatar ? (
              <img
                src={avatar}
                alt="avatar"
                className="w-full h-full object-cover"
              />
            ) : (
              <UserIcon className="w-10 h-10 text-white" />
            )}
          </div>
          <button
            className="absolute bottom-0 right-0 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-full p-2 shadow-md hover:bg-blue-100 dark:hover:bg-blue-900 transition-all duration-200"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Upload avatar"
            type="button"
          >
            <UploadIcon className="w-4 h-4 text-blue-500" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleAvatarChange}
          />
        </div>
      </div>
      <h2 className="text-2xl font-extrabold text-gray-900 dark:text-gray-100 mb-2 tracking-tight text-center">
        Profile
      </h2>
      <div className="space-y-1 text-center">
        <p className="text-base text-gray-700 dark:text-gray-300">
          <span className="font-semibold">Email:</span> {user.email}
        </p>
        {user.name && (
          <p className="text-base text-gray-700 dark:text-gray-300">
            <span className="font-semibold">Name:</span> {user.name}
          </p>
        )}
      </div>
    </div>
  );
};
