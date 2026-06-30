import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "./App";
import { ToastProvider } from "./components/Toast";
import { CapabilityProvider } from "./lib/CapabilityContext";
import "./i18n";
import "./styles/tokens.css";
import "./styles/base.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <CapabilityProvider>
          <App />
        </CapabilityProvider>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
