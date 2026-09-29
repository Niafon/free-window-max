import { create } from 'zustand';
import type { Candidate, SearchResult } from '../../../packages/contracts/index';
type Screen = 'search' | 'group' | 'about';
export const useAppStore = create<{ screen: Screen; result: SearchResult | null; detail: Candidate | null; sessionId: string | null; setScreen: (screen: Screen) => void; setResult: (result: SearchResult | null) => void; setDetail: (detail: Candidate | null) => void; setSession: (sessionId: string | null) => void }>(set => ({ screen: 'search', result: null, detail: null, sessionId: null, setScreen: screen => set({ screen }), setResult: result => set({ result }), setDetail: detail => set({ detail }), setSession: sessionId => set({ sessionId }) }));
