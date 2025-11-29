import api from "./api.js"

const logCompletedSession = async (sessionData) => {
    try {
        const response = await api.post("/sessions/log",sessionData);
        return response.data;
    } catch (error) {
        throw error;
        
    }
}

export default logCompletedSession; 