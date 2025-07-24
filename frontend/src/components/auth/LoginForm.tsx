import React, { useState, useEffect } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { Eye, EyeOff, Github } from "lucide-react";

export const LoginForm: React.FC<{ onSwitch: () => void }> = ({ onSwitch }) => {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);

  useEffect(() => {
    fetch(`${import.meta.env.VITE_API_URL}/api/google/enabled`)
      .then((r) => r.json())
      .then((d) => setGoogleEnabled(d.enabled))
      .catch(() => setGoogleEnabled(false));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await login(email, password);
    if (!ok) setError("Invalid credentials");
  };

  return (
    <div className="bg-white/80 dark:bg-gray-900/80 backdrop-blur-md rounded-2xl p-8 border border-gray-200 dark:border-gray-700 w-96 shadow-2xl">
      <form className="space-y-6" onSubmit={handleSubmit}>
        <div>
          <input
            className="border border-gray-300 dark:border-gray-600 rounded-xl px-4 py-3 w-full bg-gray-50/80 dark:bg-gray-800/80 focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm transition-all duration-200 text-base"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </div>
        <div className="relative">
          <input
            className="border border-gray-300 dark:border-gray-600 rounded-xl px-4 py-3 w-full bg-gray-50/80 dark:bg-gray-800/80 focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm transition-all duration-200 text-base pr-12"
            type={showPassword ? "text" : "password"}
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          <button
            type="button"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-blue-500 focus:outline-none"
            tabIndex={-1}
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? (
              <EyeOff className="w-5 h-5" />
            ) : (
              <Eye className="w-5 h-5" />
            )}
          </button>
        </div>
        {error && (
          <p
            className="text-red-500 text-sm font-medium animate-bounceIn"
            key={error}
          >
            {error}
          </p>
        )}
        <button
          type="submit"
          className="w-full bg-blue-500 hover:bg-blue-600 text-white px-4 py-3 rounded-xl shadow-md transition-all duration-200 text-base font-semibold tracking-tight"
        >
          Login
        </button>
        <div className="flex flex-col gap-2 mt-2 items-center">
          <button
            type="button"
            onClick={() => {
              window.location.href = `${import.meta.env.VITE_API_URL}/api/google/login`;
            }}
            disabled={!googleEnabled}
            className="flex items-center justify-center gap-2 w-full px-4 py-2 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl text-gray-700 dark:text-gray-300 font-medium hover:bg-gray-200 dark:hover:bg-gray-700 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Continue with Google
          </button>
          <button
            type="button"
            className="flex items-center justify-center gap-2 w-full px-4 py-2 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl text-gray-700 dark:text-gray-300 font-medium hover:bg-gray-200 dark:hover:bg-gray-700 transition-all duration-200"
            disabled
          >
            <Github className="w-5 h-5" /> Continue with GitHub
          </button>
        </div>
        <p className="text-sm text-center text-gray-500 dark:text-gray-400">
          No account?{" "}
          <button
            type="button"
            onClick={onSwitch}
            className="underline text-blue-500 hover:text-blue-700 font-medium transition-colors duration-200"
          >
            Sign up
          </button>
        </p>
      </form>
    </div>
  );
};
