import mongoose,{Schema} from 'mongoose'

const sessionSchema = new Schema({
    user : {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    duration : {
        type: Number,
        required: true,
    },
    mode : {
        type: String,
        enum: ['pomodoro','short','long'],
        default:'pomodoro'
    },
    completedAt: {
        type: Date,
        default: Date.now
    }
})

export const Session = mongoose.model('Session',sessionSchema);
