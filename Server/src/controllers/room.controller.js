import Room from "../models/room.models.js"
import  {v4 as uuidv4} from "uuid"
import zod, { success } from "zod"

const roomValidation = zod.object({
    name: zod.string().nonempty("Room name is required"),
    topic: zod.string().default("focus ")
})

const createRoom = async(req , res) => {
    try {
        const {name, topic} = req.body;

        const validation = zod.safeParse(req.body);

        if(!validation){
            return res.status(401).json({
                message: "Validation failed!"
            })
        }

        const roomId = uuidv4.slice(0,6).toUpperCase();

        const newRoom = await Room.create({
            name: name,
            topic: topic,
            roomId :  roomId,
            admin: userId,
            members: [userId]
        })

        res.status(200).json({
            success: true,
            room : newRoom
        });   
    } catch (error) {
        console.log('Error creating room',error);
        res.status(500).json({
            success: false,
            message: "Server error"
        })
        
    }   
}

const getRooms = async(req,res) => {
    try {
        const rooms = await Room.find({isActive :true})
        .populate("admin","name email")
        .populate("members", "name")
        .sort({createdAt : -1});

        res.status(200).json({
            success : true,
            rooms
        })
        
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Server Error"
        })
        
    }
}


const joinRoom = async(req,res) => {
   try {
     const {roomId} = req.body;
     const userId = req.user._id;
 
     const room = await Room.findOne({roomId});
     if(!room) return res.status(404).json({message:"Room not found"});
 
     if(!room.members.includes(userId)){
         room.members.push(userId);
         await room.save();
     }
 
     res.status(200).json({
         success: true,
         room
     })
   } catch (error) {
    res.status(500).json({
        success: false,
        message: "Server Error"
    })    
   }
}

export {createRoom, getRooms , joinRoom}



