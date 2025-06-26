import React, { useState } from "react";
import { useAuth } from "../../contexts/AuthContext";

export const LoginForm: React.FC<{ onSwitch: () => void }> = ({ onSwitch }) => {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await login(email, password);
    if (!ok) setError("Invalid credentials");
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl p-6 border border-gray-200 dark:border-gray-700 w-80">
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div>
          <input
            className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 w-full bg-gray-50 dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <input
            className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 w-full bg-gray-50 dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && <p className="text-red-500 text-sm">{error}</p>}
        <button
          type="submit"
          className="w-full bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-lg transition-colors duration-200"
        >
          Login
        </button>
        <p className="text-sm text-center">
          No account?{" "}
          <button
            type="button"
            onClick={onSwitch}
            className="underline text-blue-500"
          >
            Sign up
          </button>
        </p>
      </form>
    </div>
  );
};
