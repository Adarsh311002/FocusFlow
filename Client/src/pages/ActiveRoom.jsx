import React, { useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useSocket } from "../context/SocketContext";
import { useAuth } from "../context/AuthContext";
import { Users, Clock, LogOut, MessageSquare } from "lucide-react";
import { useState } from "react";

const ActiveRoom = () => {
    const {roomId} = useParams();
    const {socket} = useSocket();
    const {user} = useAuth();
    const navigate = useNavigate();

    const [activeUsers, setActiveUsers] = useState([]);
    const [activityLog, setActivityLog] = useState([]);

    useEffect(() => {
        if(!socket || !user) return;

        socket.emit("join_room",{
            roomId,
            userId : user._id,
            userName : user.name,
        });

        socket.on("user_joined",(data) => {
            setActivityLog((prev) => [...prev, `${data.userName} joined the room`]);
            setActiveUsers((prev) => [...prev, data]);

        })

        socket.on("user_left", (data) => {
            setActivityLog((prev) => [...prev, `${data.userNane} left the room`]);
        })


        return () => {
            socket.emit("leave_room", {roomId, userName : user.name});
            socket.off("user_joined");
            socket.off("user_left");
        }


    },[socket, roomId, user]);


    return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col">
      {/* Header */}
      <header className="border-b border-gray-800 p-4 flex justify-between items-center bg-gray-950">
        <div className="flex items-center gap-3">
          <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
          <h1 className="text-xl font-bold font-mono tracking-wider">ROOM: {roomId}</h1>
        </div>
        <button 
            onClick={() => navigate("/rooms")}
            className="text-gray-400 hover:text-red-400 flex items-center gap-2 text-sm transition"
        >
            <LogOut size={16} /> Leave
        </button>
      </header>

      {/* Main Content Grid */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-3 p-6 gap-6">
        
        {/* Left Col: Focus Timer Area */}
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
                    <h3 className="font-semibold">Live Members</h3>
                </div>
                <ul className="space-y-3">
                    <li className="flex items-center gap-3 bg-gray-700/50 p-2 rounded-lg">
                        <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold">
                            {user?.name?.charAt(0)}
                        </div>
                        <span className="text-sm">{user?.name} (You)</span>
                    </li>
                    {activeUsers.map((u, i) => (
                        <li key={i} className="flex items-center gap-3">
                             <div className="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center text-xs font-bold">
                                {u.userName?.charAt(0)}
                            </div>
                            <span className="text-sm">{u.userName}</span>
                        </li>
                    ))}
                </ul>
            </div>

            <div className="bg-gray-800 rounded-xl p-6 border border-gray-700 h-1/2 overflow-y-auto">
                 <div className="flex items-center gap-2 mb-4 text-gray-400">
                    <MessageSquare size={18} />
                    <h3 className="font-semibold text-sm uppercase tracking-wider">Activity Log</h3>
                </div>
                <div className="space-y-2 text-xs text-gray-400 font-mono">
                    {activityLog.length === 0 && <p className="italic opacity-50">No activity yet...</p>}
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
    
