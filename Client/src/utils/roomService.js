import api from "./api.js";

const fetchRooms = async () => {
  try {
    const res = await api.get("/rooms/");
    return res.data.data;
  } catch (error) {
    throw error;
  }
};

const createRoom = async (roomData) => {
  try {
    const res = await api.post("/rooms/create", roomData);
    return res.data;
  } catch (error) {
    throw error;
  }
};

const joinRoom = async (roomId) => {
  try {
    const res = await api.post("/rooms/join", roomId);
    return res.data;
  } catch (error) {
    throw error;
  }
};

export { fetchRooms, createRoom, joinRoom };
