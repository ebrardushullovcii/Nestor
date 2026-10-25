import { RouterProvider } from 'react-router-dom'
import { ToastProvider } from '../components/ui/toast'
import { appRouter } from './router'

export function AppProviders() {
  return (
    <ToastProvider>
      <RouterProvider router={appRouter} />
    </ToastProvider>
  )
}
