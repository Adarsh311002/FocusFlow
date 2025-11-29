import zod from "zod"
import { Session } from "../models/session.models.js"

const logValidation = zod.object({
  duration: zod.number().min(1, "Duration must be at least 1 minute"),
  mode: zod.enum(["pomodoro", "short", "long"], {
    errorMap: () => ({
      message: "Mode must be 'pomodoro', 'short', or 'long'",
    }),
  }),
});

const logSession = async (req , res) => {
    try {

        const validation = logValidation.safeParse(req.body);

          if (!validation.success) {
            return res.status(400).json({
              message: "Validation failed",
              error: validation.error.errors,
            });
          }      

          const { duration, mode } = validation.data;
    
        const newSession = await Session.create({
            user: req.user.id,
            duration ,
            mode
        })
    
        res.status(201).json({
            success:true,
            data: newSession
        })
    } catch (error) {
        console.error(error);
        res.status(500).json({success: false, message: 'Server Error'})
    }

}

export {logSession}