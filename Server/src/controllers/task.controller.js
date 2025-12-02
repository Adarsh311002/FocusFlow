import { Task } from "../models/task.models.js";
import zod from "zod"


const taskValidation = zod.object({
    title : zod.string().nonempty("task name is required"),
    description : zod.string().optional(),
})

const createTasks = async(req , res) => {
    try {
        const {title,description} = req.body;
        
        const validation = taskValidation.safeParse(req.body);
        if(!validation.success){
            return res.status(400).json({
                message: "validation failed",
                error: validation.error.errors
            })
        } 

        const newTask = await Task.create({
            title : title,
            description : description,
            user: req.user.id
        })

        return res.status(201).json({
            message : "task created successfully",
            data: newTask
        })
    } catch (error) {
        res.status(400).json({
            success: false,
            error : "failed to create task" 
        })
    }
}

const getTask = async(req,res) => {
    
   try {
     const data = await Task.find({user: req.user.id}).sort({createdAt : -1});
     res.status(200).json({
         success: true,
         data: data
     })
   } catch (error) {
     res.status(500).json({
        success: false,
        error: "Server failed"  
     })    
   }
}


const updateTask = async(req,res) => {
    try {
        const {id} = req.params; 
        const updates = req.body;

        if(updates.isActive === true){
            await Task.updateMany(
            {
                user: req.user.id, _id : {$ne : id}
            }, {
                $set : {
                    isActive : false
                }
            })
        }

        const updatedTask = await Task.findByIdAndUpdate(
            id,
            {$set : updates},
            {new : true}
        );

        if(!updatedTask) {
            return res.status(401).json({
                message : "Task not found"
            })
        }

        return res.status(200).json({
            success: true,
            message: "task updated successfully"
        })
    } catch (error) {
        return res.status(400).json({
            success: false,
            error: "Server error"
        })
    }

}

const deleteTask = async(req , res) => {
    try {
        const {id} = req.params;

        let findTask = await Task.findById(id);
        if(!findTask){
            return res.status(400).json({
                success: false,
                error: "No task found"
            })
        }

        if(findTask.user.toString() != req.user.id){
            return res.status(401).json({
                success:false,
                message: "Not authorized"
            })
        }

        await findTask.deleteOne();
        res.status(200).json({
            success: true,
            message: "task deleted successfully"
        })
    } catch (error) {
        res.status(500).json({
            success: false,
            error: "Server Error "
        })
    }
}

export {createTasks, updateTask, getTask, deleteTask}