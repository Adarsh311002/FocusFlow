import api from "./api";

const getTask = async () => {
try {
        const res = await api.get("/tasks/");
        return res.data.data;
} catch (error) {
     throw(error);
}
}

const createTask = async (taskData) => {
    try {
        const res = await api.post("/tasks/addTask",taskData);
        return res.data.data;
    } catch (error) {
        throw error;        
    }
}

const updateTask = async (id,updates) => {
    try {
        const res = await api.patch(`/tasks/updateTask/${id}`,updates);
        return res.data.data;
    } catch (error) {
        throw error;
    }
}

const deleteTask = async (id) => {
    try {
        const res = await api.delete(`/tasks/deleteTask/${id}`);
        return res.data;
    } catch (error) {
        throw error;
    }

}

export {getTask,createTask,updateTask,deleteTask};