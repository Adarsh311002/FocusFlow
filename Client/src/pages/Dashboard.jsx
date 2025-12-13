import React from "react";
import { useAuth } from "../context/AuthContext.jsx";
import PomodoroTimer from "../components/PomodoroTimer.jsx";
import TaskBoard from "../components/TaskBoard.jsx";

const Dashboard = () => {
    const { user, logout } = useAuth();

    return (
      <div className="h-screen w-screen flex flex-col justify-center items-center text-white bg-slate-900 gap-4">
        <h1 className="text-4xl text-blue-500">
          Welcome, {user?.fullname || "User"}!
        </h1>
        <p>Your email is: {user?.email}</p>

        <PomodoroTimer />

        <div className="md:col-span-2 h-[350px]">
          <TaskBoard />
        </div>
        <button
          onClick={logout}
          className="bg-red-500 hover:bg-red-600 px-4 py-2 rounded-lg transition-all"
        >
          Logout
        </button>
      </div>
    );

}

export default Dashboard;


