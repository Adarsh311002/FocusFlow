import React, { useState } from "react";
import { api } from "../utils/api.js";
import { useNavigate } from "react-router-dom";

const SignInOut = () => {
  const [isSignIn, setIsSignIn] = useState(false);
  const [fullname, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accessToken, setAccessToken] = useState(null);
  const [user, setUser] = useState(null);
  const [error, setError] = useState("");

  const navigate = useNavigate();

  const handleToggle = (e) => {
    e.preventDefault();
    setIsSignIn(!isSignIn);
    setError("");
  };

  const handleSignUp = async (e) => {
    e.preventDefault();
    setError("");

    const endpoint = isSignIn ? "/users/login" : "/users/signup";
    const payload = isSignIn
      ? { email, password }
      : { fullname, email, password };

    try {
      const res = await api.post(
        endpoint,
        payload,
        { withCredentials: true }
      );

      const { accessToken, user, refreshToken } = res.data;

      console.log(accessToken);
      setAccessToken(accessToken);
      setUser(res.data.user);
      localStorage.setItem("accessToken", accessToken);
      localStorage.setItem("refreshToken", refreshToken); 
      localStorage.setItem("user", JSON.stringify(user));
      navigate("/dashboard");

      console.log(isSignIn ? "Login success" : "Signup success", res.data);

    } catch (error) {
      console.log(error);
      setError(error.response?.data?.message || "Signup failed");
    }
  };

  return (
    <div className="flex justify-center items-center min-h-screen bg-gradient-to-br from-[#6194d2] to-[#2ed97b]  ">
      <div className="grid grid-cols-1 md:grid-cols-[1.5fr_1fr] w-[90%] md:w-[80%] bg-slate-800 rounded-2xl overflow-hidden">
        {/* Left Section */}

        <div className="relative overflow-hidden p-10 text-gray-100">
          {/* Left content */}
          <img
            className=" absolute inset-0 w-full h-full object-cover opacity-80 mix-blend-lighten brightness-90"
            src="./robo2.png"
            alt="MvpImage"
          />

          <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
          <div className="relative z-10 max-w-md space-y-2">
            <h1 className="text-4xl md:text-5xl font-bold leading-tight text-[#282a2d]">
              Empower Yourself
            </h1>
            <p className="text-[#1d1e1eeb] text-md">
              AI-driven insights that help you focus, learn, and grow faster.
            </p>
          </div>
        </div>

        {/* Right Section */}
        <div className="p-8 md:p-10 bg-grid flex items-center justify-center text-gray-100 shadow-lg">
          <form className="w-full max-w-sm space-y-4 " onSubmit={handleSignUp}>
            {/* Header */}
            <div className="text-center md:text-left">
              <h1 className="text-3xl font-bold text-emerald-400">
                {isSignIn ? "Welcome Back" : "Go Into Flow"}
              </h1>
              <p className="mt-1 text-slate-400 text-sm">
                {isSignIn
                  ? "Log in to access your personalized insights."
                  : "Find focus worth your time."}
              </p>
            </div>

            {/* Full Name (Sign Up only) */}
            {!isSignIn && (
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-200">
                  Full Name
                </label>
                <input
                  type="text"
                  value={fullname}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Enter your full name"
                  className="w-full mt-1 rounded-xl bg-slate-900 border border-slate-700 px-3 py-3 text-sm outline-none focus:ring-2 focus:ring-emerald-400 focus:scale-[1.01] transition-all duration-200"
                />
              </div>
            )}

            {/* Email */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-200">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full mt-1 rounded-xl bg-slate-900 border border-slate-700 px-3 py-3 text-sm outline-none focus:ring-2 focus:ring-emerald-400 focus:scale-[1.01] transition-all duration-200"
              />
            </div>

            {/* Password */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-200">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-xl mt-1 bg-slate-900 border border-slate-700 px-3 py-3 text-sm outline-none focus:ring-2 focus:ring-emerald-400 focus:scale-[1.01] transition-all duration-200"
              />
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              className="w-full rounded-xl px-4 py-2 font-semibold bg-gradient-to-r from-emerald-600 to-emerald-700 
       hover:from-emerald-500 hover:to-emerald-500  transition-all duration-200 shadow-md cursor-pointer"
            >
              {isSignIn ? "LogIn -> " : "Discover the State  ->"}
            </button>

            {error && <p className="text-red-400">{error}</p>}

            {/* Toggle Button */}
            <button
              onClick={handleToggle}
              type="button"
              className="w-full text-sm text-emerald-300 hover:text-emerald-200 hover:underline transition-all duration-200"
            >
              {isSignIn
                ? "Need an account? Sign Up"
                : "Already have an account? Log In"}
            </button>

            {/* Divider */}
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-slate-700" />
              <span className="text-xs text-slate-400">OR</span>
              <div className="h-px flex-1 bg-slate-700" />
            </div>

            {/* Google Button */}
            <button
              type="button"
              className="w-full rounded-xl px-4 py-2 font-medium bg-slate-800 hover:bg-slate-700 active:bg-slate-600 border border-slate-700 flex items-center justify-center gap-2 shadow-sm hover:shadow-md transition-all duration-200"
            >
              <img
                src="https://www.svgrepo.com/show/475656/google-color.svg"
                alt="Google"
                className="w-5 h-5"
              />
              Continue with Google
            </button>

            {/* Privacy Text */}
            <p className="text-xs text-slate-500 text-center">
              Your privacy matters. We don’t share your personal data.
            </p>
          </form>
        </div>
      </div>
    </div>
  );
};

export default SignInOut;
