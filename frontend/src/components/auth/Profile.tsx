import React from "react";
import { useAuth } from "../../contexts/AuthContext";

export const Profile: React.FC = () => {
  const { user } = useAuth();

  if (!user) return null;

  return (
    <div className="p-4 space-y-2">
      <h2 className="text-lg font-bold">Profile</h2>
      <p>Email: {user.email}</p>
      {user.name && <p>Name: {user.name}</p>}
    </div>
  );
};
