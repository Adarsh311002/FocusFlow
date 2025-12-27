import { Room } from "../models/room.models.js";
import redis from "../db/redisClient.js";

const setupSocketEvents = (io) => {
  // const roomUsers = new Map(); // now redis

  io.on("connection", (socket) => {
    console.log(`⚡: Connection established ${socket.id}`);

    socket.on("join_room", async ({ roomId, userId, userName }) => {
      try { 
        const room = await Room.findOne({ roomId });

        if (!room) {
          socket.emit("join_error", { message: "Room not found" });
          return;
        }

        if (room.isPrivate) {
          const isMember = room.members.some(
            (memberId) => memberId.toString() === userId
          );

          const isAdmin = room.admin.toString() === userId;

          if (!isMember && !isAdmin) {
            console.log(
              ` Access Denied: ${userName} tried to enter ${roomId}`
            );
            socket.emit("join_error", {
              message: "This room is Private. You must request to join.",
            });
            return; 
          }
        }

        socket.join(roomId);
        console.log(`${userName} joined room: ${roomId}`);

        const roomKey = `room: ${roomId}`;
        const userData = JSON.stringify({userId,userName});

        await redis.hset(roomKey,socket.id,userData);
        await redis.expire(roomKey,86400);

        const rawUsers = await redis.hgetall(roomKey);
        const currentUsers = Object.values(rawUsers).map((u) => JSON.parse(u));

        socket.emit("existing_users", currentUsers);
        socket.to(roomId).emit("user_joined", { userId, userName });
      } catch (error) {
        console.error("Join Error:", error);
      }
    });

    socket.on("leave_room", async({ roomId, userId, userName }) => {
      socket.leave(roomId);
      console.log(`User ${userName} left room ${roomId}`);

      const roomKey = `room:${roomId}`;

      await redis.hdel(roomKey,socket.id);
      
      socket.to(roomId).emit("user_left", {userName})

    });

    socket.on("disconnecting", async () => {
      const rooms = [...socket.rooms];

      for(const roomId of rooms){
        if(roomId === socket.id) continue;

        const roomKey = `room:${roomId}`;

        const rawUser = await redis.hget(roomKey, socket.id);

        if(rawUser) {
          const { userName } = JSON.parse(rawUser);

          await redis.hdel(roomKey, socket.id);

          io.to(roomId).emit("user_left", {userName});
          console.log(`User ${userName} disconnected from ${roomId}`);
        }

      }
    })

    socket.on("timer_update", ({ roomId, timerState }) => {
      socket.to(roomId).emit("receive_timer_update", timerState);
    });

    socket.on("knock_room", ({ roomId, userId, userName }) => {
      console.log(`${userName} is knocking on ${roomId}`);
      io.to(roomId).emit("receive_knock", { userId, userName });
    });

    socket.on("respond_knock", ({ roomId, userId, action }) => {
      console.log(`Host ${action}ed user ${userId} in ${roomId}`);

      io.emit("knock_response", { userId, action });

      if (action === "approve") {
        addMemberToRoom(roomId, userId);
      }
    });

    socket.on("send_message", ({ roomId, message, userName, userId }) => {
      const messageData = {
        roomId,
        message,
        userName,
        userId,
        time: new Date().toISOString(),
        type: "chat",
      };
      io.to(roomId).emit("receive_message", messageData);
    });

    socket.on("disconnect", async () => {
      console.log("User disconnected");
    });
  });
};

async function addMemberToRoom(roomId, userId) {
  try {
    await Room.findOneAndUpdate({ roomId }, { $addToSet: { members: userId } });
  } catch (e) {
    console.error("Failed to add member to DB", e);
  }
}

export default setupSocketEvents;
