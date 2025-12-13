import React from 'react'
import { createBrowserRouter , RouterProvider } from 'react-router-dom'
import SignInOut from '../pages/SignInOut'
import Dashboard from '../pages/Dashboard.jsx';
import ProtectedRoute from '../components/ProtectedRoute';
import { AuthProvider } from '../context/AuthContext.jsx';
import LandingPage from '../pages/LandingPage.jsx';
import PomodoroTimer from '../components/PomodoroTimer.jsx';
import {GoogleOAuthProvider} from "@react-oauth/google"
import { SocketProvider } from '../context/SocketContext.jsx';
import RoomLobby from '../pages/RoomLobby.jsx';

const AppRouting = () => {

    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;

    const appRouter = createBrowserRouter([
      {
        path: "/",
        element: <LandingPage />,
      },
      {
        path: "/timer",
        element: <PomodoroTimer />,
      },
      {
        path: "/signup",
        element: <SignInOut />,
      },
      {
        path: "/login",
        element: <SignInOut />,
      },
      {
        path: "/room",
        element: <RoomLobby />,
      },
      {
        path: "/dashboard",
        element: (
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        ),
      },
    ]);

    return (
      <GoogleOAuthProvider clientId={clientId}>
        <AuthProvider>
          <SocketProvider>
            <RouterProvider router={appRouter} />
          </SocketProvider>
        </AuthProvider>
      </GoogleOAuthProvider>
    );
}

export default AppRouting
