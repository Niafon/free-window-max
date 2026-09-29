import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MaxUI } from '@maxhub/max-ui';
import '@maxhub/max-ui/styles.css';
import './style.css';
import { App } from './App';
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30000 }, mutations: { retry: false } } });
createRoot(document.getElementById('root')!).render(<React.StrictMode><MaxUI colorScheme="light"><QueryClientProvider client={queryClient}><App/></QueryClientProvider></MaxUI></React.StrictMode>);
