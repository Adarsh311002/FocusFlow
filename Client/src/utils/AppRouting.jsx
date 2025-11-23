import React from 'react'
import { createBrowserRouter , RouterProvider } from 'react-router-dom'
import SignInOut from '../pages/SignInOut'
import Dashboard from '../pages/Dashboard.jsx';
import ProtectedRoute from '../components/ProtectedRoute';
import { AuthProvider } from '../context/AuthContext.jsx';
import LandingPage from '../pages/LandingPage.jsx';

const AppRouting = () => {

    const appRouter = createBrowserRouter([
      {
        path: "/signup",
        element: <SignInOut />,
      },
      {
        path: "/login",
        element: <SignInOut />,
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
      <AuthProvider>
        <RouterProvider router={appRouter} />
      </AuthProvider>
    );
}

export default AppRouting
