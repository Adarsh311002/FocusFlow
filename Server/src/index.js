import {app} from "./app.js"
import dotenv from "dotenv";
import connectDB from "./db/db.js";

dotenv.config({
    path : "./.env"
})

const PORT = process.env.PORT || 8001;


connectDB()
.then(() => {
    app.listen(PORT,() => {
        console.log(`Server is running on PORT ${PORT}.`)
    })
})
.catch((err) => {
    console.log("MongoDb connection error",err)
})