import React from 'react'
import { createBrowserRouter , RouterProvider } from 'react-router-dom'
import SignInOut from '../pages/SignInOut'
import Dashboard from '../pages/Dashboard';

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
        element: <Dashboard />,
      },
    ]);

    return(
        <>
        <RouterProvider router={appRouter} />
        </>
    )
}

export default AppRouting
