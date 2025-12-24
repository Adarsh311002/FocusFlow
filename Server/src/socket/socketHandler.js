import { Room } from "../models/room.models.js";

const setupSocketEvents = (io) => {
  const roomUsers = new Map();

  io.on("connection", (socket) => {
    console.log(`⚡: Connection established ${socket.id}`);

    socket.on("join_room", ({ roomId, userId, userName }) => {
      socket.join(roomId);
      console.log(`User ${userName} (${userId}) joined room: ${roomId}`);

      if (!roomUsers.has(roomId)) {
        roomUsers.set(roomId, new Set());
      }

      const userEntry = JSON.stringify({ userId, userName });
      roomUsers.get(roomId).add(userEntry);

      const currentUsers = Array.from(roomUsers.get(roomId)).map((u) =>
        JSON.parse(u)
      );

      socket.emit("existing_users", currentUsers);
      socket.to(roomId).emit("user_joined", { userId, userName });

      console.log(
        `User ${userName} joined ${roomId}. Total: ${currentUsers.length}`
      );
    });

    socket.on("leave_room", ({ roomId, userId, userName }) => {
      socket.leave(roomId);
      console.log(`User ${userName} left room ${roomId}`);

      if (roomUsers.has(roomId)) {
        const userEntry = JSON.stringify({ userId, userName });
        roomUsers.get(roomId).delete(userEntry);
      }

      socket.to(roomId).emit("user_left", { userName });
    });

    socket.on("timer_update", ({ roomId, timerState }) => {
      socket.to(roomId).emit("receive_timer_update", timerState);
    });

    socket.on("knock_room",({roomId, userId, userName}) => {
      console.log(`${userName} is knocking on ${roomId}`);
      io.to(roomId).emit("receive_knock", {userId,userName});
    })

    socket.on("respond_knock",({roomId, userId, action}) => {
      //action = "approve" | "reject"
      console.log(`Host ${action}ed user ${userId} in ${roomId}`);
      io.to(roomId).brodcast("knock_response", {userId, action});
    })

    socket.on("send_message", ({roomId, message, userName , userId}) => {
      const messageData = {
        roomId,
        message,
        userName,
        userId,
        time: new Date().toISOString(),
        type: "chat"
      }

      io.to(roomId).emit("receive_message",messageData);
    })

    socket.on("disconnect", () => {
      console.log("🔥: User disconnected");
    });
  });
};

export default setupSocketEvents;
