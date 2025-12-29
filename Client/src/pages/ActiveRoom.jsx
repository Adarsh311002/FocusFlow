import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useSocket } from "../context/SocketContext";
import { useAuth } from "../context/AuthContext";
import { LogOut, Users, Check, X } from "lucide-react"; 
import { fetchRooms } from "../utils/roomService";
import PomodoroTimer from "../components/PomodoroTimer";
import ChatBox from "../components/ChatBox";

const ActiveRoom = () => {
  const { roomId } = useParams();
  const { socket } = useSocket();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [activeUsers, setActiveUsers] = useState([]);
  const [isHost, setIsHost] = useState(false);
  const [knockQueue, setKnockQueue] = useState([]); 
 
  useEffect(() => {
    const checkRoomAdmin = async () => {
      try {
        const data = await fetchRooms();
        const currentRoom = data?.rooms?.find((r) => r.roomId === roomId);

        if (currentRoom) {
          const adminId = currentRoom.admin._id || currentRoom.admin;
          const myId = user?._id || user?.id;

          if (adminId && myId && adminId.toString() === myId.toString()) {
            setIsHost(true);
          }
        }
      } catch (error) {
        console.error("Error checking admin status", error);
      }
    };

    if (user && roomId) {
      checkRoomAdmin();
    }
  }, [user, roomId]);

  useEffect(() => {
    if (!socket) return;

    const handleKnock = (data) => {
      if (isHost) {
        // const audio = new Audio('/sounds/knock.mp3'); audio.play();

        setKnockQueue((prev) => {
          if (prev.find((k) => k.userId === data.userId)) return prev;
          return [...prev, data];
        });
      }
    };

    socket.on("receive_knock", handleKnock);

    return () => {
      socket.off("receive_knock", handleKnock);
    };
  }, [socket, isHost]);

  const handleKnockResponse = (userId, action) => {
    socket.emit("respond_knock", { roomId, userId, action });
    setKnockQueue((prev) => prev.filter((k) => k.userId !== userId));
  };

  useEffect(() => {
    if (!socket || !user) return;

    const actualName =
      user.name ||
      user.fullName ||
      user.username ||
      user.email?.split("@")[0] ||
      "Guest";
    const actualId = user._id || user.id || user.sub;

    socket.emit("join_room", {
      roomId,
      userId: actualId,
      userName: actualName,
    });

    socket.on("existing_users", (users) => setActiveUsers(users));

    socket.on("user_joined", (newUser) => {
      setActiveUsers((prev) => {
        if (prev.some((u) => u.userId === newUser.userId)) return prev;
        return [...prev, newUser];
      });
    });

    socket.on("user_left", (data) => {
      setActiveUsers((prev) => prev.filter((u) => u.userId !== data.userId));
    });

    

    return () => {
      socket.emit("leave_room", {
        roomId,
        userId: actualId,
        userName: actualName,
      });
      socket.off("existing_users");
      socket.off("user_joined");
      socket.off("user_left");
    };
  }, [socket, roomId, user]);

  const chatUserName =
    user?.name ||
    user?.fullName ||
    user?.username ||
    user?.email?.split("@")[0] ||
    "Guest";
  const chatUserId = user?._id || user?.id || user?.sub;

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col relative">
      {isHost && knockQueue.length > 0 && (
        <div className="absolute top-20 right-4 z-50 flex flex-col gap-2 w-80">
          {knockQueue.map((k) => (
            <div
              key={k.userId}
              className="bg-gray-800 border border-indigo-500/50 p-4 rounded-xl shadow-2xl flex items-center justify-between animate-in slide-in-from-right duration-300"
            >
              <div>
                <p className="font-bold text-sm text-white">{k.userName}</p>
                <p className="text-xs text-indigo-300">wants to join...</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleKnockResponse(k.userId, "approve")}
                  className="p-2 bg-green-500/20 text-green-400 rounded-full hover:bg-green-500 hover:text-white transition-colors"
                  title="Approve"
                >
                  <Check size={18} />
                </button>
                <button
                  onClick={() => handleKnockResponse(k.userId, "reject")}
                  className="p-2 bg-red-500/20 text-red-400 rounded-full hover:bg-red-500 hover:text-white transition-colors"
                  title="Reject"
                >
                  <X size={18} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

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
          <PomodoroTimer
            socket={socket}
            roomId={roomId}
            isHost={isHost}
            isGroupMode={true}
          />
        </div>

        <div className="flex flex-col gap-6 h-[calc(100vh-140px)]">
          <div className="bg-gray-800 rounded-xl p-6 border border-gray-700 h-1/2 overflow-hidden flex flex-col">
            <div className="flex items-center gap-2 mb-4 text-indigo-300">
              <Users size={20} />
              <h3 className="font-semibold">
                Live Members ({activeUsers.length})
              </h3>
            </div>
            <ul className="space-y-3 overflow-y-auto pr-2 custom-scrollbar">
              {activeUsers.map((u, i) => (
                <li
                  key={i}
                  className="flex items-center gap-3 bg-gray-700/30 p-2 rounded-md"
                >
                  <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold uppercase shrink-0">
                    {u.userName ? u.userName.charAt(0) : "?"}
                  </div>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium truncate max-w-[120px]">
                      {u.userName}
                    </span>
                    {u.userId === chatUserId && (
                      <span className="text-indigo-400 text-[10px] uppercase font-bold tracking-wider">
                        (You)
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <ChatBox
            socket={socket}
            roomId={roomId}
            userName={chatUserName}
            userId={chatUserId}
          />
        </div>
      </div>
    </div>
  );
};

export default ActiveRoom;
