import { vi } from 'vitest'
import { QueryClient } from '../queryClient'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, gcTime: Infinity },
  },
})

export const useQueryClient = vi.fn(() => queryClient)

export const useQueryClientGetter = vi.fn(() => {
  const client = useQueryClient()
  return () => client
})
