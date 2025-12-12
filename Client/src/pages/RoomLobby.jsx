import React from "react";
import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { createRoom, fetchRooms, joinRoom } from "../utils/roomService.js";
import { Loader2, Users, Plus } from "lucide-react";

const RoomLobby = () => {
  const [rooms, setRooms] = useState([]);

  const [loading, setLoading] = useState(true);
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const getRooms = async () => {
      try {
        const data = await fetchRooms();
        setRooms(data);
      } catch (error) {
        console.log("failed to fetch rooms", error);
      } finally {
        setLoading(false);
      }
    };
    getRooms();
  }, []);

  const handleCreateRoom = async () => {
    const roomName = prompt("Enter room name");
    if (!roomName) return;

    try {
      const data = await createRoom({
        name: roomName,
        topic: "Focus session",
      });

      if (data.success) {
        navigate(`/room/${data.room.roomId}`);
      }
    } catch (error) {
      console.error("error creating room: ", error);
      alert("Failed to create room. Please try again");
    }
  };

  const handleJoinRoom = async (roomId) => {
    try {
      await joinRoom(roomId);
      navigate(`/room/${roomId}`);
    } catch (error) {
      console.error("Error joining room", error);
      alert("Failed to joined room.");
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
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
            {rooms.map((room) => (
              <div
                key={room._id}
                className="bg-gray-800 border border-gray-700 p-6 rounded-xl hover:border-indigo-500 transition cursor-pointer"
                onClick={() => handleJoinRoom(room.roomId)}
              >
                <div className="flex justify-between items-start mb-4">
                  <h3 className="text-xl font-semibold">{room.name}</h3>
                  <span className="bg-green-900 text-green-300 text-xs px-2 py-1 rounded-full">
                    Active
                  </span>
                </div>
                <p className="text-gray-400 text-sm mb-4">{room.topic}</p>
                <div className="flex items-center text-gray-500 text-sm">
                  <Users size={16} className="mr-2" />
                  {room.members.length} Members
                </div>
              </div>
            ))}

            {rooms.length === 0 && (
              <div className="col-span-full text-center py-20 text-gray-500">
                No active rooms found. Be the first to start one!
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default RoomLobby;
