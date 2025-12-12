import Room from "../models/room.models.js";

const setupSocketEvents = (io) => {
    io.on("coonection",(socket) => {
        console.log(`connection established ${socket.id}`);

        //join rom evnt
        socket.on("join_room", async({ roomId, userId, userName}) => {

            socket.join(roomId);
            console.log(`User ${userName} (${userId}) joined room: ${roomId}`);
            
            //other notified
            socket.to(roomId).emit("user_joined",{
                userId,
                userName,
                message: `${userName} has joined focus room`
            })
        });
          //syncing timer
        socket.on("timer_update", ({roomId, timerState}) => {
            socket.to(roomId).emit("receive timer update", timerState);
        });
        
        socket.on("disconnect", () => {

        })
    })
}

export default setupSocketEvents;