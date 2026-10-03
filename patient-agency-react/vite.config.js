import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' lets the built app run from any sub-path (e.g. GitHub Pages /<repo>/)
export default defineConfig({
  plugins: [react()],
  base: './',
  // Development-only loopback proxy; secure:false accepts this app's self-signed
  // local certificate, never a remote Epic or ClinicalTrials.gov certificate.
  server: { port: 5173, proxy: { '/api/trials': { target: 'https://127.0.0.1:3000', secure: false } } }
});
