import mongoose,{Schema} from "mongoose"

const taskSchema = new Schema({

    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref:"User",
        required: true
    },

    title : {
        type: String,
        required : [true,"please add task title"],
        trim : true,
        maxLength : [200,"Title cannot exceed 200 characters"]
    },

    description : {
        type: String,
        trim: true,
        maxLength: [1000,"Description cannot exceed 1000 words"]
    },

    isCompleted : {
        type : Boolean,
        default : false,
    },

    isActive : {
        type : Boolean,
        default : false
    },

    createdAt : {
        type: Date,
        default : Date.now
    }

})

export const Task = mongoose.model("Task",taskSchema)


