import { createContext, useContext, useSyncExternalStore } from 'react'
import { routerStore, type RouteLocation } from './router'

/** The current in-memory route. */
export function useRouteLocation(): RouteLocation {
  return useSyncExternalStore(routerStore.subscribe, routerStore.get, routerStore.get)
}

/** Params of the matched dynamic route (`/claims/:id` → `{ id }`). */
export const RouteParamsContext = createContext<Record<string, string>>({})

export function useRouteParams(): Record<string, string> {
  return useContext(RouteParamsContext)
}
