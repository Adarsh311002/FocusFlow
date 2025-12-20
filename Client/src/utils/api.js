import axios from "axios";


 const api = axios.create({
  baseURL: "http://localhost:8001/api/v1/",
  withCredentials: true,
});


//request interceptors
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem("accessToken");
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

//response interceptors(is like middeware) for handling token expiries

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response.status === 401 && !originalRequest._retry) {
        originalRequest._retry = true;

     try {
       const currentRefreshToken = localStorage.getItem("refreshToken");

       if (!currentRefreshToken) {
         throw new Error("No refresh token available");
       }

       const response = await axios.post(
         "http://localhost:8001/api/v1/users/refresh",
         { refreshToken: currentRefreshToken },
         { withCredentials: true }
       );

       const { accessToken } =  response.data;
       localStorage.setItem("accessToken", accessToken);

       api.defaults.headers.common[
         "Authorization"
       ] = `Bearer ${accessToken}`;
       originalRequest.headers["Authorization"] = `Bearer ${accessToken}`;

       return api(originalRequest);
     } catch (refreshError) {
       console.log("Session expired. Please login again.");
       localStorage.clear();
       window.location.href = "/login";
     }
    }

    return Promise.reject(error);
  }
);
 export default api;