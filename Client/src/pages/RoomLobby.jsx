import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useSocket } from "../context/SocketContext";
import { fetchRooms, createRoom, joinRoom } from "../utils/roomService";
import { Loader2, Users, Plus, Lock, Unlock } from "lucide-react";

const RoomLobby = () => {
  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isKnocking, setIsKnocking] = useState(false);

  const { user } = useAuth();
  const { socket } = useSocket();
  const navigate = useNavigate();

  useEffect(() => {
    const fetchAllRooms = async () => {
      try {
        const data = await fetchRooms();
        setRooms(data?.rooms || []);
      } catch (error) {
        console.error("Failed to fetch rooms", error);
      } finally {
        setLoading(false);
      }
    };
    fetchAllRooms();
  }, []);

  const handleCreateRoom = async () => {
    const roomName = prompt("Enter Room Name (e.g., 'Deep Work ')");
    if (!roomName) return;

    const isPrivate = window.confirm(
      "Would you like to make this room Private?\n\nOK = Private (Knock to Join)\nCancel = Public (Open to Everyone)"
    );

    try {
      const data = await createRoom({
        name: roomName,
        topic: "Focus Session",
        isPrivate: isPrivate,
      });

      if (data.success) {
        navigate(`/room/${data.room.roomId}`);
      }
    } catch (error) {
      console.error("Error creating room:", error);
      alert("Failed to create room. Please try again.");
    }
  };

  const handleJoinAttempt = async (room) => {
    const myId = user?._id || user?.id;

    const adminId = room.admin?._id || room.admin;
    const isAdmin = adminId === myId;

    const isMember = room.members.some((m) => {
      const memberId = m._id || m;
      return memberId === myId;
    });

    if (!room.isPrivate || isAdmin || isMember) {
      try {
        await joinRoom(room.roomId);
        navigate(`/room/${room.roomId}`);
      } catch (error) {
        console.error("Error joining room", error);
        alert("Failed to join room.");
      }
      return;
    }

    if (!socket || !user) return;

    setIsKnocking(true);
    const actualName = user.name || user.fullName || "Guest";

    socket.emit("knock_room", {
      roomId: room.roomId,
      userId: myId,
      userName: actualName,
    });

    const responseHandler = ({ userId, action }) => {
      if (userId === myId) {
        setIsKnocking(false);
        socket.off("knock_response", responseHandler);

        if (action === "approve") {
          joinRoom(room.roomId).then(() => {
            navigate(`/room/${room.roomId}`);
          });
        } else {
          alert("The host denied your request.");
        }
      }
    };

    socket.on("knock_response", responseHandler);

    setTimeout(() => {
      if (isKnocking) {
        setIsKnocking(false);
        socket.off("knock_response", responseHandler);
        alert("No response from host.");
      }
    }, 15000);
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8 relative">
      {isKnocking && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex flex-col items-center justify-center">
          <Loader2 size={64} className="text-indigo-500 animate-spin mb-4" />
          <h2 className="text-2xl font-bold">Knocking...</h2>
          <p className="text-gray-400">Waiting for the host to let you in.</p>
          <button
            onClick={() => {
              setIsKnocking(false);
              window.location.reload();
            }}
            className="mt-8 text-sm text-red-400 hover:text-red-300 underline"
          >
            Cancel
          </button>
        </div>
      )}

      <div className="max-w-6xl mx-auto">
        <header className="flex justify-between items-center mb-10">
          <div>
            <h1 className="text-3xl font-bold">Study Rooms</h1>
            <p className="text-gray-400">Join a group and focus together.</p>
          </div>
          <button
            onClick={handleCreateRoom}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 px-4 py-2 rounded-lg transition"
          >
            <Plus size={20} /> Create Room
          </button>
        </header>

        {loading ? (
          <div className="flex justify-center mt-20">
            <Loader2 className="animate-spin text-indigo-500" size={48} />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {rooms.map((room) => {
              const myId = user?._id || user?.id;
              const adminId = room.admin?._id || room.admin;
              const isMine = adminId === myId;
              const isMember = room.members.some((m) => (m._id || m) === myId);
              const showLock = room.isPrivate && !isMine && !isMember;

              return (
                <div
                  key={room._id}
                  onClick={() => handleJoinAttempt(room)}
                  className="bg-gray-800 border border-gray-700 p-6 rounded-xl hover:border-indigo-500 transition cursor-pointer group relative overflow-hidden"
                >
                  {room.isPrivate && (
                    <div className="absolute top-0 right-0 bg-yellow-500/10 text-yellow-500 p-2 rounded-bl-xl">
                      {isMine ? <Unlock size={16} /> : <Lock size={16} />}
                    </div>
                  )}

                  <div className="flex justify-between items-start mb-4">
                    <h3 className="text-xl font-semibold">{room.name}</h3>
                    <span className="bg-green-900 text-green-300 text-xs px-2 py-1 rounded-full">
                      Active
                    </span>
                  </div>
                  <p className="text-gray-400 text-sm mb-4">{room.topic}</p>

                  <div className="flex justify-between items-center mt-4">
                    <div className="flex items-center text-gray-500 text-sm">
                      <Users size={16} className="mr-2" />
                      {room.members.length} Members
                    </div>
                    <span className="text-indigo-400 text-sm font-medium group-hover:underline flex items-center gap-1">
                      {showLock ? "Request to Join" : "Join Now"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default RoomLobby;
