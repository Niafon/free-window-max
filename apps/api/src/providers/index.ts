import type { Event, Preferences, Travel, Origin } from '../../../../packages/contracts/index.js';
export interface EventProvider { searchEvents(query: Preferences): Promise<{ events: Event[]; notices: string[] }>; getEvent(id: string): Promise<Event | undefined>; }
export interface RouteProvider { getRoute(origin: Origin, event: Event, departureAt: string, returnAt: string): Promise<Travel>; }
