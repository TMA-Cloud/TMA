import React, { useState, useEffect } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { PasswordInput } from "./PasswordInput";
import { SocialAuthButtons } from "./SocialAuthButtons";
import { checkGoogleAuthEnabled } from "../../utils/api";

export const LoginForm: React.FC<{ onSwitch: () => void }> = ({ onSwitch }) => {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);

  useEffect(() => {
    checkGoogleAuthEnabled()
      .then(setGoogleEnabled)
      .catch((err) => {
        console.error("Failed to check Google auth status:", err);
        // Default to false on error
        setGoogleEnabled(false);
      });
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
        <PasswordInput
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          showPassword={showPassword}
          onTogglePassword={() => setShowPassword((v) => !v)}
        />
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
        <SocialAuthButtons googleEnabled={googleEnabled} />
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
