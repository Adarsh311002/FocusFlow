import {app} from "./app.js"
import dotenv from "dotenv";
import connectDB from "./db/db.js";
import http from "http";
import {Server} from "socket.io"
import setupSocketEvents from "./socket/socketHandler.js";

dotenv.config({
    path : "./.env"
})

const PORT = process.env.PORT || 8001;

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      process.env.CORS_ORIGIN,
    ],
    credentials: true,
    methods : ["GET","POST"]
  },
});

setupSocketEvents(io);

connectDB()
.then(() => {
   
    io.on("connection", (socket) => {
        console.log(`User connected : ${socket.id}`);

        socket.on("disconnect", () => {
            console.log("User disconnected");
        })
    })

    server.listen(PORT, () => {
        console.log(`Server is running on PORT ${PORT}`)
    })
})
.catch((err) => {
    console.log("MongoDb connection error",err)
})

export {io};