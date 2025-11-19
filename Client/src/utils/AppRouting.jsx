import React from 'react'
import { createBrowserRouter , RouterProvider } from 'react-router-dom'
import SignInOut from '../pages/SignInOut'
import Dashboard from '../pages/Dashboard.jsx';
import ProtectedRoute from '../components/ProtectedRoute';

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

    return(
        <>
        <RouterProvider router={appRouter} />
        </>
    )
}

export default AppRouting
