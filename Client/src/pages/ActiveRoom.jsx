import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useSocket } from "../context/SocketContext";
import { useAuth } from "../context/AuthContext";
import { Clock, LogOut, Users, MessageSquare } from "lucide-react";

const ActiveRoom = () => {
  const { roomId } = useParams();
  const { socket } = useSocket();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [activeUsers, setActiveUsers] = useState([]);
  const [activityLog, setActivityLog] = useState([]);

  useEffect(() => {
    if (user) {
      console.log("Current User Object:", user);
    }

    if (!socket || !user) return;

    const actualName =
      user.name ||
      user.fullName ||
      user.username ||
      user.email?.split("@")[0] ||
      "Guest";
    const actualId = user._id || user.id || user.sub;

    if (!actualId) {
      console.error("Critical: User ID is missing!", user);
      return;
    }

    console.log(`Emitting join_room for: ${actualName} (${actualId})`);

    socket.emit("join_room", {
      roomId,
      userId: actualId,
      userName: actualName,
    });

    const handleExistingUsers = (users) => {
      console.log(" Received existing users:", users);
      setActiveUsers(users);
    };

    const handleUserJoined = (newUser) => {
      console.log(" New user joined:", newUser);
      setActivityLog((prev) => [...prev, `${newUser.userName} joined`]);
      setActiveUsers((prev) => {
        if (prev.some((u) => u.userId === newUser.userId)) return prev;
        return [...prev, newUser];
      });
    };

    const handleUserLeft = (data) => {
      setActivityLog((prev) => [...prev, `${data.userName} left`]);
      setActiveUsers((prev) => prev.filter((u) => u.userId !== data.userId)); 
    };

    socket.on("existing_users", handleExistingUsers);
    socket.on("user_joined", handleUserJoined);
    socket.on("user_left", handleUserLeft);

    return () => {
      socket.emit("leave_room", {
        roomId,
        userId: actualId,
        userName: actualName,
      });
      socket.off("existing_users", handleExistingUsers);
      socket.off("user_joined", handleUserJoined);
      socket.off("user_left", handleUserLeft);
    };
  }, [socket, roomId, user]); 

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col">
      <header className="border-b border-gray-800 p-4 flex justify-between items-center bg-gray-950">
        <div className="flex items-center gap-3">
          <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
          <h1 className="text-xl font-bold font-mono tracking-wider">
            ROOM: {roomId}
          </h1>
        </div>
        <button
          onClick={() => navigate("/dashboard")} 
          className="text-gray-400 hover:text-red-400 flex items-center gap-2 text-sm transition"
        >
          <LogOut size={16} /> Leave
        </button>
      </header>

      <div className="flex-1 grid grid-cols-1 md:grid-cols-3 p-6 gap-6">
        <div className="md:col-span-2 bg-gray-800 rounded-2xl p-8 flex flex-col items-center justify-center border border-gray-700 shadow-xl relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500"></div>
          <Clock size={64} className="text-indigo-400 mb-4 opacity-80" />
          <h2 className="text-4xl font-bold mb-2">Focus Session</h2>
          <p className="text-gray-400">Waiting for host to start timer...</p>
        </div>

        <div className="flex flex-col gap-6">
          <div className="bg-gray-800 rounded-xl p-6 border border-gray-700 h-1/2">
            <div className="flex items-center gap-2 mb-4 text-indigo-300">
              <Users size={20} />
              <h3 className="font-semibold">
                Live Members ({activeUsers.length})
              </h3>
            </div>
            <ul className="space-y-3">
              {activeUsers.map((u, i) => (
                <li
                  key={i}
                  className="flex items-center gap-3 bg-gray-700/30 p-2 rounded-md"
                >
                  <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold uppercase">
                    {u.userName ? u.userName.charAt(0) : "?"}
                  </div>
                  <span className="text-sm font-medium">
                    {u.userName}{" "}
                    {u.userId === (user?._id || user?.id) && (
                      <span className="text-indigo-400 text-xs ml-1">
                        (You)
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="bg-gray-800 rounded-xl p-6 border border-gray-700 h-1/2 overflow-y-auto">
            <div className="flex items-center gap-2 mb-4 text-gray-400">
              <MessageSquare size={18} />
              <h3 className="font-semibold text-sm uppercase tracking-wider">
                Activity Log
              </h3>
            </div>
            <div className="space-y-2 text-xs text-gray-400 font-mono">
              {activityLog.length === 0 && (
                <p className="italic opacity-50">No activity yet...</p>
              )}
              {activityLog.map((log, i) => (
                <p key={i}>&gt; {log}</p>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ActiveRoom;
