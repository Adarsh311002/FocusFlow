import mongoose, { Schema } from "mongoose";

const roomSchema = new Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  roomId: {
    type: String,
    required: true,
    unique: true,
  },
  admin: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  members: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  ],
  topic : {
    type: String,
    default: "General focus"
  },
  isActive : {
    type: Boolean,
    default: true,
  },
  isPrivate : {
    type: Boolean,
    default : false
  }
},
{timestamps: true}
);


export const Room = mongoose.model("Room",roomSchema);

