import zod from "zod"
import { Session } from "../models/session.models.js"

const logValidation = zod.object({
    duration: zod.number(),
    mode: zod.string().nonempty("mode is required")
})

const logSession = async (req , res) => {
    try {
        const {duration, mode} = req.body;

        const validation = logValidation.safeParse(req.body);

          if (!validation) {
            return res.status(400).json({
              message: "Validation failed",
              error: validateUser.error.errors,
            });
          }      
    
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